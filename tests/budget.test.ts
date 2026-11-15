import { describe, expect, it } from "vitest";
import { exceedsProviderBudget } from "@/lib/budgets";
import { queueBudgetMs } from "@/lib/pipeline";

describe("provider budget comparisons", () => {
  it("does not treat a string count of 3 as over a 120 budget", () => {
    expect("3" >= "120").toBe(true);
    expect(exceedsProviderBudget("3", 120)).toBe(false);
    expect(exceedsProviderBudget("3", "120")).toBe(false);
    expect(exceedsProviderBudget(3, 120)).toBe(false);
    expect(exceedsProviderBudget("119", 120)).toBe(false);
    expect(exceedsProviderBudget("120", 120)).toBe(true);
    expect(exceedsProviderBudget("121", "120")).toBe(true);
    expect(exceedsProviderBudget("not-a-number", 120)).toBe(false);
  });
});

describe("queue time budget", () => {
  it("gives a poll the rest of a 50s run instead of a 12s nibble", () => {
    expect(queueBudgetMs(0)).toBe(45_000);
    expect(queueBudgetMs(2_000)).toBe(43_000);
    expect(queueBudgetMs(12_000)).toBe(33_000);
    expect(queueBudgetMs(45_000)).toBe(0);
    expect(queueBudgetMs(70_000)).toBe(0);
  });
});
