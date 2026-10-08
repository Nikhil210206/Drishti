import { describe, expect, it, vi } from "vitest";
import {
  Agent,
  Emitter,
  NavigationPolicy,
  UserDeclinedError,
  VoiceSession,
  type LLM,
  type SpeechIn,
  type SpeechInEvents,
} from "../src/index.js";
import { FakeBrowser, FakeSpeechOut, ScriptedLLM, echoTranslator, noDocs, phrases } from "./fakes.js";

const HOME = "http://localhost:5174/";

function setup({ llm = new ScriptedLLM([]) as LLM, speechIn = () => ({}) as SpeechIn } = {}) {
  const browser = new FakeBrowser({}, "about:blank");
  const policy = new NavigationPolicy();
  const book = phrases();
  const speechOut = new FakeSpeechOut();
  const events: Record<string, any>[] = [];
  const session = new VoiceSession(
    {
      agent: new Agent({ browser, llm, translator: echoTranslator, docs: noDocs, phrases: book, policy }),
      browser,
      policy,
      phrases: book,
      speechOut,
      createSpeechIn: speechIn,
      sink: { event: (e) => events.push(e), audio: () => {} },
    },
    { lang: "en-IN", homeUrl: HOME },
  );
  return { session, browser, speechOut, events };
}

/** Speech in that does nothing until the test makes the proxy refuse it. */
class FakeSpeechIn extends Emitter<SpeechInEvents> implements SpeechIn {
  connect() {}
  sendAudio() {}
  flush() {}
  close() {}
  refuse(why: string) {
    this.emit("status", "refused", why);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("VoiceSession home button", () => {
  it("opens the home page", async () => {
    const { session, browser } = setup();
    session.onMessage({ type: "home" });
    await tick();
    expect(browser.log).toEqual([`navigate ${HOME}`]);
  });

  it("refuses a URL the policy does not allow", async () => {
    const { session, browser, events } = setup();
    session.onMessage({ type: "home", url: "https://evil.example/" });
    await tick();
    expect(browser.log).toEqual([]);
    expect(events.some((e) => e.type === "error" && /may not open/.test(e.message))).toBe(true);
  });
});

describe("VoiceSession speech caching", () => {
  it("only lets fixed phrases be cached", async () => {
    const { session, speechOut } = setup();
    session.onMessage({ type: "greet" });
    await tick();
    session.say("Your PNR is 4123456789");
    expect(speechOut.spoken).toEqual([
      { text: "Hi, I'm Drishti. Tell me what you want to do.", opts: { cache: true } },
      { text: "Your PNR is 4123456789", opts: {} },
    ]);
  });
});

describe("VoiceSession quick commands", () => {
  it("speeds up speech on 'faster' without calling the agent", async () => {
    const { session, speechOut } = setup();
    session.onMessage({ type: "text", text: "faster" });
    await tick();
    expect(speechOut.voice.pace).toBe(1.35);
  });
});

describe("VoiceSession 'delete my details'", () => {
  it("asks first, then forgets the profile and tells the host to wipe its copy", async () => {
    const { session, speechOut, events } = setup();
    session.onMessage({ type: "text", text: "delete my details" });
    await tick();
    expect(events.some((e) => e.type === "awaiting" && e.kind === "confirm")).toBe(true);
    session.onMessage({ type: "confirm", answer: "yes" });
    await tick();
    await tick();
    expect(events.some((e) => e.type === "forget")).toBe(true);
    expect(speechOut.spoken.at(-1)?.text).toBe("Done. Your saved details are deleted from this device.");
  });

  it("deletes nothing on a no", async () => {
    const { session, events } = setup();
    session.onMessage({ type: "text", text: "मेरी जानकारी मिटा दो" });
    await tick();
    session.onMessage({ type: "confirm", answer: "no" });
    await tick();
    await tick();
    expect(events.some((e) => e.type === "forget")).toBe(false);
  });
});

describe("VoiceSession when the user declines what a task needs", () => {
  it("ends the task without an error or the error phrase", async () => {
    const { session, browser, speechOut, events } = setup();
    browser.snapshot = async () => {
      throw new UserDeclinedError("The user did not allow Drishti on irctc.co.in");
    };
    session.onMessage({ type: "text", text: "book a ticket" });
    await tick();
    await tick();
    expect(events.some((e) => e.type === "task" && e.state === "aborted")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(speechOut.spoken.map((s) => s.text)).not.toContain("Sorry, something went wrong. Please try again.");
  });
});

describe("VoiceSession when the Drishti proxy says no", () => {
  /** An LLM behind a proxy that refuses, the way the providers' LimitError does. */
  const refusing = (code: string): LLM => ({
    chat: async () => {
      throw Object.assign(new Error(`Drishti proxy: ${code}`), { name: "LimitError", code });
    },
  });

  it("says what the refusal means instead of 'try again'", async () => {
    for (const [code, said] of [
      ["quota", "You have used today's limit. I can help again tomorrow."],
      ["busy", "Many people are using Drishti right now. Please try again in a minute."],
      ["unauthorized", "Drishti is not connected. Please open Drishti's setup and connect again."],
    ]) {
      const { session, speechOut } = setup({ llm: refusing(code) });
      session.onMessage({ type: "text", text: "book a ticket" });
      await vi.waitFor(() => expect(speechOut.spoken.at(-1)?.text).toBe(said));
    }
  });

  it("says why the microphone was turned away, once while the user keeps trying", async () => {
    const stt = new FakeSpeechIn();
    const { session, speechOut } = setup({ speechIn: () => stt });
    session.onAudio(new Uint8Array(3200));
    stt.refuse("quota");
    stt.refuse("quota");
    await vi.waitFor(() => expect(speechOut.spoken).toHaveLength(1));
    await tick();
    expect(speechOut.spoken.map((s) => s.text)).toEqual(["You have used today's limit. I can help again tomorrow."]);
  });
});

describe("VoiceSession screen-reader output", () => {
  it("sends replies as text only, without Bulbul, and switches back on request", async () => {
    const { session, speechOut, events } = setup();
    expect(events.find((e) => e.type === "output")?.mode).toBe("voice");
    session.onMessage({ type: "settings", output: "screenreader" });
    expect(events.at(-2)).toEqual({ type: "output", mode: "screenreader" });
    session.say("Two trains found.");
    expect(speechOut.spoken).toEqual([]);
    expect(events.some((e) => e.type === "tts_start" && e.text === "Two trains found." && e.lang === "en-IN")).toBe(true);
    session.onMessage({ type: "settings", output: "voice" });
    session.say("Back to my voice.");
    expect(speechOut.spoken.map((s) => s.text)).toEqual(["Back to my voice."]);
  });

  it("can start in screen-reader mode", async () => {
    const events: Record<string, any>[] = [];
    const browser = new FakeBrowser({}, "about:blank");
    const policy = new NavigationPolicy();
    const book = phrases();
    const speechOut = new FakeSpeechOut();
    const session = new VoiceSession(
      {
        agent: new Agent({ browser, llm: new ScriptedLLM([]), translator: echoTranslator, docs: noDocs, phrases: book, policy }),
        browser,
        policy,
        phrases: book,
        speechOut,
        createSpeechIn: () => ({}) as SpeechIn,
        sink: { event: (e) => events.push(e), audio: () => {} },
      },
      { lang: "en-IN", homeUrl: HOME, output: "screenreader" },
    );
    session.onMessage({ type: "greet" });
    await tick();
    expect(speechOut.spoken).toEqual([]);
    expect(events.filter((e) => e.type === "tts_start").map((e) => e.text)).toEqual(["Hi, I'm Drishti. Tell me what you want to do."]);
  });
});
