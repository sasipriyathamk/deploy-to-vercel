"use client";
import { useCallback, useEffect, useState } from "react";
import { cachedPoll, pollJson } from "@/lib/polling";
export const KEEL_REFRESH_EVENT = "keel:refresh";
export function requestKeelRefresh() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(KEEL_REFRESH_EVENT));
}
export function usePoll<T>(url: string, ms: number, enabled = true) {
  const [state, setState] = useState<{ url: string; data: T | null; error: string | null }>({ url, data: null, error: null });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(async () => { setRevision(value => value + 1); }, []);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    async function load() {
      if (document.visibilityState === "hidden" || !navigator.onLine) return;
      try {
        const data = await pollJson<T>(url);
        if (!disposed) setState(previous => previous.url === url && previous.error === null && JSON.stringify(previous.data) === JSON.stringify(data) ? previous : { url, data, error: null });
      } catch (error) {
        if (!disposed) setState(previous => ({ url, data: previous.url === url ? previous.data : cachedPoll<T>(url), error: error instanceof Error ? error.message : "Request failed" }));
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), ms);
    const refresh = () => void load();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener(KEEL_REFRESH_EVENT, refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(KEEL_REFRESH_EVENT, refresh);
    };
  }, [url, ms, enabled, revision]);
  const data = state.url === url ? state.data : null;
  const error = state.url === url ? state.error : null;
  return { data, error, loading: enabled && data == null && error == null, reload };
}
