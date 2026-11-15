import { describe, expect, it } from "vitest";
import {
  buildConfidence,
  capRegime,
  compareCandidates,
  isClearDeadMarket,
  isWeakTick,
  publishReading,
  reviewCandidate,
  smoothReading,
  stampCheckpoint,
} from "@/lib/logic/confidence";
import { entryFromFirstAlert, performanceAnchor, resolveGain, stampFirstAlert, updateAth } from "@/lib/logic/gains";

const now = new Date("2026-11-09T12:00:00Z");
const alertAt = new Date("2026-11-09T11:00:00Z");

describe("first alert immutability", () => {
  it("stamps price, mcap, and time once", () => {
    const first = stampFirstAlert(
      { firstAlertAt: null, firstAlertPriceUsd: null, firstAlertMcapUsd: null },
      { at: alertAt, priceUsd: 0.004, mcapUsd: 404_000 },
    );
    const recheck = stampFirstAlert(first, { at: now, priceUsd: 0.2, mcapUsd: 9_000_000 });
    const archived = stampFirstAlert(recheck, { at: new Date("2026-11-10T00:00:00Z"), priceUsd: 0.001, mcapUsd: 1_000 });
    expect(archived).toEqual(first);
    expect(archived.firstAlertPriceUsd).toBe(0.004);
    expect(archived.firstAlertMcapUsd).toBe(404_000);
    expect(archived.firstAlertAt?.toISOString()).toBe(alertAt.toISOString());
  });

  it("does not backfill a null alert price on a later quote", () => {
    const stamped = stampFirstAlert(
      { firstAlertAt: null, firstAlertPriceUsd: null, firstAlertMcapUsd: null },
      { at: alertAt, priceUsd: null, mcapUsd: 12_000 },
    );
    const later = stampFirstAlert(stamped, { at: now, priceUsd: 0.02, mcapUsd: 40_000 });
    expect(later.firstAlertAt).toEqual(stamped.firstAlertAt);
    expect(later.firstAlertPriceUsd).toBeNull();
    expect(later.firstAlertMcapUsd).toBe(12_000);
  });
});

describe("watching entry copy", () => {
  it("copies first alert only when watching entry is empty", () => {
    const copied = entryFromFirstAlert({
      entryAt: null,
      entryPriceUsd: null,
      entryMcapUsd: null,
      firstAlertAt: alertAt,
      firstAlertPriceUsd: 0.004,
      firstAlertMcapUsd: 404_000,
    });
    expect(copied).toEqual({
      entryAt: alertAt,
      entryPriceUsd: 0.004,
      entryMcapUsd: 404_000,
    });
  });

  it("does not reset an entry that is already set", () => {
    const kept = entryFromFirstAlert({
      entryAt: now,
      entryPriceUsd: 0.2,
      entryMcapUsd: 1_200_000,
      firstAlertAt: alertAt,
      firstAlertPriceUsd: 0.004,
      firstAlertMcapUsd: 404_000,
    });
    expect(kept.entryAt).toEqual(now);
    expect(kept.entryPriceUsd).toBe(0.2);
    expect(kept.entryMcapUsd).toBe(1_200_000);
  });

  it("does not invent an entry for a token that never became a candidate", () => {
    const empty = entryFromFirstAlert({
      entryAt: null,
      entryPriceUsd: null,
      entryMcapUsd: null,
      firstAlertAt: null,
      firstAlertPriceUsd: null,
      firstAlertMcapUsd: null,
    });
    expect(empty).toEqual({ entryAt: null, entryPriceUsd: null, entryMcapUsd: null });
    expect(
      performanceAnchor({
        ...empty,
        firstAlertAt: null,
        firstAlertPriceUsd: null,
        firstAlertMcapUsd: null,
      }),
    ).toBeNull();
  });
});

describe("gains versus first alert", () => {
  it("measures a candidate from the first-alert stamp when watching entry is empty", () => {
    const anchor = performanceAnchor({
      entryAt: null,
      entryPriceUsd: null,
      entryMcapUsd: null,
      firstAlertAt: alertAt,
      firstAlertPriceUsd: 0.01,
      firstAlertMcapUsd: 404_000,
    });
    expect(anchor?.at).toEqual(alertAt);
    expect(
      resolveGain({
        lastPrice: 0.015,
        entryPrice: anchor?.priceUsd ?? null,
        lastMcap: 600_000,
        entryMcap: anchor?.mcapUsd ?? null,
      }),
    ).toEqual({ gainPct: 50, basis: "price" });

    const ath = updateAth({
      entryAt: anchor!.at,
      entryPriceUsd: anchor!.priceUsd,
      entryMcapUsd: anchor!.mcapUsd,
      athPriceUsd: null,
      athMcapUsd: null,
      athAt: null,
      priceUsd: 0.04,
      mcapUsd: 1_600_000,
      observedAt: now,
    });
    expect(ath.athGainPct).toBe(300);
    expect(ath.athPriceUsd).toBe(0.04);
  });

  it("leaves gain unset when there is no first alert and no watching entry", () => {
    expect(
      performanceAnchor({
        entryAt: null,
        entryPriceUsd: null,
        entryMcapUsd: null,
        firstAlertAt: null,
        firstAlertPriceUsd: null,
        firstAlertMcapUsd: null,
      }),
    ).toBeNull();
    expect(resolveGain({ lastPrice: 1, entryPrice: null, lastMcap: 10, entryMcap: null })).toEqual({
      gainPct: null,
      basis: null,
    });
  });
});

