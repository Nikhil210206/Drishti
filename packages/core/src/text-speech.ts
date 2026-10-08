import { Emitter } from "./emitter.js";
import type { LangCode } from "./lang.js";
import type { SpeechOut, SpeechOutEvents, Utterance } from "./types.js";

/** How Drishti's replies reach the user: Bulbul's voice, or the user's own screen reader. */
export type OutputMode = "voice" | "screenreader";

/**
 * Speech out for screen-reader mode: nothing is synthesised. Each reply goes to the panel as text
 * (`start`, then `end`), and the panel puts it in a live region that NVDA, JAWS or VoiceOver read
 * in the user's own voice and speed. Free, and what many screen-reader users prefer.
 */
export class TextSpeech extends Emitter<SpeechOutEvents> implements SpeechOut {
  voice = { speaker: "", pace: 1 };
  readonly busy = false;
  private nextId = 1;

  speak(text: string, lang: LangCode): Utterance {
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const u: Utterance = { id: this.nextId++, text: text.trim(), lang, cancelled: false, done, resolve };
    if (u.text) {
      this.emit("start", u);
      this.emit("end", u);
    }
    resolve();
    return u;
  }

  cancelAll() {
    this.emit("cancel");
  }
}
