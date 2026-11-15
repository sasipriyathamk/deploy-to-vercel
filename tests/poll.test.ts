import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

export const KEEL_REFRESH_EVENT = "keel:refresh";

/**
 * Test polling orchestration logic directly in node environment:
 * verifies overlap prevention, deep payload equality checks, abort signals, and manual reload.
 */
class PollController<T> {
  data: T | null = null;
  error: string | null = null;
  loading = true;
  inFlight = false;
  abortController: AbortController | null = null;
  timer: NodeJS.Timeout | null = null;

  constructor(public url: string, public ms: number) {}

  start() {
    void this.load(false);
    this.timer = setInterval(() => void this.load(false), this.ms);
  }

  async load(isManual = false) {
    if (this.inFlight && !isManual) return;
    if (this.abortController) this.abortController.abort();
    const controller = new AbortController();
    this.abortController = controller;
    this.inFlight = true;

    try {
      const response = await fetch(this.url, { cache: "no-store", signal: controller.signal });
      const body = (await response.json()) as T & { error?: string };
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(body.error || "Request failed");

      if (JSON.stringify(this.data) !== JSON.stringify(body)) {
        this.data = body;
      }
      this.error = null;
    } catch (err) {
      if (controller.signal.aborted) return;
      this.error = err instanceof Error ? err.message : "Request failed";
    } finally {
      if (!controller.signal.aborted) {
        this.inFlight = false;
        this.loading = false;
      }
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.abortController) this.abortController.abort();
    this.inFlight = false;
  }
}

describe("Polling controller lifecycle and optimization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prevents overlapping network requests when call is in-flight", async () => {
    let callCount = 0;
    let resolveCall: (val: unknown) => void = () => {};

    const mockFetch = vi.fn().mockImplementation(() => {
      callCount += 1;
      return new Promise((resolve) => {
        resolveCall = () =>
          resolve({
            ok: true,
            json: async () => ({ count: callCount }),
          });
      });
    });

    global.fetch = mockFetch;

    const controller = new PollController<{ count: number }>("/api/test", 1000);
    controller.start();

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Fast forward past the 1000ms interval while call is still pending
    vi.advanceTimersByTime(1500);

    // In-flight guard prevents duplicate request
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Resolve initial call
    resolveCall(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.data).toEqual({ count: 1 });

    // Next timer fires after resolution
    vi.advanceTimersByTime(1000);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    controller.stop();
  });

  it("avoids updating object reference when payload is unchanged", async () => {
    const payload = { items: ["a", "b"] };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...payload }),
    });

    const controller = new PollController<{ items: string[] }>("/api/test", 1000);
    controller.start();

    await Promise.resolve();
    await Promise.resolve();
    const firstRef = controller.data;
    expect(firstRef).toEqual(payload);

    // Trigger next interval with identical content
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.data).toBe(firstRef);
    controller.stop();
  });

  it("aborts in-flight request when stopped / unmounted", () => {
    let capturedSignal: AbortSignal | null = null;
    global.fetch = vi.fn().mockImplementation((_, init: RequestInit) => {
      capturedSignal = (init?.signal as AbortSignal) ?? null;
      return new Promise(() => {});
    });

    const controller = new PollController("/api/test", 1000);
    controller.start();

    expect(capturedSignal).not.toBeNull();
    expect((capturedSignal as unknown as AbortSignal).aborted).toBe(false);

    controller.stop();
    expect((capturedSignal as unknown as AbortSignal).aborted).toBe(true);
  });

  it("supports manual reload and recovers after transient error", async () => {
    let succeed = false;
    global.fetch = vi.fn().mockImplementation(() => {
      if (!succeed) {
        return Promise.resolve({
          ok: false,
          json: async () => ({ error: "Server down" }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true }),
      });
    });

    const controller = new PollController<{ ok: boolean }>("/api/test", 5000);
    controller.start();

    await Promise.resolve();
    await Promise.resolve();
    expect(controller.error).toBe("Server down");
    expect(controller.data).toBeNull();

    // Now reload manually when service recovers
    succeed = true;
    await controller.load(true);

    expect(controller.error).toBeNull();
    expect(controller.data).toEqual({ ok: true });
    controller.stop();
  });
});