describe("candidate hysteresis", () => {
  const timed = { archive: false as const };

  it("does not demote a candidate on one weak or lifeless tick", () => {
    expect(isWeakTick({ liqUsd: null, volH1: null, buysM5: null, buysH1: null })).toBe(false);
    expect(isWeakTick({ liqUsd: 100, volH1: 40, buysM5: 0, buysH1: 0 })).toBe(true);
    const once = reviewCandidate({
      weakRechecks: 0,
      weak: true,
      clearDead: false,
      lifeless: true,
      timedArchive: timed,
      allowDemote: true,
    });
    expect(once).toEqual({ demote: false, reason: null, weakRechecks: 1 });
  });

  it("demotes after a second consecutive weak recheck, and a healthy tick resets the count", () => {
    const twice = reviewCandidate({
      weakRechecks: 1,
      weak: true,
      clearDead: false,
      lifeless: true,
      timedArchive: timed,
      allowDemote: true,
    });
    expect(twice.demote).toBe(true);
    expect(twice.reason).toBe("stale_1h");
    expect(twice.weakRechecks).toBe(2);

    const reset = reviewCandidate({
      weakRechecks: 1,
      weak: false,
      clearDead: false,
      lifeless: false,
      timedArchive: timed,
      allowDemote: true,
    });
    expect(reset).toEqual({ demote: false, reason: null, weakRechecks: 0 });
  });

  it("archives immediately on clear dead-market evidence", () => {
    expect(
      isClearDeadMarket({
        priceUsd: null,
        mcapUsd: null,
        anchorPriceUsd: 0.01,
        anchorMcapUsd: 400_000,
        buysM5: null,
        sellsM5: null,
      }),
    ).toBe(false);
    expect(
      isClearDeadMarket({
        priceUsd: 0.0004,
        mcapUsd: 16_000,
        anchorPriceUsd: 0.01,
        anchorMcapUsd: 400_000,
        buysM5: 0,
        sellsM5: 4,
      }),
    ).toBe(true);
    const dead = reviewCandidate({
      weakRechecks: 0,
      weak: true,
      clearDead: true,
      lifeless: false,
      timedArchive: timed,
      allowDemote: false,
    });
    expect(dead.demote).toBe(true);
    expect(dead.reason).toBe("dead_market");
  });

  it("holds a large score swing until the next tick agrees", () => {
    const first = publishReading({ established: false, current: 50, pending: null, next: 78 });
    expect(first).toEqual({ value: 78, pending: null });
    const dip = smoothReading(78, null, 60);
    expect(dip).toEqual({ value: 78, pending: 60 });
    const confirmed = smoothReading(78, 60, 58);
    expect(confirmed).toEqual({ value: 58, pending: null });
    const reverted = smoothReading(78, 60, 76);
    expect(reverted).toEqual({ value: 76, pending: null });
  });
});

describe("confidence and cap regime", () => {
  it("keeps unknown safety neutral and tags cap regimes", () => {
    const unknown = buildConfidence({
      now,
      firstAlertAt: null,
      lastPriceUsd: null,
      lastMcapUsd: null,
      firstAlertPriceUsd: null,
      firstAlertMcapUsd: null,
      athPriceUsd: null,
      athMcapUsd: null,
      liqUsd: null,
      volM5: null,
      volH1: null,
      t5VolM5: null,
      topHolderPct: null,
      mintRevoked: null,
      freezeRevoked: null,
      rugcheckNormalised: null,
      alertPath: null,
    });
    expect(unknown.confidence).toBe(50);
    expect(unknown.regime).toBeNull();
    expect(unknown.reasons).toContain("RugCheck unknown");
    expect(unknown.sinceAlertGainPct).toBeNull();

    expect(capRegime(404_000)).toBe("fresh");
    expect(capRegime(1_200_000)).toBe("mid");
    expect(capRegime(9_200_000)).toBe("extended");
    expect(capRegime(null)).toBeNull();
  });

  it("lowers confidence when the path since first alert dumped, and says why", () => {
    const base = {
      now,
      firstAlertAt: alertAt,
      lastMcapUsd: 404_000,
      firstAlertPriceUsd: 0.01,
      firstAlertMcapUsd: 404_000,
      liqUsd: 4_000,
      volM5: 800,
      volH1: 6_000,
      t5VolM5: 500,
      topHolderPct: 22,
      mintRevoked: true,
      freezeRevoked: true,
      rugcheckNormalised: 15,
      alertPath: stampCheckpoint(null, "t15", 20),
    };
    const held = buildConfidence({
      ...base,
      lastPriceUsd: 0.014,
      athPriceUsd: 0.016,
      athMcapUsd: 640_000,
    });
    const dumped = buildConfidence({
      ...base,
      lastPriceUsd: 0.004,
      athPriceUsd: 0.016,
      athMcapUsd: 640_000,
      alertPath: stampCheckpoint(stampCheckpoint(null, "t5", -10), "t15", -60),
    });
    expect(held.sinceAlertGainPct).toBe(40);
    expect(held.athVsAlertPct).toBe(60);
    expect(held.confidence).toBeGreaterThan(dumped.confidence);
    expect(held.reasons).toContain("Held up since first alert");
    expect(dumped.reasons).toContain("Dumped since first alert");
    expect(dumped.reasons.join(" ")).not.toMatch(/wallet/i);
    expect(stampCheckpoint({ t5: "held" }, "t5", -80)).toEqual({ t5: "held" });
  });

  it("ranks extended names after fresh and mid names", () => {
    const rows = [
      { confidence: 90, score: 80, capRegime: "extended" as const, firstAlertAt: alertAt },
      { confidence: 55, score: 50, capRegime: "fresh" as const, firstAlertAt: now },
      { confidence: 70, score: 60, capRegime: "mid" as const, firstAlertAt: alertAt },
    ].sort(compareCandidates);
    expect(rows.map((row) => row.capRegime)).toEqual(["mid", "fresh", "extended"]);
  });
});
