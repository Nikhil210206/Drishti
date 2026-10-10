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
  /\bsubscribe\b|\brecharge\b|\brenew\b|\bupgrade\b|add money/i,
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
  /** The element's id in that text, to see whether it sits in a results row. */
  id?: string | number;
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
  /** One of several priced options (a train's "book ticket ₹160"): no question, but still checked against what the user asked. */
  choice?: boolean;
}

export function needsConfirmation(el: ElementInfo | undefined, ctx: ConfirmContext = {}): Gate {
  if (!el) return { required: false, safe: false, reason: "" };
  const label = `${el.name}`.replace(/\s+/g, " ").trim();
  // Irreversible words anywhere in the name win over everything else.
  if (IRREVERSIBLE.some((re) => re.test(label))) return { required: true, safe: false, reason: `"${label}" looks irreversible` };
  // One of several priced options in a list ("book ticket (SL ₹160)" on every train of a results
  // page) chooses a train; nothing is paid until the payment step, which asks with the total. Asking
  // here too made one booking three questions. "Pay", "buy now" and the like never reach this line.
  if (MONEY.test(label) && choiceInList(label, ctx)) return { required: false, safe: true, reason: "", choice: true };
  if (MONEY.test(label) && /pay|book|confirm|proceed|buy|order/i.test(label))
    return { required: true, safe: false, reason: `"${label}" moves money` };
  if (SAFE.some((re) => re.test(label))) return { required: false, safe: true, reason: "" };
  // Any other button carrying a price may spend it ("Subscribe ₹499", an advert's "Get it ₹99").
  // Choosing a value (an option, a radio with a fare) only selects.
  if (MONEY.test(label) && !VALUE_ROLES.has(el.role)) return { required: true, safe: false, reason: `"${label}" has a price` };
  const page = ctx.pageText ?? "";
  if (GENERIC_ADVANCE.test(label) && MONEY.test(page) && PAYMENT_CONTEXT.test(page)) {
    return { required: true, safe: false, reason: `"${label}" on a page asking for money` };
  }
  if (!label && (el.type === "submit" || el.inForm) && /button|submit/.test(`${el.role} ${el.type}`)) {
    return { required: true, safe: false, reason: "unlabelled form submit" };
  }
  return { required: false, safe: VALUE_ROLES.has(el.role), reason: "" };
}

/**
 * A priced "book", "select" or "choose" control that picks one of a list: it sits in a results row
 * (the page model's "ROW:" lines), the page counts its results ("1 trains found": one or two results
 * are never "ROW:" lines), or at least three priced controls start with the same words.
 * Never "buy", "order", "pay" or "subscribe": a one-click shop may charge on those.
 */
const RESULT_COUNT =
  /\b\d+\s+(?:results?|trains?|flights?|buses|options)\s+(?:found|available)\b|\bshowing\s+\d+(?:\s*[–-]\s*\d+)?\s+of\s+\d+/i;

