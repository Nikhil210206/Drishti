import { describe, expect, it } from "vitest";
import { Agent, NavigationPolicy } from "../src/index.js";
import { FakeBrowser, RecordingIO, ScriptedLLM, echoTranslator, element, noDocs, page, phrases } from "./fakes.js";

const HOME = "http://localhost:5174/#/";
const PAY = "http://localhost:5174/#/pay";

function agentFor(browser: FakeBrowser, llm: ScriptedLLM) {
  return new Agent({ browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases(), policy: new NavigationPolicy() });
}
const run = (agent: Agent, io: RecordingIO) => agent.run("book it", io, new AbortController().signal);

describe("Agent safety gate", () => {
  const payPage = page(PAY, { "7": element("PAY ₹845") }, '- Amount payable ₹845\n[7] button "PAY ₹845"');

  it("does not pay when the user says no, even if the model skipped confirmation_question", async () => {
    const browser = new FakeBrowser({ [PAY]: payPage }, PAY);
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 7, narration: "" } }]]);
    const io = new RecordingIO(["nahi"]);
    await run(agentFor(browser, llm), io);
    expect(browser.log).not.toContain("click 7");
    expect(io.asked[0].kind).toBe("confirm");
    expect(io.audits()).toEqual([expect.objectContaining({ action: "click", confirmed: false })]);
  });

  it("pays after a clear yes", async () => {
    const browser = new FakeBrowser({ [PAY]: payPage }, PAY);
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 7, narration: "", confirmation_question: "Pay 845?" } }]]);
    const io = new RecordingIO(["haan"]);
    await run(agentFor(browser, llm), io);
    expect(browser.log).toContain("click 7");
    expect(io.audits()).toEqual([expect.objectContaining({ action: "click", confirmed: true })]);
  });

  it("asks again on an unclear answer and treats silence as no", async () => {
    const browser = new FakeBrowser({ [PAY]: payPage }, PAY);
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 7, narration: "" } }]]);
    const io = new RecordingIO(["umm", null]);
    await run(agentFor(browser, llm), io);
    expect(io.asked).toHaveLength(2);
    expect(browser.log).not.toContain("click 7");
  });

  it("never types into a password field", async () => {
    const login = page(HOME, { "3": element("Password", { role: "textbox", tag: "input", type: "password" }) });
    const browser = new FakeBrowser({ [HOME]: login }, HOME);
    const llm = new ScriptedLLM([[{ name: "type_text", args: { id: 3, text: "hunter2", narration: "" } }]]);
    const io = new RecordingIO();
    await run(agentFor(browser, llm), io);
    expect(browser.log.some((l) => l.startsWith("type 3"))).toBe(false);
    expect(browser.log).toContain("focus 3");
    expect(io.phrasesSaid).toContain("sensitiveField");
  });

  it("stops fill_form at the first sensitive field", async () => {
    const form = page(HOME, { "1": element("Name", { role: "textbox" }), "2": element("Enter OTP", { role: "textbox" }) });
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const llm = new ScriptedLLM([
      [
        {
          name: "fill_form",
          args: {
            fields: [
              { id: 1, value: "Asha" },
              { id: 2, value: "123456" },
            ],
            narration: "",
          },
        },
      ],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toContain("type 1 Asha");
    expect(browser.log.some((l) => l.startsWith("type 2"))).toBe(false);
  });
});

describe("Agent navigation policy", () => {
  it("blocks the navigate tool for sites off the allowlist, even if the user named them", async () => {
    const browser = new FakeBrowser({}, HOME);
    const llm = new ScriptedLLM([[{ name: "navigate", args: { url: "https://irctc.evil.com/", narration: "" } }]]);
    const io = new RecordingIO();
    await run(agentFor(browser, llm), io);
    expect(browser.log).toEqual([]);
    expect(String(llm.calls[1].messages[1].content)).toContain("BLOCKED");
  });

  it("blocks clicking a link to a disallowed site", async () => {
    const links = page(HOME, { "4": element("Win a prize", { role: "link", tag: "a", href: "https://evil.example/" }) });
    const browser = new FakeBrowser({ [HOME]: links }, HOME, { "4": "https://evil.example/" });
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 4, narration: "" } }]]);
    const io = new RecordingIO();
    await run(agentFor(browser, llm), io);
    expect(browser.log).not.toContain("click 4");
    expect(browser.current).toBe(HOME);
    expect(io.audits()[0]).toMatchObject({ action: "click", confirmed: false });
  });

  it("goes back when a click lands on a disallowed site some other way (script redirect, new tab)", async () => {
    const start = page(HOME, { "5": element("Continue") });
    const browser = new FakeBrowser({ [HOME]: start }, HOME, { "5": "https://tracker.example/landing" });
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 5, narration: "" } }]]);
    const io = new RecordingIO();
    await run(agentFor(browser, llm), io);
    expect(browser.log).toEqual(["click 5", "back"]);
    expect(browser.current).toBe(HOME);
    expect(io.audits()[0]).toMatchObject({ action: "navigate", target: "tracker.example" });
    expect(String(llm.calls[1].messages[1].content)).toContain("BLOCKED: that opened tracker.example");
  });

  it("follows links within allowed sites", async () => {
    const start = page(HOME, { "6": element("Help", { role: "link", tag: "a", href: "#/help" }) });
    const browser = new FakeBrowser({ [HOME]: start }, HOME, { "6": "http://localhost:5174/#/help" });
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 6, narration: "" } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.current).toBe("http://localhost:5174/#/help");
  });
});

describe("Agent prompt", () => {
  it("has no built-in profile", async () => {
    const browser = new FakeBrowser({}, HOME);
    const llm = new ScriptedLLM([]);
    await run(agentFor(browser, llm), new RecordingIO());
    const system = String(llm.calls[0].messages[0].content);
    expect(system).toContain("No saved profile");
    expect(system).not.toMatch(/Nikhil|9876543210/);
  });

  it("uses a profile only when one is given", async () => {
    const browser = new FakeBrowser({}, HOME);
    const llm = new ScriptedLLM([]);
    const agent = new Agent(
      { browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() },
      { profile: { name: "Asha Verma", age: "34" } },
    );
    await run(agent, new RecordingIO());
    expect(String(llm.calls[0].messages[0].content)).toContain("name Asha Verma, age 34");
  });
});
