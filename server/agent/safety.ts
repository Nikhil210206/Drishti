import type { ElementInfo } from "../browser/controller.js";

/**
 * Deterministic guardrails. These run in code on every action, so a confused model or a
 * prompt-injected page can never pay, submit or send anything without a spoken "yes".
 */

const IRREVERSIBLE = [
  /\bpay\b(?!ment method)/i, /\bpay now\b/i, /make payment/i, /place order/i, /buy now/i, /\bpurchase\b/i,
  /\bcheckout\b/i, /\btransfer\b/i, /\bsubmit\b/i, /\bsend\b/i, /\bdelete\b/i, /\bremove account\b/i,
  /confirm (booking|payment|order|ticket)/i, /book (now|and pay)/i, /\bdonate\b/i,
  /भुगतान|भेजें|जमा करें|पुष्टि करें/, /পেমেন্ট|পাঠান|জমা দিন/, /செலுத்து|அனுப்பு|சமர்ப்பி/, /చెల్లించు|పంపు|సమర్పించు/,
  /ಪಾವತಿಸಿ|ಕಳುಹಿಸಿ|ಸಲ್ಲಿಸಿ/, /പണമടയ്ക്കുക|അയയ്ക്കുക|സമർപ്പിക്കുക/, /पैसे भरा|पाठवा|सबमिट करा/,
];
// Clearly safe even though they may submit a form.
const SAFE = [/^search/i, /^find/i, /^filter/i, /^sort/i, /^show/i, /^go$/i, /^next$/i, /^modify search/i, /^log ?in/i, /^sign ?in/i];

export function needsConfirmation(el: ElementInfo | undefined): { required: boolean; reason: string } {
  if (!el) return { required: false, reason: "" };
  const label = `${el.name}`.trim();
  if (SAFE.some((re) => re.test(label))) return { required: false, reason: "" };
  if (IRREVERSIBLE.some((re) => re.test(label))) return { required: true, reason: `"${label}" looks irreversible` };
  if (/₹\s?\d/.test(label) && /pay|book|confirm|proceed/i.test(label)) return { required: true, reason: `"${label}" moves money` };
  if (el.type === "submit" && el.inForm && !label) return { required: true, reason: "unlabelled form submit" };
  return { required: false, reason: "" };
}

const SENSITIVE = /(otp|one.?time|passw|passcode|\bpin\b|mpin|upi.?pin|cvv|cvc|card.?num|card no|expiry|aadhaa?r|account.?num|ifsc|captcha)/i;

/** Fields Drishti refuses to fill: the user types these themselves. */
export function isSensitiveField(el: ElementInfo | undefined): boolean {
  if (!el) return false;
  if (el.type === "password") return true;
  if (/one-time-code|cc-number|cc-csc|cc-exp|current-password|new-password/.test(el.autocomplete)) return true;
  return SENSITIVE.test(`${el.name} ${el.fieldHint}`);
}

// ---------- spoken yes / no in 11 languages ----------
const YES = [
  "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "confirm", "go ahead", "do it", "correct", "right", "proceed",
  "haan", "han", "ha", "haa", "ji", "theek", "thik", "sahi", "kar do", "karo", "chalo", "bilkul",
  "हाँ", "हां", "हा", "जी", "ठीक", "सही", "करो", "कर दो", "चलो", "बिल्कुल", "होय", "हो",
  "হ্যাঁ", "হ্যা", "হাঁ", "ঠিক", "আচ্ছা", "করো", "করুন",
  "ஆமா", "ஆம்", "ஆமாம்", "சரி", "செய்", "செய்யுங்க", "aama", "aamaa", "sari", "seri",
  "అవును", "సరే", "చేయి", "చేయండి", "avunu", "sare",
  "ಹೌದು", "ಸರಿ", "ಮಾಡಿ", "houdu", "sari",
  "അതെ", "ശരി", "ചെയ്യൂ", "athe", "shari",
  "હા", "બરાબર", "ਹਾਂ", "ਠੀਕ", "ହଁ", "ଠିକ",
];
const NO = [
  "no", "nope", "cancel", "stop", "don't", "dont", "wait", "wrong", "not",
  "nahi", "nahin", "mat", "ruko", "ruk", "galat", "nako", "nahi karo",
  "नहीं", "नही", "मत", "रुको", "रुकिए", "गलत", "नाही", "नको",
  "না", "নাহ", "থামো", "ভুল",
  "இல்லை", "இல்ல", "வேண்டாம்", "நிறுத்து", "தப்பு", "illa", "vendam", "venda",
  "కాదు", "వద్దు", "ఆపు", "తప్పు", "vaddu",
  "ಇಲ್ಲ", "ಬೇಡ", "ನಿಲ್ಲಿಸಿ", "beda",
  "ഇല്ല", "വേണ്ട", "നിർത്തൂ", "venda",
  "ના", "નહીં", "ਨਹੀਂ", "ନା",
];

export function yesNo(text: string): "yes" | "no" | "unclear" {
  const t = ` ${text.toLowerCase().replace(/[.,!?।॥"'`]/g, " ").replace(/\s+/g, " ")} `;
  const has = (w: string) => t.includes(` ${w} `) || (w.length > 3 && /[^\x00-\x7F]/.test(w) && t.includes(w));
  const no = NO.some(has);
  const yes = YES.some(has);
  if (no) return "no"; // negation wins: "haan nahi" → no
  if (yes) return "yes";
  return "unclear";
}

// ---------- quick local commands (no LLM round-trip) ----------
const STOP = ["stop", "ruko", "bas", "रुको", "बस", "थांबा", "থামো", "நிறுத்து", "ఆపు", "ನಿಲ್ಲಿಸಿ", "നിർത്തൂ"];
const REPEAT = ["repeat", "phir se", "dobara", "फिर से", "दोबारा", "আবার", "மீண்டும்", "మళ్ళీ", "ಮತ್ತೆ", "വീണ്ടും", "पुन्हा"];
const FASTER = ["faster", "speed up", "tez", "jaldi bolo", "तेज़", "तेज", "জোরে", "வேகமாக", "వేగంగా", "ವೇಗವಾಗಿ", "വേഗം"];
const SLOWER = ["slower", "slow down", "dheere", "धीरे", "আস্তে", "மெதுவாக", "నెమ్మదిగా", "ನಿಧಾನವಾಗಿ", "പതുക്കെ"];

export function quickCommand(text: string): "stop" | "repeat" | "faster" | "slower" | null {
  const t = text.toLowerCase().replace(/[.,!?।]/g, "").trim();
  if (t.split(/\s+/).length > 4) return null; // only short utterances are commands
  const hit = (list: string[]) =>
    list.some((w) => (/^[\x00-\x7F]+$/.test(w) ? new RegExp(`(^|\\s)${w}(\\s|$)`).test(t) : t.includes(w)));
  if (hit(STOP)) return "stop";
  if (hit(REPEAT)) return "repeat";
  if (hit(FASTER)) return "faster";
  if (hit(SLOWER)) return "slower";
  return null;
}
