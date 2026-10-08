import { LANGS, isLangCode, langFromScript, toSpeakable, type LangCode } from "./lang.js";
import type { BrowserDriver, SpeechIn, SpeechOut } from "./types.js";
import type { Agent, AgentIO } from "./agent/orchestrator.js";
import type { PhraseBook, PhraseKey } from "./agent/phrases.js";
import type { NavigationPolicy } from "./agent/policy.js";
import { quickCommand, yesNo } from "./agent/safety.js";
import { TextSpeech, type OutputMode } from "./text-speech.js";

type Timer = ReturnType<typeof setTimeout>;
type Waiter = { kind: "question" | "confirm"; resolve: (t: string | null) => void; timer: Timer };

/** The user said no to something the task needed (a site, a permission): stop without an error. */
export class UserDeclinedError extends Error {
  override name = "UserDeclined";
}

export interface SessionDeps {
  agent: Agent;
  browser: BrowserDriver;
  policy: NavigationPolicy;
  phrases: PhraseBook;
  speechOut: SpeechOut;
  createSpeechIn: () => SpeechIn;
  /** Where panel events (JSON) and synthesised audio (PCM16) go. */
  sink: { event(e: Record<string, unknown>): void; audio(pcm: Uint8Array): void };
}

export interface SessionOptions {
  lang?: LangCode;
  /** Page the panel's home button opens. Must pass the navigation policy. */
  homeUrl: string;
  /** Replies in Bulbul's voice (default) or as text for the user's screen reader. */
  output?: OutputMode;
}

/**
 * One connected Drishti panel: mic in, speech out, and the agent in between. Platform-free:
 * the host feeds it panel messages and audio and forwards what it emits.
 */
export class VoiceSession implements AgentIO {
  lang: LangCode;
  private langLocked = false;
  private stt?: SpeechIn;
  /** Where replies go now: Bulbul (`voiceOut`) or the screen reader (`textOut`). */
  private tts: SpeechOut;
  private voiceOut: SpeechOut;
  private textOut = new TextSpeech();
  private task?: { abort: AbortController; text: string };
  private waiter?: Waiter;
  private composeWaiter?: { resolve: (t: string | null) => void; timer: Timer };
  private conversation: string[] = [];
  private interjections: string[] = [];
  private lastSpoken = "";
  private lastFinalAt = 0;
  private firstAudioPending = false;

  constructor(
    private deps: SessionDeps,
    private opts: SessionOptions,
  ) {
    this.lang = opts.lang ?? "hi-IN";
    this.voiceOut = deps.speechOut;
    this.tts = opts.output === "screenreader" ? this.textOut : this.voiceOut;
    this.wireTts(this.voiceOut);
    this.wireTts(this.textOut);
    this.emit({ type: "lang", code: this.lang, name: LANGS[this.lang].name, native: LANGS[this.lang].native });
    this.emit({ type: "voice", pace: this.voiceOut.voice.pace, speaker: this.voiceOut.voice.speaker });
    this.emit({ type: "output", mode: this.output });
    void deps.phrases.warm(this.lang);
  }

  get output(): OutputMode {
    return this.tts === this.textOut ? "screenreader" : "voice";
  }

  // ---------- panel messages ----------
  onAudio(pcm: Uint8Array) {
    if (!this.stt) this.startStt();
    this.stt!.sendAudio(pcm);
  }

