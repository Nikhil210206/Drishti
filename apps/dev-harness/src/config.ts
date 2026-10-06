import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { isLangCode, type LangCode, type Profile, type Reasoning } from "@drishti/core";

/** Repository root (the harness serves fixtures and writes caches relative to it). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// The root .env, wherever the process started (`npm run check -w …` starts in apps/dev-harness).
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
export const CACHE_DIR = path.join(ROOT, "cache");
export const FIXTURES = path.join(ROOT, "fixtures");

const env = process.env;

/** Optional profile for forms, only if set in .env. There is no built-in default. */
function profileFromEnv(): Profile | undefined {
  const p: Profile = { name: env.PROFILE_NAME, age: env.PROFILE_AGE, gender: env.PROFILE_GENDER, mobile: env.PROFILE_MOBILE };
  return Object.values(p).some((v) => v?.trim()) ? p : undefined;
}

export const config = {
  apiKey: env.SARVAM_API_KEY ?? "",
  port: Number(env.DRISHTI_PORT ?? 8787),
  mockPort: Number(env.MOCK_PORT ?? 5174),
  speaker: env.DRISHTI_SPEAKER ?? "kavya",
  llmModel: env.DRISHTI_LLM ?? "sarvam-105b",
  sttModel: env.DRISHTI_STT ?? "saaras:v4",
  ttsModel: "bulbul:v3",
  lang: (isLangCode(env.DRISHTI_LANG) ? env.DRISHTI_LANG : "hi-IN") as LangCode,
  // Reasoning for the first step of a task; later steps run with reasoning off for speed.
  firstStepReasoning: (env.DRISHTI_REASONING_FIRST ?? "none") as Reasoning,
  maxSteps: 25,
  headless: env.DRISHTI_HEADLESS === "1",
  // Where the agent-controlled Chromium window sits (right side of the screen for the demo).
  browserWindow: {
    x: Number(env.BROWSER_X ?? 560),
    y: Number(env.BROWSER_Y ?? 0),
    width: Number(env.BROWSER_W ?? 1160),
    height: Number(env.BROWSER_H ?? 1000),
  },
  profile: profileFromEnv(),
  /** Extra domains the agent may open, comma-separated (e.g. "irctc.co.in,indianrail.gov.in"). */
  extraDomains: (env.DRISHTI_ALLOW ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean),
};

export function requireApiKey() {
  if (!config.apiKey) {
    throw new Error("SARVAM_API_KEY is missing. Copy .env.example to .env and add your key.");
  }
}
