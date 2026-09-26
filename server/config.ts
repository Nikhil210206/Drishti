import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CACHE_DIR = path.join(ROOT, "cache");

export const config = {
  apiKey: process.env.SARVAM_API_KEY ?? "",
  port: Number(process.env.DRISHTI_PORT ?? 8787),
  mockPort: Number(process.env.MOCK_PORT ?? 5174),
  speaker: process.env.DRISHTI_SPEAKER ?? "kavya",
  llmModel: process.env.DRISHTI_LLM ?? "sarvam-105b",
  sttModel: process.env.DRISHTI_STT ?? "saaras:v4",
  ttsModel: "bulbul:v3",
  // Reasoning for the first step of a task; later steps run with reasoning off for speed.
  firstStepReasoning: (process.env.DRISHTI_REASONING_FIRST ?? "low") as "low" | "medium" | "high" | "none",
  maxSteps: 25,
  // Where the agent-controlled Chromium window sits (right side of the screen for the demo).
  browserWindow: {
    x: Number(process.env.BROWSER_X ?? 560),
    y: Number(process.env.BROWSER_Y ?? 0),
    width: Number(process.env.BROWSER_W ?? 1160),
    height: Number(process.env.BROWSER_H ?? 1000),
  },
  profile: {
    name: process.env.PROFILE_NAME ?? "Nikhil Kumar",
    age: process.env.PROFILE_AGE ?? "21",
    gender: process.env.PROFILE_GENDER ?? "Male",
    mobile: process.env.PROFILE_MOBILE ?? "9876543210",
  },
};

export function requireApiKey() {
  if (!config.apiKey) {
    throw new Error("SARVAM_API_KEY is missing. Copy .env.example to .env and add your key.");
  }
}

export type LangCode =
  | "hi-IN" | "bn-IN" | "ta-IN" | "te-IN" | "kn-IN" | "ml-IN"
  | "mr-IN" | "gu-IN" | "pa-IN" | "od-IN" | "en-IN";

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

/** Map any Saaras language code onto a language Bulbul can speak. */
export function toSpeakable(code: string | undefined, fallback: LangCode = "hi-IN"): LangCode {
  if (!code) return fallback;
  const c = code === "or-IN" ? "od-IN" : code;
  return (c in LANGS ? c : fallback) as LangCode;
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