  onMessage(msg: any) {
    switch (msg?.type) {
      case "ptt":
        if (msg.down) this.bargeIn();
        else this.stt?.flush();
        break;
      case "text":
        if (typeof msg.text === "string" && msg.text.trim()) {
          this.handleUtterance(msg.text.trim(), langFromScript(msg.text, this.lang), 1, msg.source ?? "typed");
        }
        break;
      case "stop":
        void this.stopAll(true);
        break;
      case "stop_speech":
        this.bargeIn();
        break;
      case "confirm":
        if (this.waiter) this.resolveWaiter(msg.answer === "yes" ? "yes" : "no");
        break;
      case "compose_submit":
        if (this.composeWaiter) {
          clearTimeout(this.composeWaiter.timer);
          const w = this.composeWaiter;
          this.composeWaiter = undefined;
          this.emit({ type: "compose_close" });
          w.resolve(typeof msg.text === "string" && msg.text.trim() ? msg.text.trim() : null);
        }
        break;
      case "settings":
        if (typeof msg.pace === "number") this.voiceOut.voice.pace = clamp(msg.pace, 0.6, 2);
        if (typeof msg.speaker === "string") this.voiceOut.voice.speaker = msg.speaker;
        if (msg.lang === "auto") this.langLocked = false;
        else if (isLangCode(msg.lang)) {
          this.langLocked = false;
          this.setLang(msg.lang);
          this.langLocked = true;
        }
        if (msg.lang) this.emit({ type: "lang_lock", locked: this.langLocked });
        if ((msg.output === "voice" || msg.output === "screenreader") && msg.output !== this.output) {
          this.tts.cancelAll();
          this.tts = msg.output === "screenreader" ? this.textOut : this.voiceOut;
          this.emit({ type: "output", mode: this.output });
        }
        this.emit({ type: "voice", pace: this.voiceOut.voice.pace, speaker: this.voiceOut.voice.speaker });
        break;
      case "greet":
        void this.sayPhrase("ready");
        break;
      case "home": {
        // The panel may name a page, but it goes through the same policy as the agent.
        const url = typeof msg.url === "string" && msg.url ? msg.url : this.opts.homeUrl;
        if (!this.deps.policy.allows(url)) {
          this.emit({ type: "error", message: `Drishti may not open ${url}` });
          break;
        }
        this.deps.browser.navigate(url).catch((e) => this.emit({ type: "error", message: `Browser: ${e?.message ?? e}` }));
        break;
      }
    }
  }

  close() {
    this.stt?.close();
    this.voiceOut.cancelAll();
    this.textOut.cancelAll();
    this.task?.abort.abort();
  }

  // ---------- speech in ----------
  private startStt() {
    const stt = this.deps.createSpeechIn();
    this.stt = stt;
    stt.on("status", (s, detail) => this.emit({ type: "status", stt: s, detail }));
    stt.on("partial", (text, lang) => this.emit({ type: "partial", text, lang }));
    stt.on("speechStart", () => this.emit({ type: "vad", speaking: true }));
    stt.on("speechEnd", () => this.emit({ type: "vad", speaking: false }));
    stt.on("final", (text, lang, conf) => this.handleUtterance(text, lang, conf, "voice"));
    stt.connect();
  }

  private handleUtterance(text: string, detected: string | undefined, confidence = 1, source: string) {
    this.lastFinalAt = Date.now();
    this.firstAudioPending = true;
    if (detected && confidence >= 0.6) this.setLang(toSpeakable(detected, this.lang));
    this.emit({ type: "final", text, lang: detected, source });

    const cmd = quickCommand(text);
    if (cmd === "stop") return void this.stopAll(true);
    if (cmd === "repeat" && this.lastSpoken) return void this.say(this.lastSpoken);
    if (cmd === "forget") return void this.forget();
    if (cmd === "faster" || cmd === "slower") {
      this.voiceOut.voice.pace = clamp(this.voiceOut.voice.pace + (cmd === "faster" ? 0.25 : -0.25), 0.6, 2);
      this.emit({ type: "voice", pace: this.voiceOut.voice.pace, speaker: this.voiceOut.voice.speaker });
      return void this.sayPhrase(cmd);
    }
    if (this.waiter) return this.resolveWaiter(text);
    if (this.composeWaiter) return; // compose text comes from the dictation box, not speech
    this.conversation.push(`User: ${text}`);
    if (this.task) {
      this.interjections.push(text);
      return;
    }
    void this.runTask(text);
  }

  private setLang(code: LangCode) {
    if (code === this.lang || this.langLocked) return;
    this.lang = code;
    this.emit({ type: "lang", code, name: LANGS[code].name, native: LANGS[code].native });
    void this.deps.phrases.warm(code);
  }

