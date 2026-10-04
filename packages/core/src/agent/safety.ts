import type { ElementInfo } from "../types.js";

/**
 * Deterministic guardrails. These run in code on every action, so a confused model or a
 * prompt-injected page can never pay, submit or send anything without a spoken "yes".
 */

const IRREVERSIBLE = [
  /\bpay\b(?!ment method)/i,
  /\bpay now\b/i,
  /make payment/i,
  /place order/i,
  /buy now/i,
  /\bpurchase\b/i,
  /\bcheckout\b/i,
  /\btransfer\b/i,
  /\bsubmit\b/i,
  /\bsend\b/i,
  /\bdelete\b/i,
  /\bremove account\b/i,
  /confirm (booking|payment|order|ticket)/i,
  /book (now|and pay)/i,
  /\bdonate\b/i,
  /भुगतान|भेजें|जमा करें|पुष्टि करें/,
  /পেমেন্ট|পাঠান|জমা দিন/,
  /செலுத்து|அனுப்பு|சமர்ப்பி/,
  /చెల్లించు|పంపు|సమర్పించు/,
  /ಪಾವತಿಸಿ|ಕಳುಹಿಸಿ|ಸಲ್ಲಿಸಿ/,
  /പണമടയ്ക്കുക|അയയ്ക്കുക|സമർപ്പിക്കുക/,
  /पैसे भरा|पाठवा|सबमिट करा/,
];
// Clearly safe even though they may submit a form. Checked only after IRREVERSIBLE, so
// "Show & pay" or "Search and book now" still need a yes.
const SAFE = [/^search/i, /^find/i, /^filter/i, /^sort/i, /^show/i, /^modify search/i, /^log ?in/i, /^sign ?in/i];
// Labels that say nothing about what happens next. On a page that asks for money they can be the payment.
const GENERIC_ADVANCE = /^(next|continue|proceed|go|ok|okay|done|confirm|yes|agree|i agree|submit|aage badhein|आगे|आगे बढ़ें|जारी रखें)$/i;
const MONEY = /(₹|\brs\.?|\binr)\s?\d/i;
const PAYMENT_CONTEXT = /\b(pay|payment|payable|total|checkout|order)\b|भुगतान/i;

export interface ConfirmContext {
  /** Text of the page the element is on (snapshot text). */
  pageText?: string;
}

// Controls that pick or enter a value rather than act. A model-invented confirmation on these
// (e.g. "confirm selecting Chennai Central?") only slows a blind user down.
const VALUE_ROLES = new Set([
  "option",
  "radio",
  "checkbox",
  "tab",
  "switch",
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "slider",
  "menuitemradio",
  "menuitemcheckbox",
  "select",
  "date",
]);

export interface Gate {
  /** The deterministic rules demand a spoken yes. The model can never remove this. */
  required: boolean;
  /** Clearly harmless (search, filters, picking a value): a confirmation the model asks for is ignored. */
  safe: boolean;
  reason: string;
}

export function needsConfirmation(el: ElementInfo | undefined, ctx: ConfirmContext = {}): Gate {
  if (!el) return { required: false, safe: false, reason: "" };
  const label = `${el.name}`.replace(/\s+/g, " ").trim();
  // Irreversible words anywhere in the name win over everything else.
  if (IRREVERSIBLE.some((re) => re.test(label))) return { required: true, safe: false, reason: `"${label}" looks irreversible` };
  if (MONEY.test(label) && /pay|book|confirm|proceed|buy|order/i.test(label))
    return { required: true, safe: false, reason: `"${label}" moves money` };
  if (SAFE.some((re) => re.test(label))) return { required: false, safe: true, reason: "" };
  const page = ctx.pageText ?? "";
  if (GENERIC_ADVANCE.test(label) && MONEY.test(page) && PAYMENT_CONTEXT.test(page)) {
    return { required: true, safe: false, reason: `"${label}" on a page asking for money` };
  }
  if (!label && (el.type === "submit" || el.inForm) && /button|submit/.test(`${el.role} ${el.type}`)) {
    return { required: true, safe: false, reason: "unlabelled form submit" };
  }
  return { required: false, safe: VALUE_ROLES.has(el.role), reason: "" };
}

const SENSITIVE =
  /(otp|one.?time|passw|passcode|\bpin\b|mpin|upi.?pin|cvv|cvc|card.?num|card no|expiry|aadhaa?r|account.?num|ifsc|captcha)/i;

/** Fields Drishti refuses to fill: the user types these themselves. */
export function isSensitiveField(el: ElementInfo | undefined): boolean {
  if (!el) return false;
  if (el.type === "password") return true;
  if (/one-time-code|cc-number|cc-csc|cc-exp|current-password|new-password/.test(el.autocomplete)) return true;
  return SENSITIVE.test(`${el.name} ${el.fieldHint}`);
}

