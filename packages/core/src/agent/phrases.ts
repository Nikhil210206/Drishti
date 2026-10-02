import type { LangCode } from "../lang.js";
import type { Cache, Translator } from "../types.js";

/** Fixed things Drishti says. English + hand-checked Hindi; other languages come from Mayura (cached). */
export const PHRASES = {
  ready: {
    "en-IN": "Hi, I'm Drishti. Tell me what you want to do.",
    "hi-IN": "नमस्ते, मैं दृष्टि हूँ। बताइए, क्या करना है?",
  },
  oneMoment: { "en-IN": "One moment.", "hi-IN": "एक सेकंड।" },
  confirmGeneric: { "en-IN": "Should I go ahead?", "hi-IN": "क्या मैं आगे बढ़ूँ?" },
  sayYesNo: { "en-IN": "Please say yes or no.", "hi-IN": "कृपया हाँ या ना बोलिए।" },
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
  stuck: {
    "en-IN": "I'm stuck on this page. Tell me what to try next.",
    "hi-IN": "मैं इस पेज पर अटक गई हूँ। बताइए, आगे क्या करूँ?",
  },
  faster: { "en-IN": "Okay, speaking faster.", "hi-IN": "ठीक है, तेज़ बोलती हूँ।" },
  slower: { "en-IN": "Okay, speaking slower.", "hi-IN": "ठीक है, धीरे बोलती हूँ।" },
} satisfies Record<string, Partial<Record<LangCode, string>>>;

export type PhraseKey = keyof typeof PHRASES;

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
