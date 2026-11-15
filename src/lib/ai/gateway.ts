import type { AiVerdictBody } from "@/lib/ai/types";
import {
  chatCompletionsUrl,
  gatewayConfigured,
  isUnsupportedModelError,
  MODEL_CALL_MIN_MS,
  MODEL_CALL_TIMEOUT_MS,
  modelChain,
  parseVerdictText,
  type VerdictConfig,
} from "@/lib/ai/verdict-logic";

export type ModelUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
};

export type VerdictCall =
  | { ok: true; verdict: AiVerdictBody; model: string; usage: ModelUsage }
  | { ok: false; reason: "missing_env" | "model_error" | "invalid_json" | "model_unsupported"; model: string | null };

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "error";
  return message.replace(/bearer\s+\S+/gi, "bearer [redacted]").replace(/[A-Za-z0-9_-]{30,}/g, "[redacted]").slice(0, 180);
}

/** Per-attempt model timeout, capped at 15s and by any remaining deadline. */
export function modelCallTimeoutMs(timeoutMs: number, deadlineMs?: number, now = Date.now()): number | null {
  const cap = Math.min(Math.max(0, timeoutMs), MODEL_CALL_TIMEOUT_MS);
  if (cap <= 0) return null;
  if (deadlineMs == null) return cap;
  const left = deadlineMs - now;
  if (left < MODEL_CALL_MIN_MS) return null;
  return Math.min(cap, left);
}

function readContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
      return "";
    })
    .join("");
}

export function readUsage(body: unknown): ModelUsage {
  if (!body || typeof body !== "object") return { promptTokens: null, completionTokens: null, costUsd: null };
  const record = body as Record<string, unknown>;
  const usage = record.usage && typeof record.usage === "object" ? (record.usage as Record<string, unknown>) : {};
  const number = (value: unknown): number | null => {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    promptTokens: number(usage.prompt_tokens ?? usage.input_tokens),
    completionTokens: number(usage.completion_tokens ?? usage.output_tokens),
    costUsd: number(usage.cost ?? usage.total_cost ?? record.cost),
  };
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (record.error && typeof record.error === "object") {
      const message = (record.error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    if (typeof record.message === "string") return record.message;
  }
  return `http ${status}`;
}

async function completeOnce(
  config: VerdictConfig,
  model: string,
  messages: ChatMessage[],
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ content: string; usage: ModelUsage } | { unsupported: true; message: string } | { failed: true; message: string }> {
  const url = chatCompletionsUrl(config.gatewayUrl ?? "");
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey ?? ""}`,
        "Lovable-API-Key": config.apiKey ?? "",
        "X-Lovable-AIG-SDK": "vercel-ai-sdk",
      },
      body: JSON.stringify({ model, temperature: 0.2, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const message = errorMessage(json, response.status);
      if (isUnsupportedModelError(message) || isUnsupportedModelError(text.slice(0, 300))) {
        return { unsupported: true, message };
      }
      return { failed: true, message: `http ${response.status}` };
    }
    const choice = (json as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
    return { content: readContent(choice), usage: readUsage(json) };
  } catch (error) {
    return { failed: true, message: safeError(error) };
  }
}

export async function requestVerdict(
  config: VerdictConfig,
  messages: { role: "system" | "user"; content: string }[],
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; deadlineMs?: number } = {},
): Promise<VerdictCall> {
  if (!gatewayConfigured(config)) return { ok: false, reason: "missing_env", model: null };
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? MODEL_CALL_TIMEOUT_MS;
  const chain = modelChain(config.model);
  let sawUnsupported = false;
  for (const model of chain) {
    const firstTimeout = modelCallTimeoutMs(timeoutMs, options.deadlineMs);
    if (firstTimeout == null) return { ok: false, reason: "model_error", model };
    const first = await completeOnce(config, model, messages, fetchImpl, firstTimeout);
    if ("unsupported" in first) {
      sawUnsupported = true;
      console.warn(`[keel] ai verdict model unsupported ${model.split("/").pop() ?? "model"}`);
      continue;
    }
    if ("failed" in first) {
      console.warn(`[keel] ai verdict model error ${first.message}`);
      return { ok: false, reason: "model_error", model };
    }
    const parsed = parseVerdictText(first.content);
    if (parsed.ok) return { ok: true, verdict: parsed.value, model, usage: first.usage };
    const retryTimeout = modelCallTimeoutMs(timeoutMs, options.deadlineMs);
    if (retryTimeout == null) return { ok: false, reason: "invalid_json", model };
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: first.content.slice(0, 2000) },
      { role: "user", content: `That was not valid. Validation: ${parsed.error}. Return only the JSON object.` },
    ];
    const second = await completeOnce(config, model, retryMessages, fetchImpl, retryTimeout);
    if ("unsupported" in second) {
      sawUnsupported = true;
      continue;
    }
    if ("failed" in second) {
      console.warn(`[keel] ai verdict retry error ${second.message}`);
      return { ok: false, reason: "model_error", model };
    }
    const again = parseVerdictText(second.content);
    if (again.ok) return { ok: true, verdict: again.value, model, usage: second.usage };
    return { ok: false, reason: "invalid_json", model };
  }
  return { ok: false, reason: sawUnsupported ? "model_unsupported" : "model_error", model: null };
}
