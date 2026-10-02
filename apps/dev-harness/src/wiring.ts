import path from "node:path";
import { Agent, DEFAULT_ALLOWED_DOMAINS, NavigationPolicy, PhraseBook, type AgentOptions, type BrowserDriver } from "@drishti/core";
import { SarvamDocReader, SarvamLLM, SarvamTranslator, SttStream, TtsEngine } from "@drishti/providers";
import { CACHE_DIR, config } from "./config.js";
import { FileCache } from "./file-cache.js";

/** The Sarvam-backed providers, built once per process. */
export function sarvamProviders() {
  const auth = { apiKey: config.apiKey };
  const translator = new SarvamTranslator(auth);
  return {
    llm: new SarvamLLM({ ...auth, model: config.llmModel }),
    translator,
    docs: new SarvamDocReader(auth),
    phrases: new PhraseBook(translator, new FileCache(path.join(CACHE_DIR, "phrases.json"))),
    createSpeechIn: () => new SttStream({ ...auth, model: config.sttModel }),
    createSpeechOut: () => new TtsEngine({ ...auth, model: config.ttsModel, speaker: config.speaker, cacheDir: CACHE_DIR }),
  };
}

export type Providers = ReturnType<typeof sarvamProviders>;

export function navigationPolicy() {
  return new NavigationPolicy([...DEFAULT_ALLOWED_DOMAINS, ...config.extraDomains]);
}

export function createAgent(browser: BrowserDriver, p: Providers, policy = navigationPolicy(), opts: AgentOptions = {}) {
  return new Agent(
    { browser, llm: p.llm, translator: p.translator, docs: p.docs, phrases: p.phrases, policy },
    { maxSteps: config.maxSteps, firstStepReasoning: config.firstStepReasoning, profile: config.profile, ...opts },
  );
}
