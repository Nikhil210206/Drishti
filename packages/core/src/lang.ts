export type LangCode = "hi-IN" | "bn-IN" | "ta-IN" | "te-IN" | "kn-IN" | "ml-IN" | "mr-IN" | "gu-IN" | "pa-IN" | "od-IN" | "en-IN";

export interface LangInfo {
  code: LangCode;
  name: string;
  native: string;
  script: string;
}

// The 11 languages Bulbul v3 can speak. Saaras understands more; anything else replies in Hindi.
export const LANGS: Record<LangCode, LangInfo> = {
  "hi-IN": { code: "hi-IN", name: "Hindi", native: "हिन्दी", script: "Devanagari" },
  "bn-IN": { code: "bn-IN", name: "Bengali", native: "বাংলা", script: "Bengali" },
  "ta-IN": { code: "ta-IN", name: "Tamil", native: "தமிழ்", script: "Tamil" },
  "te-IN": { code: "te-IN", name: "Telugu", native: "తెలుగు", script: "Telugu" },
  "kn-IN": { code: "kn-IN", name: "Kannada", native: "ಕನ್ನಡ", script: "Kannada" },
  "ml-IN": { code: "ml-IN", name: "Malayalam", native: "മലയാളം", script: "Malayalam" },
  "mr-IN": { code: "mr-IN", name: "Marathi", native: "मराठी", script: "Devanagari" },
  "gu-IN": { code: "gu-IN", name: "Gujarati", native: "ગુજરાતી", script: "Gujarati" },
  "pa-IN": { code: "pa-IN", name: "Punjabi", native: "ਪੰਜਾਬੀ", script: "Gurmukhi" },
  "od-IN": { code: "od-IN", name: "Odia", native: "ଓଡ଼ିଆ", script: "Odia" },
  "en-IN": { code: "en-IN", name: "English", native: "English", script: "Latin" },
};

export const isLangCode = (code: unknown): code is LangCode => typeof code === "string" && code in LANGS;

/** Map any Saaras language code onto a language Bulbul can speak. */
export function toSpeakable(code: string | undefined, fallback: LangCode = "hi-IN"): LangCode {
  if (!code) return fallback;
  const c = code === "or-IN" ? "od-IN" : code;
  return isLangCode(c) ? c : fallback;
}

/** Guess the language of typed text (e.g. from Kivi) from its script. */
export function langFromScript(text: string, current: LangCode): LangCode {
  const ranges: [RegExp, LangCode][] = [
    [/[ঀ-৿]/, "bn-IN"],
    [/[஀-௿]/, "ta-IN"],
    [/[ఀ-౿]/, "te-IN"],
    [/[ಀ-೿]/, "kn-IN"],
    [/[ഀ-ൿ]/, "ml-IN"],
    [/[઀-૿]/, "gu-IN"],
    [/[਀-੿]/, "pa-IN"],
    [/[଀-୿]/, "od-IN"],
  ];
  for (const [re, code] of ranges) if (re.test(text)) return code;
  if (/[ऀ-ॿ]/.test(text)) return current === "mr-IN" ? "mr-IN" : "hi-IN";
  return current;
}

/** Pick the Doc AI language hint from the script used in a link label or file name. */
export function guessDocLanguage(label: string): string {
  const table: [RegExp, string][] = [
    [/[ঀ-৿]|bengali|bangla|\bbn\b/i, "bn-IN"],
    [/[஀-௿]|tamil|\bta\b/i, "ta-IN"],
    [/[ఀ-౿]|telugu|\bte\b/i, "te-IN"],
    [/[ಀ-೿]|kannada|\bkn\b/i, "kn-IN"],
    [/[ഀ-ൿ]|malayalam|\bml\b/i, "ml-IN"],
    [/marathi|\bmr\b/i, "mr-IN"],
    [/[ऀ-ॿ]|hindi|\bhi\b/i, "hi-IN"],
  ];
  for (const [re, code] of table) if (re.test(label)) return code;
  return "en-IN";
}
