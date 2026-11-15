import { describe, expect, it } from "vitest";
import { applyRevive, stampEntry } from "@/lib/logic/gains";

describe("entry immutability", () => {
  it("stamps entry once and ignores a later price", () => {
    const first = stampEntry(
      { entryAt: null, entryPriceUsd: null, entryMcapUsd: null },
      { at: new Date("2026-11-09T12:00:00Z"), priceUsd: 0.01, mcapUsd: 12_000 },
    );
    const second = stampEntry(first, {
      at: new Date("2026-11-09T13:00:00Z"),
      priceUsd: 0.5,
      mcapUsd: 90_000,
    });
    expect(second).toEqual(first);
    expect(second.entryPriceUsd).toBe(0.01);
    expect(second.entryAt?.toISOString()).toBe("2026-11-09T12:00:00.000Z");
  });

  it("does not backfill a null entry price after the stamp", () => {
    const stamped = stampEntry(
      { entryAt: null, entryPriceUsd: null, entryMcapUsd: null },
      { at: new Date("2026-11-09T12:00:00Z"), priceUsd: null, mcapUsd: 4_000 },
    );
    const later = stampEntry(stamped, {
      at: new Date("2026-11-09T12:05:00Z"),
      priceUsd: 0.02,
      mcapUsd: 8_000,
    });
    expect(later.entryAt).toEqual(stamped.entryAt);
    expect(later.entryPriceUsd).toBeNull();
    expect(later.entryMcapUsd).toBe(4_000);
  });

  it("revive keeps the original entry", () => {
    const row = applyRevive(
      {
        status: "archived",
        reviveCount: 1,
        revivedAt: null,
        entryAt: new Date("2026-11-01T00:00:00Z"),
        entryPriceUsd: 0.004,
        entryMcapUsd: 8_000,
      },
      new Date("2026-11-09T00:00:00Z"),
    );
    expect(row.status).toBe("watching");
    expect(row.reviveCount).toBe(2);
    expect(row.entryPriceUsd).toBe(0.004);
    expect(row.entryAt?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});
