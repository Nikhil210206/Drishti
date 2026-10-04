import { describe, expect, it } from "vitest";
import { classMismatch, quotaMismatch, requestedClasses, requestedQuotas, shownClasses } from "../src/agent/classes.js";

describe("requestedClasses", () => {
  // Commands from eval/tasks: classes in English letters inside Indic sentences, and in Indic script.
  const cases: [string, string[]][] = [
    ["कल चेन्नई से बेंगलुरु की स्लीपर क्लास की एक टिकट बुक करो, मेरे लिए", ["SL"]],
    ["நாளைக்கு சென்னையிலிருந்து பெங்களூருக்கு AC 3 tier டிக்கெட் எனக்கு புக் பண்ணுங்க", ["3A"]],
    ["কাল হাওড়া থেকে পাটনা যাওয়ার একটা স্লিপার টিকিট আমার জন্য বুক করো", ["SL"]],
    ["రేపు Secunderabad నుండి Vijayawada-కి నా కోసం chair car ticket book చేయండి.", ["CC"]],
    ["ನಾಳೆ ಬೆಂಗಳೂರಿನಿಂದ ಮೈಸೂರಿಗೆ ನನ್ನ second sitting ticket-ನ book ಮಾಡಿ.", ["2S"]],
    ["Book me an AC 2 tier ticket from New Delhi to Lucknow for tomorrow, on the first train that has 2A.", ["2A"]],
    ["நாளைக்கு சென்னையிலிருந்து மதுரைக்கு தட்கல்ல ஒரு ஸ்லீப்பர் டிக்கெட் எனக்கு புக் பண்ணுங்க", ["SL"]],
    ["कल मुंबई से पुणे की चेयर कार टिकट बुक करो", ["CC"]],
    ["Book a ticket from Nagpur to Bhopal on 12 October.", []],
    ["कल दिल्ली से लखनऊ की सबसे सस्ती टिकट कितने की है?", []],
  ];
  it.each(cases)("%s", (text, codes) => {
    expect([...requestedClasses([text])].sort()).toEqual(codes);
  });
});

describe("classMismatch", () => {
  it("reads the class from a booking button", () => {
    expect([...shownClasses("book ticket (SL ₹145 49)")]).toEqual(["SL"]);
    expect(shownClasses("Proceed to pay").size).toBe(0);
  });

  it("refuses another class than the one asked for", () => {
    expect(classMismatch(["second sitting ticket book ಮಾಡಿ"], "book ticket (SL ₹145 49)")).toBe(
      "the user asked for Second Sitting (2S), but this books Sleeper (SL)",
    );
  });

  it("allows the asked class, or a class the user later agreed to", () => {
    expect(classMismatch(["chair car ticket"], "book ticket (CC ₹310 6)")).toBe("");
    expect(classMismatch(["second sitting ticket", "ok, sleeper is fine"], "book ticket (SL ₹145 49)")).toBe("");
  });

  it("stays out of the way when no class was named or the control shows several", () => {
    expect(classMismatch(["book a ticket to Mysuru"], "book ticket (SL ₹145 49)")).toBe("");
    expect(classMismatch(["sleeper"], "Train 16400 · CC ₹310 · 2S ₹90")).toBe("");
  });
});

describe("quotas", () => {
  it.each([
    ["நாளைக்கு சென்னையிலிருந்து மதுரைக்கு தட்கல்ல ஒரு ஸ்லீப்பர் டிக்கெட்", ["Tatkal"]],
    ["कल पटना के लिए तत्काल टिकट", ["Tatkal"]],
    ["কাল তৎকাল টিকিট", ["Tatkal"]],
    ["Book a tatkal ticket", ["Tatkal"]],
    ["कल चेन्नई से बेंगलुरु की स्लीपर टिकट क्लास", []], // "टिकट क्लास" is not Tatkal
    ["a ladies quota ticket", ["Ladies"]],
  ])("%s", (text, want) => {
    expect([...requestedQuotas([text])]).toEqual(want);
  });

  it("refuses General when Tatkal was asked, and stays out of the way otherwise", () => {
    const review = "Class Sleeper (SL); Tue, 6 Oct, 2026 · SL · General Review.";
    expect(quotaMismatch(["தட்கல்ல ஸ்லீப்பர்"], review)).toBe("the user asked for the Tatkal quota, but this is General");
    expect(quotaMismatch(["தட்கல்ல ஸ்லீப்பர்"], "Tue, 6 Oct, 2026 · SL · Tatkal Review.")).toBe("");
    expect(quotaMismatch(["sleeper ticket"], review)).toBe("");
    expect(quotaMismatch(["tatkal"], "PAY ₹285")).toBe("");
  });
});