// ---------- spoken yes / no in 11 languages ----------
const YES = [
  "yes",
  "yeah",
  "yep",
  "yup",
  "ok",
  "okay",
  "sure",
  "confirm",
  "go ahead",
  "do it",
  "correct",
  "right",
  "proceed",
  "haan",
  "han",
  "ha",
  "haa",
  "ji",
  "theek",
  "thik",
  "sahi",
  "kar do",
  "karo",
  "chalo",
  "bilkul",
  "हाँ",
  "हां",
  "हा",
  "जी",
  "ठीक",
  "सही",
  "करो",
  "कर दो",
  "चलो",
  "बिल्कुल",
  "होय",
  "हो",
  "হ্যাঁ",
  "হ্যা",
  "হাঁ",
  "ঠিক",
  "আচ্ছা",
  "করো",
  "করুন",
  "ஆமா",
  "ஆம்",
  "ஆமாம்",
  "கண்டிப்பா",
  "கண்டிப்பாக",
  "சரி",
  "செய்",
  "செய்யுங்க",
  "aama",
  "aamaa",
  "sari",
  "seri",
  "అవును",
  "సరే",
  "చేయి",
  "చేయండి",
  "avunu",
  "sare",
  "ಹೌದು",
  "ಸರಿ",
  "ಮಾಡಿ",
  "houdu",
  "sari",
  "അതെ",
  "ശരി",
  "ചെയ്യൂ",
  "athe",
  "shari",
  "હા",
  "બરાબર",
  "ਹਾਂ",
  "ਠੀਕ",
  "ହଁ",
  "ଠିକ",
];
const NO = [
  "no",
  "nope",
  "cancel",
  "stop",
  "don't",
  "dont",
  "wait",
  "wrong",
  "not",
  "nahi",
  "nahin",
  "mat",
  "ruko",
  "ruk",
  "galat",
  "nako",
  "nahi karo",
  "नहीं",
  "नही",
  "मत",
  "रुको",
  "रुकिए",
  "गलत",
  "नाही",
  "नको",
  "না",
  "নাহ",
  "থামো",
  "থামুন",
  "ভুল",
  "இல்லை",
  "இல்ல",
  "வேண்டாம்",
  "நிறுத்து",
  "தப்பு",
  "illa",
  "vendam",
  "venda",
  "కాదు",
  "వద్దు",
  "ఆపు",
  "తప్పు",
  "vaddu",
  "ಇಲ್ಲ",
  "ಬೇಡ",
  "ನಿಲ್ಲಿಸಿ",
  "beda",
  "ഇല്ല",
  "വേണ്ട",
  "നിർത്തൂ",
  "venda",
  "ના",
  "નહીં",
  "ਨਹੀਂ",
  "ନା",
];

// A yes that comes with a condition or a question is not a yes yet ("haan, lekin pehle seat
// batao"): the gate asks again instead of paying.
const HEDGE = [
  "but",
  "first",
  "before",
  "wait",
  "however",
  "what",
  "which",
  "how much",
  "lekin",
  "magar",
  "pehle",
  "kitna",
  "kya",
  "लेकिन",
  "मगर",
  "पहले",
  "कितना",
  "क्या",
  "पण",
  "आधी",
  "কিন্তু",
  "আগে",
  "কত",
  "কী",
  "কি",
  "ஆனா",
  "ஆனால்",
  "முதல்ல",
  "முதலில்",
  "எவ்வளவு",
  "என்ன",
  "aana",
  "mudhalla",
  "కానీ",
  "ముందు",
  "ఎంత",
  "ಆದರೆ",
  "ಮೊದಲು",
  "ಎಷ್ಟು",
  "പക്ഷേ",
  "ആദ്യം",
  "എത്ര",
  "પરંતુ",
  "પહેલા",
  "કેટલા",
  "ਪਰ",
  "ਪਹਿਲਾਂ",
  "ਕਿੰਨਾ",
  "କିନ୍ତୁ",
  "ଆଗରୁ",
  "କେତେ",
];

export function yesNo(text: string): "yes" | "no" | "unclear" {
  const asked = /[?？]/.test(text);
  const t = ` ${text
    .toLowerCase()
    .replace(/[.,!?।॥"'`]/g, " ")
    .replace(/\s+/g, " ")} `;
  // oxlint-disable-next-line no-control-regex -- ASCII range check, not a control character
  const has = (w: string) => t.includes(` ${w} `) || (w.length > 3 && /[^\x00-\x7F]/.test(w) && t.includes(w));
  const no = NO.some(has);
  const yes = YES.some(has);
  if (no) return "no"; // negation wins: "haan nahi" → no
  if (yes && (asked || HEDGE.some(has))) return "unclear";
  if (yes) return "yes";
  return "unclear";
}

// ---------- quick local commands (no LLM round-trip) ----------
const STOP = ["stop", "ruko", "bas", "रुको", "बस", "थांबा", "থামো", "நிறுத்து", "ఆపు", "ನಿಲ್ಲಿಸಿ", "നിർത്തൂ"];
const REPEAT = ["repeat", "phir se", "dobara", "फिर से", "दोबारा", "আবার", "மீண்டும்", "మళ్ళీ", "ಮತ್ತೆ", "വീണ്ടും", "पुन्हा"];
const FASTER = ["faster", "speed up", "tez", "jaldi bolo", "तेज़", "तेज", "জোরে", "வேகமாக", "వేగంగా", "ವೇಗವಾಗಿ", "വേഗം"];
const SLOWER = ["slower", "slow down", "dheere", "धीरे", "আস্তে", "மெதுவாக", "నెమ్మదిగా", "ನಿಧಾನವಾಗಿ", "പതുക്കെ"];

export function quickCommand(text: string): "stop" | "repeat" | "faster" | "slower" | null {
  const t = text
    .toLowerCase()
    .replace(/[.,!?।]/g, "")
    .trim();
  if (t.split(/\s+/).length > 4) return null; // only short utterances are commands
  const hit = (list: string[]) =>
    // oxlint-disable-next-line no-control-regex -- ASCII range check, not a control character
    list.some((w) => (/^[\x00-\x7F]+$/.test(w) ? new RegExp(`(^|\\s)${w}(\\s|$)`).test(t) : t.includes(w)));
  if (hit(STOP)) return "stop";
  if (hit(REPEAT)) return "repeat";
  if (hit(FASTER)) return "faster";
  if (hit(SLOWER)) return "slower";
  return null;
}