  private async runTask(text: string) {
    const abort = new AbortController();
    this.task = { abort, text };
    this.interjections = [];
    this.emit({ type: "task", state: "running", text });
    const t0 = Date.now();
    try {
      const r = await this.deps.agent.run(text, this, abort.signal);
      if (r.speech) this.conversation.push(`Drishti: ${r.speech}`);
      this.emit({ type: "task", state: r.outcome, text, ms: Date.now() - t0 });
    } catch (e: any) {
      if (e?.name === "UserDeclined") {
        this.emit({ type: "task", state: "aborted", text });
        return;
      }
      this.emit({ type: "error", message: e?.message ?? String(e) });
      this.emit({ type: "task", state: "error", text });
      if (!abort.signal.aborted) await this.sayPhrase("error");
    } finally {
      if (this.task?.abort === abort) this.task = undefined;
      this.conversation = this.conversation.slice(-8);
    }
  }

  private async stopAll(speak: boolean) {
    this.tts.cancelAll();
    this.task?.abort.abort();
    this.task = undefined;
    if (this.waiter) this.resolveWaiter(null);
    if (this.composeWaiter) {
      clearTimeout(this.composeWaiter.timer);
      this.composeWaiter.resolve(null);
      this.composeWaiter = undefined;
      this.emit({ type: "compose_close" });
    }
    this.emit({ type: "task", state: "aborted" });
    if (speak) await this.sayPhrase("stopped");
  }

  /**
   * "Delete my details": after a yes, the agent forgets the profile and the conversation, and the
   * host (which owns storage) is told to wipe its copy. Irreversible, so it is never done on a hunch.
   */
  private async forget() {
    if (this.task) await this.stopAll(false);
    const answer = await this.ask(await this.deps.phrases.get("forgetConfirm", this.lang), "confirm");
    if (answer === null || yesNo(answer) !== "yes") return void (await this.sayPhrase("cancelled"));
    this.deps.agent.setProfile(undefined);
    this.conversation = [];
    this.emit({ type: "forget" });
    await this.sayPhrase("forgotten");
  }

  private bargeIn() {
    if (this.tts.busy) this.tts.cancelAll();
  }

  private resolveWaiter(text: string | null) {
    const w = this.waiter!;
    clearTimeout(w.timer);
    this.waiter = undefined;
    this.emit({ type: "awaiting", kind: null });
    w.resolve(text);
  }

  // ---------- speech out ----------
  private wireTts(out: SpeechOut) {
    out.on("start", (u) => this.emit({ type: "tts_start", id: u.id, text: u.text, lang: u.lang }));
    out.on("audio", (u, pcm) => {
      if (u.cancelled) return;
      if (this.firstAudioPending) {
        this.firstAudioPending = false;
        this.emit({ type: "metric", name: "turn_latency", ms: Date.now() - this.lastFinalAt });
      }
      this.deps.sink.audio(pcm);
    });
    out.on("end", (u) => this.emit({ type: "tts_end", id: u.id }));
    out.on("cancel", () => this.emit({ type: "tts_stop" }));
    out.on("error", (e) => this.emit({ type: "error", message: `TTS: ${e.message}` }));
  }

  // ---------- AgentIO ----------
  say(text: string) {
    if (!text?.trim()) return;
    this.lastSpoken = text;
    this.tts.speak(text, this.lang);
  }

  async sayPhrase(key: PhraseKey) {
    const text = await this.deps.phrases.get(key, this.lang);
    this.lastSpoken = text;
    this.tts.speak(text, this.lang, { cache: true });
  }

  ask(question: string, kind: "question" | "confirm"): Promise<string | null> {
    this.say(question);
    if (this.waiter) this.resolveWaiter(null);
    this.emit({ type: "awaiting", kind, question });
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.waiter && this.resolveWaiter(null), 60000);
      this.waiter = { kind, resolve, timer };
    });
  }

  compose(prompt: string, field: string): Promise<string | null> {
    this.say(prompt);
    this.emit({ type: "compose_open", prompt, field });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.composeWaiter = undefined;
        this.emit({ type: "compose_close" });
        resolve(null);
      }, 180000);
      this.composeWaiter = { resolve, timer };
    });
  }

  emit(event: Record<string, unknown>) {
    this.deps.sink.event(event);
  }

  recent() {
    return this.conversation.slice(-6);
  }

  takeInterjections() {
    const out = this.interjections;
    this.interjections = [];
    return out;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));
