import { describe, expect, it } from "vitest";
import { saidBy, skeleton } from "../src/agent/match.js";

describe("skeleton", () => {
  it.each([
    ["Ravi Verma", "रवि वर्मा"],
    ["Asha Verma", "আশা ভার্মা"],
    ["Ravi", "ரவி"],
    ["Lakshmi", "లక్ష్మి"],
    ["Gurpreet", "ਗੁਰਪ੍ਰੀਤ"],
    ["36", "३६"],
  ])("%s ≈ %s", (latin, indic) => {
    expect(skeleton(latin)).toBe(skeleton(indic));
  });
});

describe("saidBy", () => {
  const said = ["कल दिल्ली से वाराणसी के लिए दो टिकट, एक मेरे पति रवि वर्मा के लिए, उनकी उम्र 36 साल है"];
  it("finds a name and age said in another script", () => {
    expect(saidBy(said, "Ravi Verma")).toBe(true);
    expect(saidBy(said, "36")).toBe(true);
  });
  it("rejects what was never said", () => {
    expect(saidBy(said, "Passenger 1")).toBe(false);
    expect(saidBy(said, "Rahul Sharma")).toBe(false);
    expect(saidBy(said, "30")).toBe(false);
  });
});
