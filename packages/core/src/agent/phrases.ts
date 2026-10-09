import type { LangCode } from "../lang.js";
import type { Cache, Translator } from "../types.js";

/** Fixed things Drishti says. English + hand-checked Hindi; other languages come from Mayura (cached). */
export const PHRASES = {
  ready: {
    "en-IN": "Hi, I'm Drishti. Tell me what you want to do.",
    "hi-IN": "नमस्ते, मैं दृष्टि हूँ। बताइए, क्या करना है?",
  },
  oneMoment: { "en-IN": "One moment.", "hi-IN": "एक सेकंड।" },
  working: { "en-IN": "Still working on it.", "hi-IN": "अभी काम कर रही हूँ।" },
  confirmGeneric: { "en-IN": "Should I go ahead?", "hi-IN": "क्या मैं आगे बढ़ूँ?" },
  sayYesNo: { "en-IN": "Please say yes or no.", "hi-IN": "कृपया हाँ या ना बोलिए।" },
  pageShows: { "en-IN": "The page says:", "hi-IN": "पेज पर लिखा है:" },
  cancelled: { "en-IN": "Okay, I have not done it.", "hi-IN": "ठीक है, मैंने नहीं किया।" },
  stopped: { "en-IN": "Okay, stopped.", "hi-IN": "ठीक है, रोक दिया।" },
  noAnswer: { "en-IN": "I did not hear an answer, so I have stopped here.", "hi-IN": "मुझे जवाब नहीं मिला, इसलिए मैं यहीं रुक गई।" },
  composePrompt: {
    "en-IN": "Hold the Fn key and speak your message. I will read it back to you.",
    "hi-IN": "Fn बटन दबाकर अपना मैसेज बोलिए। मैं आपको पढ़कर सुनाऊँगी।",
  },
  youWrote: { "en-IN": "You wrote:", "hi-IN": "आपने लिखा:" },
  isThisRight: { "en-IN": "Is this correct?", "hi-IN": "क्या यह सही है?" },
  sensitiveField: {
    "en-IN": "This field needs a password, OTP or card detail. For your safety, please type it yourself. I have put the cursor there.",
    "hi-IN": "यहाँ पासवर्ड, OTP या कार्ड की जानकारी चाहिए। आपकी सुरक्षा के लिए इसे खुद टाइप कीजिए। मैंने कर्सर वहीं रख दिया है।",
  },
  readingDoc: {
    "en-IN": "Reading the document. This takes about fifteen seconds.",
    "hi-IN": "डॉक्यूमेंट पढ़ रही हूँ, लगभग पंद्रह सेकंड लगेंगे।",
  },
  error: { "en-IN": "Sorry, something went wrong. Please try again.", "hi-IN": "माफ़ कीजिए, कुछ गड़बड़ हो गई। फिर से कोशिश कीजिए।" },
  // The Drishti proxy's refusals (busy or slow_down, quota, unauthorized): "try again" is wrong advice for those.
  busy: {
    "en-IN": "Many people are using Drishti right now. Please try again in a minute.",
    "hi-IN": "अभी बहुत लोग Drishti इस्तेमाल कर रहे हैं। एक मिनट बाद फिर कोशिश कीजिए।",
  },
  limit: {
    "en-IN": "You have used today's limit. I can help again tomorrow.",
    "hi-IN": "आज की सीमा पूरी हो गई है। मैं कल फिर से मदद कर पाऊँगी।",
  },
  reconnect: {
    "en-IN": "Drishti is not connected. Please open Drishti's setup and connect again.",
    "hi-IN": "Drishti जुड़ा हुआ नहीं है। कृपया Drishti का सेटअप खोलकर फिर से जोड़िए।",
  },
  stuck: {
    "en-IN": "I'm stuck on this page. Tell me what to try next.",
    "hi-IN": "मैं इस पेज पर अटक गई हूँ। बताइए, आगे क्या करूँ?",
  },
  siteAccess: {
    "en-IN": "Drishti needs your permission to work on this website. Say yes or press Yes, then choose Allow in Chrome's box.",
    "hi-IN": "इस वेबसाइट पर काम करने के लिए Drishti को आपकी अनुमति चाहिए। हाँ बोलिए या Yes दबाइए, फिर Chrome के बॉक्स में Allow चुनिए।",
  },
  pressYes: {
    "en-IN": "Chrome needs a key press for this. Press Alt Shift Y, or press Enter on the Yes button.",
    "hi-IN": "इसके लिए Chrome को बटन दबाना ज़रूरी है। Alt Shift Y दबाइए, या Yes बटन पर Enter दबाइए।",
  },
  siteDenied: {
    "en-IN": "Okay. I won't work on this website.",
    "hi-IN": "ठीक है। मैं इस वेबसाइट पर काम नहीं करूँगी।",
  },
  forgetConfirm: {
    "en-IN": "Delete your saved name, age and phone number from this device?",
    "hi-IN": "क्या आपका सेव किया हुआ नाम, उम्र और फ़ोन नंबर इस डिवाइस से मिटा दूँ?",
  },
  forgotten: {
    "en-IN": "Done. Your saved details are deleted from this device.",
    "hi-IN": "हो गया। आपकी सेव की हुई जानकारी इस डिवाइस से मिटा दी है।",
  },
  faster: { "en-IN": "Okay, speaking faster.", "hi-IN": "ठीक है, तेज़ बोलती हूँ।" },
  slower: { "en-IN": "Okay, speaking slower.", "hi-IN": "ठीक है, धीरे बोलती हूँ।" },
} satisfies Record<string, Partial<Record<LangCode, string>>>;

export type PhraseKey = keyof typeof PHRASES;

/**
 * What to say when the Drishti proxy says no: its error code ("busy", "slow_down", "quota",
 * "unauthorized"), or an error carrying one (the providers' LimitError, recognised by name so
 * core needn't depend on them). Undefined for anything else.
 */
export function refusalPhrase(why: unknown): PhraseKey | undefined {
  const e = why as { name?: string; code?: unknown } | undefined;
  const code = typeof why === "string" ? why : e?.name === "LimitError" ? e.code : undefined;
  if (code === "busy" || code === "slow_down") return "busy";
  if (code === "quota") return "limit";
  if (code === "unauthorized") return "reconnect";
  return undefined;
}

/** Fixed phrases in any language: hand-checked tables first, then cached machine translation. */
export class PhraseBook {
  constructor(
    private translator: Translator,
    private cache: Cache,
  ) {}

  async get(key: PhraseKey, lang: LangCode): Promise<string> {
    const table = PHRASES[key] as Partial<Record<LangCode, string>>;
    if (table[lang]) return table[lang]!;
    const ck = `${key}|${lang}`;
    const hit = await this.cache.get(ck);
    if (hit) return hit;
    try {
      const out = await this.translator.translate(table["en-IN"]!, lang, { source: "en-IN" });
      await this.cache.set(ck, out);
      return out;
    } catch {
      return table["en-IN"]!;
    }
  }

  /** Warm every phrase for a language so speech never waits on a translation. */
  async warm(lang: LangCode) {
    await Promise.all((Object.keys(PHRASES) as PhraseKey[]).map((k) => this.get(k, lang).catch(() => "")));
  }
}