function choiceInList(label: string, ctx: ConfirmContext): boolean {
  if (!/^(book|select|choose|view|check)\b/i.test(label)) return false;
  const page = ctx.pageText ?? "";
  if (ctx.id !== undefined && page.split("\n").some((l) => l.startsWith("ROW:") && l.includes(`[${ctx.id}] `))) return true;
  if (page.split("\n").some((l) => l.startsWith("- ") && RESULT_COUNT.test(l))) return true;
  const lead = label
    .split(/[(₹]/)[0]
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (page.match(new RegExp(`"${lead}[^"\\n]{0,40}₹`, "gi")) ?? []).length >= 3;
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

// ---------- "leave it": the user giving up on the task ----------
// Phrases, matched anywhere in a short answer. "No" alone is not one: it may answer the question.
const GIVE_UP = [
  "leave it",
  "forget it",
  "never mind",
  "nevermind",
  "cancel it",
  "don't bother",
  "rehne do",
  "rahne do",
  "jaane do",
  "jane do",
  "chhodo",
  "chhod do",
  "रहने दो",
  "रहने दीजिए",
  "जाने दो",
  "छोड़ो",
  "छोड़ दो",
  "छोड़िए",
  "राहू दे",
  "राहूदे",
  "सोडून दे",
  "जाऊ दे",
  "থাক",
  "বাদ দাও",
  "ছেড়ে দাও",
  "விடுங்க",
  "விட்டுடுங்க",
  "வேண்டாம் விடு",
  "వదిలేయండి",
  "వదిలేయి",
  "వద్దులే",
  "ಬಿಡಿ",
  "ಬಿಟ್ಟುಬಿಡಿ",
  "ಬೇಡ ಬಿಡಿ",
  "വിട്ടേക്ക്",
  "വേണ്ട വിട്",
  "રહેવા દો",
  "જવા દો",
  "છોડો",
  "ਰਹਿਣ ਦਿਓ",
  "ਛੱਡੋ",
  "ਛੱਡ ਦਿਓ",
  "ਜਾਣ ਦਿਓ",
  "ଥାଉ",
  "ଛାଡ଼ି ଦିଅ",
  "ଛାଡ",
];

/** True when a short answer says to drop the task ("नहीं, रहने दो", "leave it"). */
export function givesUp(text: string): boolean {
  const t = ` ${text
    .toLowerCase()
    .replace(/[.,!?।॥"'`]/g, " ")
    .replace(/\s+/g, " ")} `;
  if (t.trim().split(" ").length > 6) return false;
  // oxlint-disable-next-line no-control-regex -- ASCII range check, not a control character
  return GIVE_UP.some((w) => (/^[\x00-\x7F]+$/.test(w) ? t.includes(` ${w} `) : t.includes(w)));
}

// ---------- quick local commands (no LLM round-trip) ----------
const STOP = ["stop", "ruko", "bas", "रुको", "बस", "थांबा", "থামো", "நிறுத்து", "ఆపు", "ನಿಲ್ಲಿಸಿ", "നിർത്തൂ"];
const REPEAT = ["repeat", "phir se", "dobara", "फिर से", "दोबारा", "আবার", "மீண்டும்", "మళ్ళీ", "ಮತ್ತೆ", "വീണ്ടും", "पुन्हा"];
const FASTER = ["faster", "speed up", "tez", "jaldi bolo", "तेज़", "तेज", "জোরে", "வேகமாக", "వేగంగా", "ವೇಗವಾಗಿ", "വേഗം"];
const SLOWER = ["slower", "slow down", "dheere", "धीरे", "আস্তে", "மெதுவாக", "నెమ్మదిగా", "ನಿಧಾನವಾಗಿ", "പതുക്കെ"];

// "Delete my details": a delete word and a details word in one short utterance, in any of the 11
// languages. It still asks for a yes before anything is deleted. Needs a native-speaker review.
const DELETE_WORDS = [
  "delete",
  "erase",
  "forget",
  "remove",
  "clear",
  "wipe",
  "मिटा",
  "हटा",
  "डिलीट",
  "पुसून",
  "पुसा",
  "काढून",
  "அழி",
  "நீக்கு",
  "நீக்க",
  "తొలగించ",
  "తీసేయ",
  "ಅಳಿಸ",
  "ತೆಗೆದು",
  "മായ്ക്ക",
  "നീക്ക",
  "মুছ",
  "ডিলিট",
  "કાઢી",
  "ભૂંસી",
  "ਮਿਟਾ",
  "ਹਟਾ",
  "ଲିଭା",
  "ହଟା",
];
const DETAIL_WORDS = [
  "details",
  "data",
  "information",
  "info",
  "profile",
  "जानकारी",
  "डेटा",
  "डाटा",
  "विवरण",
  "प्रोफ़ाइल",
  "माहिती",
  "தகவல",
  "விவர",
  "వివరాలు",
  "సమాచార",
  "ಮಾಹಿತಿ",
  "ವಿವರ",
  "വിവര",
  "ഡാറ്റ",
  "তথ্য",
  "ডেটা",
  "માહિતી",
  "વિગત",
  "ਜਾਣਕਾਰੀ",
  "ਡਾਟਾ",
  "ତଥ୍ୟ",
  "ବିବରଣୀ",
];

export function quickCommand(text: string): "stop" | "repeat" | "faster" | "slower" | "forget" | null {
  const t = text
    .toLowerCase()
    .replace(/[.,!?।]/g, "")
    .trim();
  const words = t.split(/\s+/).length;
  if (words > 6) return null; // only short utterances are commands
  const hit = (list: string[]) =>
    // oxlint-disable-next-line no-control-regex -- ASCII range check, not a control character
    list.some((w) => (/^[\x00-\x7F]+$/.test(w) ? new RegExp(`(^|\\s)${w}(\\s|$)`).test(t) : t.includes(w)));
  if (hit(DELETE_WORDS) && hit(DETAIL_WORDS)) return "forget";
  if (words > 4) return null;
  if (hit(STOP)) return "stop";
  if (hit(REPEAT)) return "repeat";
  if (hit(FASTER)) return "faster";
  if (hit(SLOWER)) return "slower";
  return null;
}
