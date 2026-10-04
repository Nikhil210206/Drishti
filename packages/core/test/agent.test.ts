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
    const form = page(HOME, { "1": element("Coach", { role: "textbox" }), "2": element("Enter OTP", { role: "textbox" }) });
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const llm = new ScriptedLLM([
      [
        {
          name: "fill_form",
          args: {
            fields: [
              { id: 1, value: "S4" },
              { id: 2, value: "123456" },
            ],
            narration: "",
          },
        },
      ],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toContain("type 1 S4");
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

describe("Agent tool guards", () => {
  const lastHistory = (llm: ScriptedLLM, i: number) => String(llm.calls[i].messages[1].content);

  it("ignores a model-invented confirmation on a clearly safe control", async () => {
    const form = page(HOME, { "3": element("SEARCH TRAINS"), "4": element("Chennai Central", { role: "option" }) });
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const llm = new ScriptedLLM([
      [{ name: "click", args: { id: 4, narration: "", confirmation_question: "Select Chennai Central?" } }],
      [{ name: "click", args: { id: 3, narration: "", confirmation_question: "Search now?" } }],
    ]);
    const io = new RecordingIO();
    await run(agentFor(browser, llm), io);
    expect(io.asked).toEqual([]);
    expect(browser.log).toEqual(["click 4", "click 3"]);
    expect(lastHistory(llm, 2)).not.toContain("final step");
  });

  it("still honours a model-added confirmation on an ordinary button", async () => {
    const form = page(HOME, { "5": element("Continue") });
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 5, narration: "", confirmation_question: "Continue to payment?" } }]]);
    const io = new RecordingIO(["no"]);
    await run(agentFor(browser, llm), io);
    expect(io.asked).toHaveLength(1);
    expect(browser.log).not.toContain("click 5");
  });

  it("refuses the same action twice on an unchanged page", async () => {
    const form = page(HOME, { "6": element("Apply filter") });
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const click = { name: "click", args: { id: 6, narration: "" } };
    const llm = new ScriptedLLM([[click], [click]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log.filter((l) => l === "click 6")).toHaveLength(1);
    expect(lastHistory(llm, 2)).toContain("REFUSED: you already did exactly this");
  });

  it("refuses select_option on a text box with a hint", async () => {
    const form = page(HOME, { "8": element("TO", { role: "textbox", tag: "input" }) });
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const llm = new ScriptedLLM([[{ name: "select_option", args: { id: 8, option: "Bangalore", narration: "" } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual([]);
    expect(lastHistory(llm, 1)).toContain("is a text box, not a dropdown");
  });

  it("stops fill_form at a control that is not a text field", async () => {
    const form = page(HOME, { "1": element("Coach", { role: "textbox" }), "2": element("Tue, 6 Oct", { role: "clickable" }) });
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const llm = new ScriptedLLM([
      [
        {
          name: "fill_form",
          args: {
            fields: [
              { id: 1, value: "S4" },
              { id: 2, value: "6" },
            ],
            narration: "",
          },
        },
      ],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["type 1 S4"]);
    expect(lastHistory(llm, 1)).toContain("not a text field");
  });

  it("says when typing into a lookup box brought no suggestions", async () => {
    const form = page(HOME, { "8": element("TO", { role: "textbox", tag: "input" }) });
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const llm = new ScriptedLLM([[{ name: "type_text", args: { id: 8, text: "Bangalore", narration: "" } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(lastHistory(llm, 1)).toContain("no suggestions appeared");
  });

  it("warns when the step budget is nearly spent", async () => {
    const browser = new FakeBrowser({}, HOME);
    const llm = new ScriptedLLM(
      Array.from({ length: 3 }, (_, i) => [{ name: "scroll", args: { direction: i % 2 ? "up" : "down", narration: "" } }]),
    );
    const agent = new Agent({ browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() }, { maxSteps: 4 });
    await run(agent, new RecordingIO());
    expect(lastHistory(llm, 1)).toContain("STEP BUDGET: only 3 step(s) left");
  });
});

describe("Agent: the user's own words", () => {
  const complaintPage = () =>
    page(HOME, { "21": element("Describe your complaint", { role: "textbox", tag: "textarea" }), "22": element("SUBMIT COMPLAINT") });

  it("refuses to type complaint text the user never said", async () => {
    const browser = new FakeBrowser({ [HOME]: complaintPage() }, HOME);
    const llm = new ScriptedLLM([
      [{ name: "type_text", args: { id: 21, text: "The food was cold and stale and the staff were rude to us.", narration: "" } }],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual([]);
    expect(String(llm.calls[1].messages[1].content)).toContain("Never write the user's message yourself");
  });

  it("allows text the user actually said", async () => {
    const browser = new FakeBrowser({ [HOME]: complaintPage() }, HOME);
    const said = "The food on train 12639 was cold and stale yesterday";
    const llm = new ScriptedLLM([[{ name: "type_text", args: { id: 21, text: said, narration: "" } }]]);
    await new Agent({ browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() }).run(
      `File a complaint: ${said}`,
      new RecordingIO(),
      new AbortController().signal,
    );
    expect(browser.log).toContain(`type 21 ${said}`);
  });
});

describe("Agent: empty or cut-off model replies", () => {
  it("retries once with a nudge instead of giving up", async () => {
    const browser = new FakeBrowser({}, HOME);
    let n = 0;
    const llm = {
      calls: [] as any[],
      async chat(opts: any) {
        this.calls.push(opts);
        n++;
        if (n === 1) return { content: "", toolCalls: [], ms: 1, usage: { prompt_tokens: 10, completion_tokens: 600 } };
        return { content: "", toolCalls: [{ id: "x", name: "done", args: { speech: "ok" } }], ms: 1 };
      },
    };
    const r = await new Agent({ browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() }).run(
      "hi",
      new RecordingIO(),
      new AbortController().signal,
    );
    expect(r).toMatchObject({ outcome: "done", speech: "ok" });
    expect(llm.calls[1].messages[1].content).toContain("YOUR LAST REPLY WAS EMPTY OR CUT OFF");
    expect(llm.calls[0].maxTokens).toBe(600);
  });
});

describe("Agent: confirmation readback", () => {
  it("reads back what the page says, even when the model's question is wrong", async () => {
    const text = [
      "- Review your journey Train Pearl City Vande Bharat Express (11616) Date Tue, 6 Oct, 2026 Class Chair Car (CC) Total ₹490",
      '[56] clickable "PROCEED TO PAY"',
    ].join("\n");
    const review = page("http://localhost:5174/#/review", { "56": element("PROCEED TO PAY") }, text);
    const browser = new FakeBrowser({ "http://localhost:5174/#/review": review }, "http://localhost:5174/#/review");
    const llm = new ScriptedLLM([
      [{ name: "click", args: { id: 56, narration: "", confirmation_question: "Pay 490 rupees for 12 October?" } }],
    ]);
    const io = new RecordingIO(["no"]);
    await run(agentFor(browser, llm), io);
    expect(io.asked[0].q).toContain("Pay 490 rupees for 12 October?");
    expect(io.asked[0].q).toContain("The page says:");
    expect(io.asked[0].q).toContain("Date Tue, 6 Oct, 2026");
  });
});

describe("Agent: custom dropdowns", () => {
  const HELP = "http://localhost:5174/#/help";
  const closed = page(HELP, { "19": element("Select category ▾", { role: "clickable", tag: "div" }) });
  const open = page(HELP, {
    "19": element("Select category ▾", { role: "clickable", tag: "div" }),
    "30": element("Refund", { role: "clickable", tag: "div" }),
    "31": element("Cleanliness", { role: "clickable", tag: "div" }),
  });

  it("opens the list and clicks the closest real option", async () => {
    const browser = new FakeBrowser({ [HELP]: closed, [`${HELP}?open`]: open }, HELP, { "19": `${HELP}?open` });
    // The fake changes URL on open; keep the open list on the same "page" for the comparison.
    browser.pages[HELP] = closed;
    const llm = new ScriptedLLM([[{ name: "select_option", args: { id: 19, option: "cleanliness issue", narration: "" } }]]);
    const agent = agentFor(browser, llm);
    const snapshots = [closed, open, open];
    browser.snapshot = async () => snapshots.shift() ?? open;
    await run(agent, new RecordingIO());
    expect(browser.log).toEqual(["click 19", "click 31"]);
  });

  it("lists the real options when nothing matches", async () => {
    const browser = new FakeBrowser({ [HELP]: closed }, HELP);
    const snapshots = [closed, open, open];
    browser.snapshot = async () => snapshots.shift() ?? open;
    const llm = new ScriptedLLM([[{ name: "select_option", args: { id: 19, option: "Help & Complaints", narration: "" } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["click 19"]);
    expect(String(llm.calls[1].messages[1].content)).toContain('Options: [30] "Refund", [31] "Cleanliness"');
  });
});

describe("Agent: no invented personal details", () => {
  const form = () =>
    page(HOME, { "35": element("Name", { role: "textbox", tag: "input" }), "36": element("Age", { role: "textbox", tag: "input" }) });

  it("refuses a made-up passenger name", async () => {
    const browser = new FakeBrowser({ [HOME]: form() }, HOME);
    const llm = new ScriptedLLM([
      [
        {
          name: "fill_form",
          args: {
            fields: [
              { id: 35, value: "Passenger 1" },
              { id: 36, value: "30" },
            ],
            narration: "",
          },
        },
      ],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual([]);
    expect(String(llm.calls[1].messages[1].content)).toContain("Never invent names");
  });

  it("allows details the user gave when asked", async () => {
    const browser = new FakeBrowser({ [HOME]: form() }, HOME);
    const llm = new ScriptedLLM([
      [{ name: "ask_user", args: { question: "Passenger name and age?" } }],
      [
        {
          name: "fill_form",
          args: {
            fields: [
              { id: 35, value: "Asha Verma" },
              { id: 36, value: "34" },
            ],
            narration: "",
          },
        },
      ],
    ]);
    await run(agentFor(browser, llm), new RecordingIO(["Asha Verma, 34 years"]));
    expect(browser.log).toEqual(["type 35 Asha Verma", "type 36 34"]);
  });

  it("allows the saved profile", async () => {
    const browser = new FakeBrowser({ [HOME]: form() }, HOME);
    const llm = new ScriptedLLM([[{ name: "fill_form", args: { fields: [{ id: 35, value: "Asha Verma" }], narration: "" } }]]);
    const agent = new Agent(
      { browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() },
      { profile: { name: "Asha Verma" } },
    );
    await run(agent, new RecordingIO());
    expect(browser.log).toEqual(["type 35 Asha Verma"]);
  });
});
