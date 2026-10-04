import {
  MemoryCache,
  PhraseBook,
  type AgentIO,
  type BrowserDriver,
  type ChatOptions,
  type ChatResult,
  type DocReader,
  type ElementInfo,
  type LLM,
  type PhraseKey,
  type Snapshot,
  type SpeakOptions,
  type SpeechOut,
  type SpeechOutEvents,
  type ToolCall,
  type Translator,
  type Utterance,
} from "../src/index.js";

export const element = (name: string, extra: Partial<ElementInfo> = {}): ElementInfo => ({
  role: "button",
  name,
  inferred: false,
  tag: "button",
  type: "",
  href: "",
  inForm: false,
  autocomplete: "",
  fieldHint: "",
  ...extra,
});

export const page = (url: string, elements: Record<string, ElementInfo> = {}, text = ""): Snapshot => ({
  url,
  title: url,
  dialog: "",
  text:
    text ||
    Object.entries(elements)
      .map(([id, e]) => `[${id}] ${e.role} "${e.name}"`)
      .join("\n"),
  elements,
  pdfLinks: [],
  alerts: [],
  focused: "",
  scroll: { y: 0, max: 0 },
});

/** A browser made of canned pages. `links` says where clicking an element id takes you. */
export class FakeBrowser implements BrowserDriver {
  current: string;
  history: string[] = [];
  log: string[] = [];

  constructor(
    public pages: Record<string, Snapshot>,
    start: string,
    public links: Record<string, string> = {},
  ) {
    this.current = start;
  }

  private go(url: string) {
    this.history.push(this.current);
    this.current = url;
  }

  async snapshot() {
    return this.pages[this.current] ?? page(this.current);
  }
  async signature() {
    return this.current;
  }
  async url() {
    return this.current;
  }
  async click(id: string | number) {
    this.log.push(`click ${id}`);
    const to = this.links[String(id)];
    if (to) this.go(to);
  }
  async type(id: string | number, text: string) {
    this.log.push(`type ${id} ${text}`);
  }
  async selectOption(id: string | number, option: string) {
    this.log.push(`select ${id} ${option}`);
  }
  async press(key: string) {
    this.log.push(`press ${key}`);
  }
  async scroll() {}
  async goBack() {
    this.log.push("back");
    const prev = this.history.pop();
    if (prev) this.current = prev;
  }
  async navigate(url: string) {
    this.log.push(`navigate ${url}`);
    this.go(url);
  }
  async focus(id: string | number) {
    this.log.push(`focus ${id}`);
  }
  async readable() {
    return { title: "", text: "" };
  }
  async fetchBytes() {
    return new Uint8Array();
  }
}

/** Replies with one scripted batch of tool calls per step, then `done`. */
export class ScriptedLLM implements LLM {
  calls: ChatOptions[] = [];
  constructor(private steps: Omit<ToolCall, "id">[][]) {}

  async chat(opts: ChatOptions): Promise<ChatResult> {
    this.calls.push(opts);
    const batch = this.steps.shift() ?? [{ name: "done", args: { speech: "finished" } }];
    return { content: "", toolCalls: batch.map((c, i) => ({ id: `c${i}`, ...c })), ms: 1 };
  }
}

export const echoTranslator: Translator = { translate: async (text, target) => `[${target}] ${text}` };
export const noDocs: DocReader = { read: async () => "" };
export const phrases = () => new PhraseBook(echoTranslator, new MemoryCache());

export class RecordingIO implements AgentIO {
  lang = "en-IN" as const;
  said: string[] = [];
  phrasesSaid: PhraseKey[] = [];
  events: Record<string, any>[] = [];
  asked: { q: string; kind: string }[] = [];
  constructor(private answers: (string | null)[] = []) {}
  say(t: string) {
    this.said.push(t);
  }
  async sayPhrase(k: PhraseKey) {
    this.phrasesSaid.push(k);
  }
  async ask(q: string, kind: "question" | "confirm") {
    this.asked.push({ q, kind });
    return this.answers.length ? this.answers.shift()! : null;
  }
  async compose(): Promise<string | null> {
    return null;
  }
  emit(e: Record<string, unknown>) {
    this.events.push(e);
  }
  recent() {
    return [];
  }
  takeInterjections() {
    return [];
  }
  audits() {
    return this.events.filter((e) => e.type === "audit");
  }
}

/** SpeechOut that records what it was asked to say (and whether it may cache it). */
export class FakeSpeechOut implements SpeechOut {
  voice = { speaker: "kavya", pace: 1.1 };
  busy = false;
  spoken: { text: string; opts: SpeakOptions }[] = [];
  private listeners = new Map<keyof SpeechOutEvents, ((...a: any[]) => void)[]>();
  private nextId = 1;

  speak(text: string, lang: Utterance["lang"], opts: SpeakOptions = {}): Utterance {
    this.spoken.push({ text, opts });
    const u: Utterance = { id: this.nextId++, text, lang, cancelled: false, done: Promise.resolve(), resolve: () => {} };
    this.listeners.get("start")?.forEach((l) => l(u));
    return u;
  }
  cancelAll() {}
  on<K extends keyof SpeechOutEvents>(event: K, listener: SpeechOutEvents[K]) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener as (...a: any[]) => void]);
    return this;
  }
}
