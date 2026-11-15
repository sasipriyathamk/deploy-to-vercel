import { afterEach, describe, expect, it, vi } from "vitest";
import { SEARCH_DEBOUNCE_MS, createSearchScheduler } from "@/lib/logic/debounce";

describe("debounced search", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits 400ms and cancels the in-flight request when the query changes", () => {
    expect(SEARCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(300);
    expect(SEARCH_DEBOUNCE_MS).toBeLessThanOrEqual(500);
    vi.useFakeTimers();
    const scheduler = createSearchScheduler();
    const signals: AbortSignal[] = [];
    scheduler.schedule((signal) => signals.push(signal));
    vi.advanceTimersByTime(399);
    expect(signals).toHaveLength(0);
    scheduler.schedule((signal) => signals.push(signal));
    vi.advanceTimersByTime(400);
    expect(signals).toHaveLength(1);
    const first = signals[0]!;
    scheduler.schedule((signal) => signals.push(signal));
    expect(first.aborted).toBe(true);
    vi.advanceTimersByTime(400);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
  });
});
