"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PairDisplay } from "@/lib/market";

function recordsEqual(a: Record<string, PairDisplay>, b: Record<string, PairDisplay>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!b[k]) return false;
    if (a[k].volH1 !== b[k].volH1 || a[k].volH6 !== b[k].volH6 || a[k].volH24 !== b[k].volH24) return false;
  }
  return true;
}

export function usePairDisplays(mints: string[], enabled = true) {
  const key = useMemo(() => [...new Set(mints)].filter(Boolean).sort().join(","), [mints]);
  const [displays, setDisplays] = useState<Record<string, PairDisplay>>({});
  const inFlightRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled || !key) return;
    const list = key.split(",");

    async function run() {
      if (inFlightRef.current) return;

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;
      inFlightRef.current = true;

      const merged: Record<string, PairDisplay> = {};
      try {
        for (let index = 0; index < list.length; index += 30) {
          if (controller.signal.aborted) break;
          const chunk = list.slice(index, index + 30);
          try {
            const response = await fetch(`/api/tokens/display?mints=${encodeURIComponent(chunk.join(","))}`, {
              cache: "no-store",
              signal: controller.signal,
            });
            if (!response.ok || controller.signal.aborted) continue;
            const body = (await response.json()) as { displays?: Record<string, PairDisplay> };
            Object.assign(merged, body.displays ?? {});
          } catch {
            // A missed window stays blank. Stored 1h volume still renders.
          }
        }
        if (!controller.signal.aborted && Object.keys(merged).length > 0) {
          setDisplays((current) => {
            const next = { ...current, ...merged };
            return recordsEqual(current, next) ? current : next;
          });
        }
      } finally {
        if (!controller.signal.aborted) {
          inFlightRef.current = false;
        }
      }
    }

    const kick = window.setTimeout(() => void run(), 350);
    const timer = window.setInterval(() => void run(), 60_000);

    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      inFlightRef.current = false;
    };
  }, [enabled, key]);

  return displays;
}
