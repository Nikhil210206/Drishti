import { describe, expect, it } from "vitest";
import { isSensitiveField, needsConfirmation, quickCommand, yesNo, type ElementInfo } from "../src/index.js";

const el = (name: string, extra: Partial<ElementInfo> = {}): ElementInfo => ({
  role: "button",
  name,
  inferred: false,
  tag: "button",
  type: "",
  href: "",
  inForm: false,
  autocomplete: "",
  fieldHint: "",
  ...extra,
});

const PAYMENT_PAGE = '# Payment\n- Amount payable ₹845\n[12] button "Next"';
const PASSENGER_PAGE = '# Passenger details\n[81] textbox "Name"\n[89] clickable "CONTINUE"';

describe("needsConfirmation", () => {
  it.each([
    ["PAY ₹845"],
    ["Pay now"],
    ["Proceed to pay"],
    ["Show & pay"], // the old anchored SAFE regex let this through
    ["Search and book now"],
    ["Submit complaint"],
    ["Send message"],
    ["Delete account"],
    ["Confirm booking"],
    ["Place order"],
    ["Login and pay"],
    ["भुगतान करें"],
    ["পেমেন্ট করুন"],
    ["செலுத்து"],
    ["Book ₹430"],
  ])("asks before %s", (name) => {
    expect(needsConfirmation(el(name)).required).toBe(true);
  });

  it.each([
    ["SEARCH TRAINS"],
    ["Find trains"],
    ["Show more"],
    ["Modify search"],
    ["Log in"],
    ["Payment method"],
    ["Book ticket"],
    ["Tomorrow"],
  ])("does not ask before %s", (name) => {
    expect(needsConfirmation(el(name)).required).toBe(false);
  });

  it("asks before a generic Next/Continue on a page that asks for money", () => {
    expect(needsConfirmation(el("Next"), { pageText: PAYMENT_PAGE }).required).toBe(true);
    expect(needsConfirmation(el("Continue"), { pageText: "Total ₹430" }).required).toBe(true);
    expect(needsConfirmation(el("OK"), { pageText: "Total amount Rs. 1,045" }).required).toBe(true);
  });

  it("lets a generic Continue through when the page has no payment", () => {
    expect(needsConfirmation(el("CONTINUE"), { pageText: PASSENGER_PAGE }).required).toBe(false);
    expect(needsConfirmation(el("Next"), { pageText: "Step 2 of 3" }).required).toBe(false);
  });

  it("asks before an unlabelled form submit", () => {
    expect(needsConfirmation(el("", { type: "submit", inForm: true })).required).toBe(true);
  });

  it("is a no-op for a missing element", () => {
    expect(needsConfirmation(undefined)).toEqual({ required: false, safe: false, reason: "" });
  });
});

describe("needsConfirmation: clearly safe controls", () => {
  it.each([
    ["SEARCH TRAINS", {}],
    ["Chennai Central MAS Chennai", { role: "option" }],
    ["Sleeper", { role: "radio" }],
    ["FROM", { role: "textbox" }],
  ])("%s is safe, so a model-invented confirmation is ignored", (name, extra) => {
    expect(needsConfirmation(el(name, extra as Partial<ElementInfo>))).toMatchObject({ required: false, safe: true });
  });

  it("is not safe for an ordinary button the rules do not know", () => {
    expect(needsConfirmation(el("Continue"))).toMatchObject({ required: false, safe: false });
  });

  it("never marks an irreversible option as safe", () => {
    expect(needsConfirmation(el("Pay with UPI", { role: "radio" }))).toMatchObject({ required: true, safe: false });
  });
});

describe("isSensitiveField", () => {
  const field = (name: string, extra: Partial<ElementInfo> = {}) => el(name, { role: "textbox", tag: "input", type: "text", ...extra });
  it.each([
    [field("Password", { type: "password" })],
    [field("", { autocomplete: "one-time-code" })],
    [field("", { autocomplete: "cc-number" })],
    [field("Enter OTP")],
    [field("UPI PIN")],
    [field("CVV")],
    [field("Card number")],
    [field("", { fieldHint: "aadhaar_no" })],
    [field("Account number")],
    [field("Enter the captcha")],
  ])("blocks %#", (f) => {
    expect(isSensitiveField(f)).toBe(true);
  });

  it.each([[field("Name")], [field("Age")], [field("Mobile number (for ticket SMS)")], [field("From station")]])("allows %#", (f) => {
    expect(isSensitiveField(f)).toBe(false);
  });
});

describe("yesNo in all 11 languages", () => {
  it.each([
    ["en-IN", "yes please", "no, don't"],
    ["hi-IN", "हाँ, कर दो", "नहीं, रुको"],
    ["hi-IN (romanised)", "haan ji", "nahi"],
    ["bn-IN", "হ্যাঁ, করুন", "না"],
    ["ta-IN", "சரி, செய்யுங்க", "வேண்டாம்"],
    ["te-IN", "అవును", "వద్దు"],
    ["kn-IN", "ಹೌದು", "ಬೇಡ"],
    ["ml-IN", "ശരി", "വേണ്ട"],
    ["mr-IN", "होय", "नको"],
    ["gu-IN", "હા", "ના"],
    ["pa-IN", "ਹਾਂ ਜੀ", "ਨਹੀਂ"],
    ["od-IN", "ହଁ", "ନା"],
  ])("%s", (_lang, yes, no) => {
    expect(yesNo(yes)).toBe("yes");
    expect(yesNo(no)).toBe("no");
  });

  it("lets a negation win", () => {
    expect(yesNo("haan nahi")).toBe("no");
    expect(yesNo("हाँ, नहीं रुको")).toBe("no");
  });

  it("does not take a yes with a condition or a question as a yes", () => {
    expect(yesNo("हाँ लेकिन पहले सीट बताओ")).toBe("unclear");
    expect(yesNo("ஆமா ஆனா முதல்ல சீட் நம்பர் சொல்லுங்க")).toBe("unclear");
    expect(yesNo("হ্যাঁ, কিন্তু আগে সিট নম্বর বলুন")).toBe("unclear");
    expect(yesNo("yes, but which coach?")).toBe("unclear");
    expect(yesNo("haan, kitna hai?")).toBe("unclear");
    expect(yesNo("అవును, కానీ ముందు ధర చెప్పండి")).toBe("unclear");
  });

  it("knows polite stops and emphatic yeses", () => {
    expect(yesNo("থামুন")).toBe("no");
    expect(yesNo("கண்டிப்பா பண்ணுங்க")).toBe("yes");
  });

  it("is unclear for unrelated speech", () => {
    expect(yesNo("what is the fare?")).toBe("unclear");
    expect(yesNo("")).toBe("unclear");
  });
});

describe("quickCommand", () => {
  it.each([
    ["stop", "stop"],
    ["Ruko!", "stop"],
    ["बस", "stop"],
    ["நிறுத்து", "stop"],
    ["phir se", "repeat"],
    ["दोबारा बोलो", "repeat"],
    ["faster", "faster"],
    ["थोड़ा तेज़ बोलो", "faster"],
    ["dheere", "slower"],
    ["மெதுவாக", "slower"],
  ])("%s → %s", (text, cmd) => {
    expect(quickCommand(text)).toBe(cmd);
  });

  it("ignores long utterances", () => {
    expect(quickCommand("Chennai se Bengaluru kal ka ticket book karo, stop nahi")).toBeNull();
  });

  it("ignores words that only contain a command", () => {
    expect(quickCommand("basket")).toBeNull();
    expect(quickCommand("bastar district")).toBeNull();
  });
});
