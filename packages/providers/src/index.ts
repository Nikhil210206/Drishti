// Browser-safe: no Node APIs in anything exported here (see test/browser-safe.test.ts).
// Node-only helpers (key-header sockets, the phrase-audio disk cache) are in "@drishti/providers/node".
export { SarvamLLM, parseArgs, recoverToolCalls, stripThink } from "./sarvam/llm.js";
export { SttStream, DEFAULT_KEYTERMS } from "./sarvam/stt.js";
export { TtsEngine, TTS_SAMPLE_RATE, cleanForSpeech, type AudioCache } from "./sarvam/tts.js";
export { SarvamTranslator } from "./sarvam/translate.js";
export { SarvamDocReader } from "./sarvam/vision.js";
export { costMeter } from "./sarvam/cost.js";
export { LimitError, browserSocket, type SarvamAuth, type SocketFactory } from "./sarvam/key.js";
export { resample, pcmToWav } from "./audio.js";
export { toBase64, fromBase64 } from "./bytes.js";
