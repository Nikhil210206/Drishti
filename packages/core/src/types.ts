/**
 * The interfaces between the platform-free core and the outside world. The dev harness
 * implements them with Playwright + Node; the extension will implement them with
 * chrome.scripting, browser WebSockets and the proxy.
 */
import type { LangCode } from "./lang.js";

// ---------- page model (produced by snapshot.js) ----------
export interface ElementInfo {
  role: string;
  name: string;
  inferred: boolean;
  tag: string;
  type: string;
  href: string;
  inForm: boolean;
  autocomplete: string;
  fieldHint: string;
}

export interface Snapshot {
  url: string;
  title: string;
  dialog: string;
  text: string;
  elements: Record<string, ElementInfo>;
  pdfLinks: { id: string; href: string; name: string }[];
  alerts: string[];
  focused: string;
  scroll: { y: number; max: number };
}

export interface SnapshotOptions {
  maxChars?: number;
  maxElements?: number;
}

/** Drives one browser tab. Element ids are the `[12]` numbers from the snapshot. */
export interface BrowserDriver {
  snapshot(): Promise<Snapshot>;
  /** Cheap fingerprint of the page structure, to notice popups/suggestions appearing. */
  signature(): Promise<string>;
  url(): Promise<string>;
  click(id: string | number): Promise<void>;
  type(id: string | number, text: string, submit?: boolean): Promise<void>;
  selectOption(id: string | number, option: string): Promise<void>;
  press(key: string): Promise<void>;
  scroll(direction: "up" | "down"): Promise<void>;
  goBack(): Promise<void>;
  navigate(url: string): Promise<void>;
  focus(id: string | number): Promise<void>;
  /** Main readable text of the page (Readability, falling back to body text). */
  readable(): Promise<{ title: string; text: string }>;
  fetchBytes(url: string): Promise<Uint8Array>;
}

// ---------- language model ----------
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, any> };
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  ms: number;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export type Reasoning = "low" | "medium" | "high" | "none";

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "required" | "none";
  reasoning?: Reasoning;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  signal?: AbortSignal;
}

export interface LLM {
  chat(opts: ChatOptions): Promise<ChatResult>;
}

// ---------- translation, documents, storage ----------
export interface TranslateOptions {
  source?: string;
  model?: "mayura:v1" | "sarvam-translate:v1";
  mode?: string;
}

export interface Translator {
  translate(text: string, target: string, opts?: TranslateOptions): Promise<string>;
}

export interface DocReader {
  /** OCR a PDF/image and return Markdown. */
  read(bytes: Uint8Array, fileName: string, language: string): Promise<string>;
}

/** Small string key-value store (phrase translations, etc.). */
export interface Cache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

// ---------- speech ----------
export interface SpeechInEvents {
  partial: (text: string, lang?: string) => void;
  final: (text: string, lang?: string, confidence?: number) => void;
  speechStart: () => void;
  speechEnd: () => void;
  status: (s: "connecting" | "open" | "closed" | "error", detail?: string) => void;
}

/** Streaming speech-to-text for one session. Audio is 16 kHz mono PCM16. */
export interface SpeechIn {
  connect(): void;
  sendAudio(pcm: Uint8Array): void;
  /** Force the current utterance to finalise (push-to-talk release). */
  flush(): void;
  close(): void;
  on<K extends keyof SpeechInEvents>(event: K, listener: SpeechInEvents[K]): unknown;
}

export interface Utterance {
  id: number;
  text: string;
  lang: LangCode;
  cancelled: boolean;
  done: Promise<void>;
  resolve: () => void;
}

export interface SpeechOutEvents {
  start: (u: Utterance) => void;
  /** Raw PCM16 audio for providers that synthesise it (Bulbul); absent for chrome.tts. */
  audio: (u: Utterance, pcm: Uint8Array, cached: boolean) => void;
  end: (u: Utterance) => void;
  cancel: () => void;
  error: (e: Error) => void;
}

export interface SpeakOptions {
  /** Only fixed phrases may be cached: arbitrary speech can contain PNRs, names or amounts. */
  cache?: boolean;
}

export interface SpeechOut {
  voice: { speaker: string; pace: number };
  readonly busy: boolean;
  speak(text: string, lang: LangCode, opts?: SpeakOptions): Utterance;
  cancelAll(): void;
  on<K extends keyof SpeechOutEvents>(event: K, listener: SpeechOutEvents[K]): unknown;
}

/** Optional saved profile for forms. Lives only on the user's device. */
export interface Profile {
  name?: string;
  age?: string;
  gender?: string;
  mobile?: string;
}
