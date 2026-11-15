import { describe, expect, it } from "vitest";
import { newSignatures } from "@/lib/logic/dedupe";

describe("signature dedupe", () => {
  it("drops signatures that are already stored or repeated in the page", () => {
    const fresh = newSignatures(["sig-a", "sig-b"], ["sig-b", "sig-c", "sig-c", "", "sig-d"]);
    expect(fresh).toEqual(["sig-c", "sig-d"]);
  });

  it("keeps order of the first unseen copy", () => {
    expect(newSignatures([], ["z", "a", "z"])).toEqual(["z", "a"]);
  });
});
