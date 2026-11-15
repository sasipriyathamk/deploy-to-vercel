import { describe, expect, it } from "vitest";
import { safetyChip, type SafetyInput } from "@/lib/logic/safety";

const clear: SafetyInput = {
  mintRevoked: true,
  freezeRevoked: true,
  topHolderPct: 12,
  rugcheckNormalised: 15,
};

describe("safety chip", () => {
  it("stays unchecked until any safety field is stored", () => {
    expect(
      safetyChip({ mintRevoked: null, freezeRevoked: null, topHolderPct: null, rugcheckNormalised: null }),
    ).toEqual({ tone: "unknown", label: "Not checked", flags: [] });
  });

  it("is clear when the stored checks have no flags", () => {
    expect(safetyChip(clear)).toMatchObject({ tone: "clear", label: "Clear", flags: [] });
  });

  it("shows one flag, then risky when several stack or RugCheck is severe", () => {
    expect(safetyChip({ ...clear, mintRevoked: false }).label).toBe("1 flag");
    expect(safetyChip({ ...clear, rugcheckNormalised: 70 }).label).toBe("1 flag");
    expect(safetyChip({ ...clear, mintRevoked: false, freezeRevoked: false })).toMatchObject({
      tone: "risky",
      label: "Risky",
    });
    expect(safetyChip({ ...clear, rugcheckNormalised: 91 }).label).toBe("Risky");
  });
});
