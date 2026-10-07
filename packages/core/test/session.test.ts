import { describe, expect, it } from "vitest";
import { Agent, NavigationPolicy, VoiceSession, type SpeechIn } from "../src/index.js";
import { FakeBrowser, FakeSpeechOut, ScriptedLLM, echoTranslator, noDocs, phrases } from "./fakes.js";

const HOME = "http://localhost:5174/";

function setup() {
  const browser = new FakeBrowser({}, "about:blank");
  const policy = new NavigationPolicy();
  const book = phrases();
  const speechOut = new FakeSpeechOut();
  const events: Record<string, any>[] = [];
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
    { lang: "en-IN", homeUrl: HOME },
  );
  return { session, browser, speechOut, events };
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
