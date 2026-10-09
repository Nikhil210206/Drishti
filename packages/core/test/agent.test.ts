import { describe, expect, it } from "vitest";
import { Agent, NavigationPolicy } from "../src/index.js";
import { batchStop, namesAmount } from "../src/agent/orchestrator.js";
import { FakeBrowser, RecordingIO, ScriptedLLM, echoTranslator, element, noDocs, page, phrases } from "./fakes.js";
import type { ChatOptions, ChatResult, LLM } from "../src/index.js";

const HOME = "http://localhost:5174/#/";
const PAY = "http://localhost:5174/#/pay";

function agentFor(browser: FakeBrowser, llm: ScriptedLLM) {
  return new Agent({ browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases(), policy: new NavigationPolicy() });
}
const run = (agent: Agent, io: RecordingIO, task = "book it") => agent.run(task, io, new AbortController().signal);

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

  it("says a payment from the page, not the model's question", async () => {
    // A live run asked "Do you want to go back?" before PAY ₹220, and the scripted user said yes.
    const browser = new FakeBrowser({ [PAY]: payPage }, PAY);
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 7, narration: "", confirmation_question: "Do you want to go back?" } }]]);
    const io = new RecordingIO(["nahi"]);
    await run(agentFor(browser, llm), io);
    expect(io.asked[0].q).toBe("Please check before I pay: ₹845. Should I go ahead?");
    expect(browser.log).not.toContain("click 7");
  });

  it("knows when a question names the amount, in any Indian script", () => {
    expect(namesAmount("Do you want to go back?", "PAY ₹220", "")).toBe(false);
    expect(namesAmount("₹২২০ দিয়ে টিকিট বুক করব?", "PAY ₹220", "")).toBe(true);
    expect(namesAmount("₹200 দিয়ে book করব কি?", "book ticket (SL ₹200 66)", "")).toBe(true);
    expect(namesAmount("Pay 1,240 rupees?", "PROCEED TO PAY", "Total ₹1,240")).toBe(true);
    expect(namesAmount("Continue?", "PROCEED TO PAY", "Total ₹1,240")).toBe(false);
    expect(namesAmount("Pay ₹2200?", "PAY ₹220", "")).toBe(false); // another number
    expect(namesAmount("Submit the complaint?", "SUBMIT", "Category Cleanliness")).toBe(true); // nothing priced
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

  it("sends an answer about another day's results back once, then lets it through", async () => {
    const results = "http://localhost:5174/#/results?from=CSMT&to=PUNE&date=2026-10-29&cls=ALL&quota=GN";
    const browser = new FakeBrowser({}, results);
    const llm = new ScriptedLLM([
      [{ name: "done", args: { speech: "Here are tomorrow's trains, 29 October." } }],
      [{ name: "done", args: { speech: "There are trains on 29 October only." } }],
    ]);
    const io = new RecordingIO();
    const agent = new Agent(
      { browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases(), policy: new NavigationPolicy() },
      { now: () => new Date("2026-10-05T09:30:00+05:30") },
    );
    const r = await run(agent, io, "What trains are there from Mumbai to Pune tomorrow?");
    expect(lastHistory(llm, 1)).toContain("REFUSED: the user asked for tomorrow (Tue, 6 Oct), but this is for Thu, 29 Oct");
    expect(io.said).toEqual(["There are trains on 29 October only."]);
    expect(r.outcome).toBe("done");
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
    // A payment is said from the page alone, once: the model's wrong date never reaches the user.
    expect(io.asked[0].q).toBe(
      "Please check before I pay: ₹490; Pearl City Vande Bharat Express; Tue, 6 Oct, 2026; Chair Car (CC). Should I go ahead?",
    );
  });
});

describe("Agent: feedback after a click", () => {
  it("says when a control now shows something else, e.g. the chosen option", async () => {
    const HELP = "http://localhost:5174/#/help";
    const open = page(HELP, {
      "19": element("Select category ▾", { role: "clickable", tag: "div" }),
      "26": element("Food quality", { role: "option" }),
    });
    const chosen = page(HELP, { "19": element("Food quality ▾", { role: "clickable", tag: "div" }) });
    const browser = new FakeBrowser({ [HELP]: open }, HELP);
    const snapshots = [open, chosen, chosen];
    browser.snapshot = async () => snapshots.shift() ?? chosen;
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 26, narration: "" } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(String(llm.calls[1].messages[1].content)).toContain('click [26] "Food quality" → ok ⇒ [19] now says "Food quality ▾"');
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

describe("Agent: the user says to leave it", () => {
  it("allows only done once the user gives up", async () => {
    const form = page(HOME, { "22": element("SUBMIT COMPLAINT", { role: "clickable", tag: "div" }) });
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const llm = new ScriptedLLM([
      [{ name: "ask_user", args: { question: "फिर से कोशिश करें या रुकें?" } }],
      [{ name: "click", args: { id: 22 } }],
      [{ name: "done", args: { speech: "ठीक है, कुछ नहीं भेजा।" } }],
    ]);
    const result = await run(agentFor(browser, llm), new RecordingIO(["नहीं, रहने दो"]));
    expect(browser.log).toEqual([]);
    expect(String(llm.calls[1].messages[1].content)).toContain("The user wants to leave it");
    expect(String(llm.calls[2].messages[1].content)).toContain("REFUSED: the user said to leave it");
    expect(result.outcome).toBe("done");
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

  it("refuses a made-up PNR", async () => {
    const pnr = page(HOME, { "20": element("PNR (optional)", { role: "textbox", tag: "input" }) });
    const browser = new FakeBrowser({ [HOME]: pnr }, HOME);
    const llm = new ScriptedLLM([[{ name: "type_text", args: { id: 20, text: "1234567890" } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual([]);
    expect(String(llm.calls[1].messages[1].content)).toContain("numbers like a PNR");
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

describe("Agent: one turn per form", () => {
  const history = (llm: ScriptedLLM, i: number) => String(llm.calls[i].messages[1].content);

  /** A search form whose station boxes show suggestions after typing, until one is clicked. */
  class SearchForm extends FakeBrowser {
    open: "" | "from" | "to" = "";
    constructor() {
      super({}, HOME);
    }
    override async snapshot() {
      const els: Record<string, ReturnType<typeof element>> = {
        "6": element("FROM", { role: "textbox", tag: "input" }),
        "8": element("TO", { role: "textbox", tag: "input" }),
        "11": element("Tomorrow", { role: "clickable", tag: "div" }),
        "18": element("SEARCH TRAINS"),
      };
      if (this.open === "from")
        Object.assign(els, {
          "19": element("Chennai Central MAS Chennai", { role: "option" }),
          "20": element("Chennai Egmore MS Chennai", { role: "option" }),
        });
      if (this.open === "to") Object.assign(els, { "21": element("KSR Bengaluru SBC Bengaluru", { role: "option" }) });
      return page(HOME, els);
    }
    override async type(id: string | number, text: string) {
      await super.type(id, text);
      this.open = id === 6 ? "from" : "to";
    }
    override async click(id: string | number) {
      await super.click(id);
      this.open = "";
    }
  }

  it("types and picks station suggestions, then carries on in the same turn", async () => {
    const browser = new SearchForm();
    const llm = new ScriptedLLM([
      [
        { name: "type_text", args: { id: 6, text: "Chennai", pick_suggestion: "Chennai", narration: "" } },
        { name: "type_text", args: { id: 8, text: "Bengaluru", pick_suggestion: "Bengaluru", narration: "" } },
        { name: "click", args: { id: 11, narration: "" } },
        { name: "click", args: { id: 18, narration: "" } },
      ],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["type 6 Chennai", "click 19", "type 8 Bengaluru", "click 21", "click 11", "click 18"]);
    expect(llm.calls).toHaveLength(2);
    expect(history(llm, 1)).toContain('chose suggestion "Chennai Central MAS Chennai" (others offered: [20] "Chennai Egmore MS Chennai")');
  });

  it("picks the matching station when the model typed one and carried on without pick_suggestion", async () => {
    const browser = new SearchForm();
    const llm = new ScriptedLLM([
      [
        { name: "type_text", args: { id: 6, text: "Chennai", narration: "" } },
        { name: "click", args: { id: 18, narration: "" } },
      ],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["type 6 Chennai", "click 19", "click 18"]);
  });

  it("asks the model to click a single suggestion that typing brought up", async () => {
    const browser = new SearchForm();
    browser.type = async (id, text) => {
      browser.log.push(`type ${id} ${text}`);
      browser.open = "to";
    };
    const llm = new ScriptedLLM([[{ name: "type_text", args: { id: 8, text: "Bengaluru", narration: "" } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(history(llm, 1)).toContain('NEW OPTIONS: [21] "KSR Bengaluru SBC Bengaluru" — click the right one next');
  });

  it("drops the model's own click on a suggestion that was already picked", async () => {
    const browser = new SearchForm();
    const llm = new ScriptedLLM([
      [
        { name: "type_text", args: { id: 6, text: "Chennai", pick_suggestion: "Chennai", narration: "" } },
        { name: "click", args: { id: 20, narration: "" } },
        { name: "click", args: { id: 18, narration: "" } },
      ],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["type 6 Chennai", "click 19", "click 18"]);
    expect(history(llm, 1)).toContain("(your click on [20] was not needed)");
  });

  it("stops the batch when suggestions are left open, so the model can look", async () => {
    const browser = new SearchForm();
    const llm = new ScriptedLLM([
      [
        { name: "type_text", args: { id: 6, text: "Chennai", narration: "" } },
        { name: "click", args: { id: 11, narration: "" } },
      ],
    ]);
    // Typed text that matches no suggestion: nothing is picked, and the model must look.
    browser.type = async (id, text) => {
      browser.log.push(`type ${id} ${text}`);
      browser.open = "to";
    };
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["type 6 Chennai"]);
    expect(history(llm, 1)).toContain('no suggestion is like "Chennai"');
    expect(history(llm, 1)).toContain(
      'this failed, so these calls were skipped: click [11] "Tomorrow". Look again, then redo the ones still needed',
    );
  });

  it("refuses select_option on an ordinary button instead of pressing it", async () => {
    const form = page(HOME, {
      "13": element("All Classes ▾", { role: "clickable", tag: "div" }),
      "17": element("Senior Citizen", { role: "clickable", tag: "div" }),
    });
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const llm = new ScriptedLLM([[{ name: "select_option", args: { id: 17, option: "Sleeper", narration: "" } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual([]);
    expect(history(llm, 1)).toContain("is a button, not a dropdown, so nothing was clicked");
  });

  it("reports the suggestions when none matches the pick", async () => {
    const browser = new SearchForm();
    const llm = new ScriptedLLM([
      [
        { name: "type_text", args: { id: 6, text: "Chennai", pick_suggestion: "Tambaram", narration: "" } },
        { name: "click", args: { id: 18, narration: "" } },
      ],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["type 6 Chennai"]);
    expect(history(llm, 1)).toContain('no suggestion is like "Tambaram". Suggestions: [19] "Chennai Central MAS Chennai"');
  });

  it("fills choice buttons and dropdowns in fill_form", async () => {
    const form = page(HOME, {
      "36": element("Age", { role: "textbox", tag: "input" }),
      "37": element("Male", { role: "clickable", tag: "div" }),
      "38": element("Female", { role: "clickable", tag: "div" }),
      "40": element("Berth preference", { role: "select", tag: "select" }),
      "43": element("CONTINUE"),
    });
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const llm = new ScriptedLLM([
      [
        {
          name: "fill_form",
          args: {
            fields: [
              { id: 36, value: "34" },
              { id: 37, value: "Female" },
              { id: 40, value: "Lower" },
            ],
            narration: "",
          },
        },
        { name: "click", args: { id: 43, narration: "" } },
      ],
    ]);
    const agent = new Agent(
      { browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() },
      { profile: { name: "Asha Verma", age: "34", gender: "Female" } },
    );
    await run(agent, new RecordingIO());
    expect(browser.log).toEqual(["type 36 34", "click 38", "select 40 Lower", "click 43"]);
  });

  it("refuses two people squeezed into one passenger row", async () => {
    const form = page(HOME, {
      "65": element("Name", { role: "textbox", tag: "input" }),
      "67": element("Male", { role: "clickable", tag: "div" }),
      "68": element("Female", { role: "clickable", tag: "div" }),
    });
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const fill = (fields: { id: number; value: string }[]) => [{ name: "fill_form", args: { fields, narration: "" } }];
    const llm = new ScriptedLLM([
      fill([
        { id: 65, value: "Asha Verma" },
        { id: 65, value: "Ravi Verma" },
      ]),
      fill([
        { id: 68, value: "Female" },
        { id: 67, value: "Male" },
      ]),
    ]);
    const agent = new Agent(
      { browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() },
      { profile: { name: "Asha Verma" } },
    );
    await agent.run("book for me and Ravi Verma", new RecordingIO(), new AbortController().signal);
    expect(browser.log).toEqual([]);
    expect(history(llm, 1)).toContain("[65] is given twice");
    expect(history(llm, 2)).toContain("[67] is a second choice in the same button group");
  });

  it("sets the dropdown when a fill_form id slips onto the button next to it", async () => {
    const form = page(
      HOME,
      {
        "65": element("Male", { role: "clickable", tag: "div" }),
        "66": element("Female", { role: "clickable", tag: "div" }),
        "67": element("Transgender", { role: "clickable", tag: "div" }),
        "68": element("Berth preference", { role: "select", tag: "select" }),
      },
      '[65] clickable "Male"\n[66] clickable "Female"\n[67] clickable "Transgender"\n[68] select "Berth preference" selected="Lower" options=[No preference | Lower | Upper]',
    );
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const fields = [
      { id: 65, value: "Female" },
      { id: 67, value: "No preference" },
    ];
    const llm = new ScriptedLLM([[{ name: "fill_form", args: { fields, narration: "" } }]]);
    const agent = new Agent(
      { browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() },
      { profile: { gender: "Female" } },
    );
    await run(agent, new RecordingIO());
    expect(browser.log).toEqual(["click 66", "select 68 No preference"]);
  });

  it("never clicks a gated button through fill_form", async () => {
    const form = page(
      PAY,
      { "1": element("Coach", { role: "textbox" }), "7": element("PAY ₹845") },
      '- Amount payable ₹845\n[7] button "PAY ₹845"',
    );
    const browser = new FakeBrowser({ [PAY]: form }, PAY);
    const llm = new ScriptedLLM([
      [
        {
          name: "fill_form",
          args: {
            fields: [
              { id: 1, value: "S4" },
              { id: 7, value: "PAY ₹845" },
            ],
            narration: "",
          },
        },
      ],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["type 1 S4"]);
    expect(history(llm, 1)).toContain("needs the user's confirmation");
  });
});

describe("batchStop", () => {
  const call = (id: number) => ({ id: "c", name: "click", args: { id } });
  const before = page(HOME, { "9": element("Tue, 6 Oct, 2026"), "11": element("Tomorrow"), "18": element("SEARCH") });

  it("carries on when a control was only renamed", () => {
    const after = page(HOME, { "44": element("Wed, 7 Oct, 2026"), "11": element("Tomorrow"), "18": element("SEARCH") });
    expect(batchStop(before, after, call(18))).toBe("");
  });

  it("stops for new controls, a missing target, alerts and dialogs", () => {
    expect(batchStop(before, page(HOME, { ...before.elements, "50": element("1"), "51": element("2") }), call(18))).toBe(
      "new options appeared",
    );
    expect(batchStop(before, page(HOME, { "9": element("x"), "11": element("y"), "60": element("z") }), call(18))).toBe(
      "its target is no longer on the page",
    );
    expect(batchStop(before, { ...before, alerts: ["Select valid stations"] }, call(18))).toBe("an alert appeared");
    expect(batchStop(before, { ...before, text: `${before.text}\n- No stations found` }, call(18))).toBe("the page shows new text");
    expect(batchStop(before, { ...before, dialog: "Calendar" }, call(18))).toBe("a dialog opened");
  });
});

describe("Agent: wrong class", () => {
  const RESULTS = "http://localhost:5174/#/results";
  const results = page(RESULTS, {
    "26": element("book ticket (2S ₹90 14)", { role: "clickable", tag: "div" }),
    "31": element("book ticket (SL ₹145 49)", { role: "clickable", tag: "div" }),
  });

  it("refuses to book a class the user did not ask for, before asking them", async () => {
    const browser = new FakeBrowser({ [RESULTS]: results }, RESULTS);
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 31, narration: "", confirmation_question: "Book SL?" } }]]);
    const io = new RecordingIO(["haan"]);
    await new Agent({ browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() }).run(
      "ನಾಳೆ ಮೈಸೂರಿಗೆ second sitting ticket book ಮಾಡಿ",
      io,
      new AbortController().signal,
    );
    expect(browser.log).toEqual([]);
    expect(io.asked).toEqual([]);
    expect(String(llm.calls[1].messages[1].content)).toContain("but this books Sleeper (SL)");
  });
});

describe("Agent: filled forms", () => {
  it("says a form is already filled and names the next button, instead of refilling it", async () => {
    const elements = {
      "77": element("Name", { role: "textbox", tag: "input" }),
      "80": element("Female", { role: "clickable", tag: "div" }),
      "85": element("CONTINUE", { role: "clickable", tag: "div" }),
    };
    const form = page(
      HOME,
      elements,
      '[77] textbox "Name" value="Asha Verma"\n[80] clickable "Female" looks-selected\n[85] clickable "CONTINUE"',
    );
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const fill = {
      name: "fill_form",
      args: {
        fields: [
          { id: 77, value: "Asha Verma" },
          { id: 80, value: "Female" },
        ],
        narration: "",
      },
    };
    const llm = new ScriptedLLM([[fill]]);
    const agent = new Agent(
      { browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() },
      { profile: { name: "Asha Verma", gender: "Female" } },
    );
    await run(agent, new RecordingIO());
    expect(browser.log).toEqual([]);
    expect(String(llm.calls[1].messages[1].content)).toContain(
      'nothing to do: "Name", "Female" already hold these values. Next: click [85] "CONTINUE"',
    );
  });

  it("says a leftover alert clears only on Continue", async () => {
    const form = page(
      HOME,
      { "43": element("Mobile number", { role: "textbox", tag: "input" }), "44": element("CONTINUE") },
      '[43] textbox "Mobile number" value="9000000001"\n[44] button "CONTINUE"',
    );
    form.alerts = ["Enter a valid 10-digit mobile number."];
    const browser = new FakeBrowser({ [HOME]: form }, HOME);
    const llm = new ScriptedLLM([[{ name: "fill_form", args: { fields: [{ id: 43, value: "9000000001" }], narration: "" } }]]);
    const agent = new Agent(
      { browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() },
      { profile: { mobile: "9000000001" } },
    );
    await run(agent, new RecordingIO());
    expect(String(llm.calls[1].messages[1].content)).toContain(
      'Next: click [44] "CONTINUE". The alert "Enter a valid 10-digit mobile number." is from before; it clears only when you click it.',
    );
  });
});

describe("Agent: wrong quota", () => {
  it("refuses a General ticket from the results page when Tatkal was asked", async () => {
    const RESULTS = "http://localhost:5174/#/results";
    const results = page(
      RESULTS,
      { "24": element("book ticket (SL ₹265 23)", { role: "clickable", tag: "div" }) },
      '- Chennai Central (MAS) Madurai Junction (MDU) Tue, 6 Oct, 2026 · General quota · 9 trains found\nROW: Ganga Superfast Express · (11261) · [24] clickable "book ticket (SL ₹265 23)"',
    );
    const browser = new FakeBrowser({ [RESULTS]: results }, RESULTS);
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 24, narration: "" } }]]);
    const io = new RecordingIO(["சரி"]);
    await new Agent({ browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() }).run(
      "நாளைக்கு மதுரைக்கு தட்கல்ல ஒரு ஸ்லீப்பர் டிக்கெட்",
      io,
      new AbortController().signal,
    );
    expect(browser.log).toEqual([]);
    expect(String(llm.calls[1].messages[1].content)).toContain(
      "the user asked for the Tatkal quota, but this is General. Class, quota and date are chosen on the search form",
    );
  });
});

describe("Agent: wrong date", () => {
  it("refuses to pay for a ticket on another day than the user asked", async () => {
    const REVIEW = "http://localhost:5174/#/review";
    const review = page(
      REVIEW,
      { "44": element("PROCEED TO PAY") },
      '- Train Chennai–Madurai Mail (12200) Date Tue, 6 Oct, 2026 Class Sleeper (SL) Total ₹265\n[44] button "PROCEED TO PAY"',
    );
    const browser = new FakeBrowser({ [REVIEW]: review }, REVIEW);
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 44, narration: "", confirmation_question: "Pay 265?" } }]]);
    const io = new RecordingIO(["haan"]);
    const agent = new Agent(
      { browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() },
      { now: () => new Date("2026-10-05T09:30:00+05:30") },
    );
    await agent.run("परसों चेन्नई से मदुरै की स्लीपर टिकट बुक करो", io, new AbortController().signal);
    expect(browser.log).toEqual([]);
    expect(io.asked).toEqual([]);
    expect(String(llm.calls[1].messages[1].content)).toContain(
      "the user asked for the day after tomorrow (Wed, 7 Oct), but this is for Tue, 6 Oct",
    );
  });
});

describe("Agent: knowing when to stop", () => {
  const HELP = "http://localhost:5174/#/help";
  const box = page(HELP, { "21": element("Describe your issue", { role: "textbox", tag: "textarea" }) });

  it("does not click a free-text box, and points to dictation", async () => {
    const browser = new FakeBrowser({ [HELP]: box }, HELP);
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 21, narration: "" } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual([]);
    expect(String(llm.calls[1].messages[1].content)).toContain("Use compose_with_kivi on it");
  });

  it("does not fill a complaint box with words lifted from the request", async () => {
    const browser = new FakeBrowser({ [HELP]: box }, HELP);
    const llm = new ScriptedLLM([[{ name: "fill_form", args: { fields: [{ id: 21, value: "खाने की क्वालिटी के बारे में शिकायत" }] } }]]);
    await run(agentFor(browser, llm), new RecordingIO(), "मुझे खाने की क्वालिटी के बारे में शिकायत दर्ज करनी है");
    expect(browser.log).toEqual([]);
    expect(String(llm.calls[1].messages[1].content)).toContain("Use compose_with_kivi");
  });

  it("points an empty complaint box in fill_form to dictation", async () => {
    const browser = new FakeBrowser({ [HELP]: box }, HELP);
    const llm = new ScriptedLLM([[{ name: "fill_form", args: { fields: [{ id: 21, value: "" }] } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual([]);
    expect(String(llm.calls[1].messages[1].content)).toContain("use compose_with_kivi on it");
  });

  it("does not reopen a dropdown that already shows the chosen option", async () => {
    const closed = page(HELP, { "19": element("Select category ▾", { role: "clickable", tag: "div" }) });
    const open = page(`${HELP}/open`, {
      "19": element("Select category ▾", { role: "clickable", tag: "div" }),
      "25": element("Cleanliness", { role: "clickable", tag: "div" }),
      "26": element("Food quality", { role: "clickable", tag: "div" }),
    });
    const chosen = page(`${HELP}/set`, { "19": element("Food quality ▾", { role: "clickable", tag: "div" }) });
    const browser = new FakeBrowser({ [HELP]: closed, [`${HELP}/open`]: open, [`${HELP}/set`]: chosen }, HELP, {
      "19": `${HELP}/open`,
      "26": `${HELP}/set`,
    });
    const llm = new ScriptedLLM([
      [{ name: "select_option", args: { id: 19, option: "Food Quality" } }],
      [{ name: "click", args: { id: 19 } }],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["click 19", "click 26"]);
    expect(String(llm.calls[2].messages[1].content)).toContain('already shows "Food quality"');
  });

  it("remembers an option chosen by clicking, and does not reopen or re-click it", async () => {
    const closed = page(HELP, { "19": element("Select category ▾", { role: "clickable", tag: "div" }) });
    const open = page(`${HELP}/open`, {
      "19": element("Select category ▾", { role: "clickable", tag: "div" }),
      "24": element("Cleanliness", { role: "clickable", tag: "div" }),
    });
    const chosen = page(`${HELP}/open`, { "19": element("Cleanliness ▾", { role: "clickable", tag: "div" }) });
    const browser = new FakeBrowser({ [HELP]: closed, [`${HELP}/open`]: open }, HELP, { "19": `${HELP}/open` });
    browser.links["24"] = `${HELP}/open`;
    const click = browser.click.bind(browser);
    browser.click = async (id) => {
      await click(id);
      if (String(id) === "24") browser.pages[`${HELP}/open`] = chosen;
    };
    const llm = new ScriptedLLM([
      [{ name: "click", args: { id: 19 } }],
      [{ name: "click", args: { id: 24 } }],
      [{ name: "click", args: { id: 24 } }],
      [{ name: "click", args: { id: 19 } }],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["click 19", "click 24"]);
    expect(String(llm.calls[3].messages[1].content)).toContain('not needed: you already chose it, and [19] shows "Cleanliness ▾"');
    expect(String(llm.calls[4].messages[1].content)).toContain('already shows "Cleanliness"');
  });

  it("lets a batch go on past an option that is already chosen", async () => {
    const closed = page(HELP, { "13": element("Select class ▾", { role: "clickable", tag: "div" }) });
    const open = page(`${HELP}/open`, {
      "13": element("Select class ▾", { role: "clickable", tag: "div" }),
      "30": element("Sleeper (SL)", { role: "clickable", tag: "div" }),
    });
    const chosen = page(`${HELP}/set`, {
      "13": element("Sleeper (SL) ▾", { role: "clickable", tag: "div" }),
      "15": element("Tatkal", { role: "clickable", tag: "div" }),
    });
    const browser = new FakeBrowser({ [HELP]: closed, [`${HELP}/open`]: open, [`${HELP}/set`]: chosen }, HELP, {
      "13": `${HELP}/open`,
      "30": `${HELP}/set`,
    });
    const llm = new ScriptedLLM([
      [{ name: "select_option", args: { id: 13, option: "Sleeper" } }],
      [
        { name: "click", args: { id: 13 } },
        { name: "click", args: { id: 15 } },
      ],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["click 13", "click 30", "click 15"]);
  });

  it("does not type into a button, and says to click it", async () => {
    const form = page(HELP, { "9": element("Tue, 6 Oct", { role: "clickable", tag: "div" }) });
    const browser = new FakeBrowser({ [HELP]: form }, HELP);
    const llm = new ScriptedLLM([[{ name: "type_text", args: { id: 9, text: "6 Oct 2026" } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual([]);
    expect(String(llm.calls[1].messages[1].content)).toContain("is a clickable, not a text box. Click it");
  });

  it("does not retype a value the field holds, and points to the next button", async () => {
    const form = page(HELP, {
      "42": element("Mobile", { role: "textbox", tag: "input" }),
      "43": element("Continue", { role: "button", tag: "button" }),
    });
    form.text = '[42] textbox "Mobile" value="9000000001"\n[43] button "Continue"';
    form.alerts = ["Enter a valid 10-digit mobile number."];
    const browser = new FakeBrowser({ [HELP]: form }, HELP);
    const llm = new ScriptedLLM([
      [
        { name: "type_text", args: { id: 42, text: "9000000001" } },
        { name: "click", args: { id: 43 } },
      ],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["click 43"]);
    expect(String(llm.calls[1].messages[1].content)).toContain("already holds this. The alert");
  });

  it("does not press Log in while the password handed to the user is empty", async () => {
    const LOGIN = "http://localhost:5174/sites/login/";
    const form = page(LOGIN, {
      "2": element("Password", { role: "textbox", tag: "input", type: "password" }),
      "4": element("Log in", { role: "button", tag: "button" }),
    });
    form.text = '[2] textbox "Password" value=""\n[4] button "Log in"';
    const browser = new FakeBrowser({ [LOGIN]: form }, LOGIN);
    const llm = new ScriptedLLM([[{ name: "type_text", args: { id: 2, text: "Kesari@2026" } }], [{ name: "click", args: { id: 4 } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["focus 2"]);
    expect(String(llm.calls[2].messages[1].content)).toContain("only the user may type it. Call done now");
  });

  it("reopens a closed list to click an option the model saw earlier", async () => {
    const closed = page(HELP, {
      "9": element("Tue, 6 Oct", { role: "clickable", tag: "div" }),
      "13": element("All Classes ▾", { role: "clickable", tag: "div" }),
    });
    const open = page(`${HELP}/open`, {
      "9": element("Tue, 6 Oct", { role: "clickable", tag: "div" }),
      "13": element("All Classes ▾", { role: "clickable", tag: "div" }),
      "23": element("Sleeper (SL)", { role: "clickable", tag: "div" }),
    });
    const browser = new FakeBrowser({ [HELP]: closed, [`${HELP}/open`]: open }, HELP, { "13": `${HELP}/open`, "9": HELP });
    const llm = new ScriptedLLM([
      [{ name: "click", args: { id: 13 } }],
      [{ name: "click", args: { id: 9 } }],
      [{ name: "click", args: { id: 23 } }],
    ]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["click 13", "click 9", "click 13", "click 23"]);
    expect(String(llm.calls[3].messages[1].content)).toContain("its list had closed, so reopened [13]");
  });

  it("treats typing into a custom dropdown as choosing from it", async () => {
    const closed = page(HELP, { "13": element("All Classes ▾", { role: "clickable", tag: "div" }) });
    const open = page(`${HELP}/open`, {
      "13": element("All Classes ▾", { role: "clickable", tag: "div" }),
      "23": element("Sleeper (SL)", { role: "clickable", tag: "div" }),
      "24": element("AC 3 Tier (3A)", { role: "clickable", tag: "div" }),
    });
    const browser = new FakeBrowser({ [HELP]: closed, [`${HELP}/open`]: open }, HELP, { "13": `${HELP}/open` });
    const llm = new ScriptedLLM([[{ name: "type_text", args: { id: 13, text: "Sleeper" } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(browser.log).toEqual(["click 13", "click 23"]);
  });

  it("says what a closing date picker set on the page underneath", async () => {
    const form = page(HELP, { "9": element("Tue, 6 Oct, 2026", { role: "clickable", tag: "div" }) });
    const picker = page(HELP, { "31": element("12", { role: "clickable", tag: "div" }) });
    picker.dialog = "October 2026";
    const set = page(HELP, { "9": element("Mon, 12 Oct, 2026", { role: "clickable", tag: "div" }) });
    const browser = new FakeBrowser({ [HELP]: form }, HELP);
    const click = browser.click.bind(browser);
    browser.click = async (id) => {
      await click(id);
      browser.pages[HELP] = String(id) === "9" ? picker : set;
    };
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 9 } }], [{ name: "click", args: { id: 31 } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(String(llm.calls[2].messages[1].content)).toContain('[9] now says "Mon, 12 Oct, 2026"');
  });

  it("after fixing a form's alert, points back to the button that raised it", async () => {
    const form = page(HELP, {
      "81": element("Female", { role: "clickable", tag: "div" }),
      "86": element("CONTINUE", { role: "clickable", tag: "div" }),
    });
    form.alerts = ["Select the gender of passenger 1."];
    const browser = new FakeBrowser({ [HELP]: form }, HELP);
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 81 } }]]);
    await run(agentFor(browser, llm), new RecordingIO());
    expect(String(llm.calls[1].messages[1].content)).toContain('it clears when you click [86] "CONTINUE" again');
  });

  it("still clicks a Submit complaint button (with confirmation)", async () => {
    const form = page(HELP, { "22": element("SUBMIT COMPLAINT", { role: "clickable", tag: "div" }) });
    const browser = new FakeBrowser({ [HELP]: form }, HELP);
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 22, narration: "" } }]]);
    const io = new RecordingIO(["haan"]);
    await run(agentFor(browser, llm), io);
    expect(browser.log).toEqual(["click 22"]);
    expect(io.asked[0].kind).toBe("confirm");
  });

  it("does not ask to submit while the complaint box is empty", async () => {
    const form = page(HELP, {
      "21": element("Describe your issue", { role: "textbox", tag: "textarea" }),
      "22": element("SUBMIT COMPLAINT", { role: "clickable", tag: "div" }),
    });
    form.text = '[21] textbox "Describe your issue" value=""\n[22] clickable "SUBMIT COMPLAINT"';
    const browser = new FakeBrowser({ [HELP]: form }, HELP);
    const llm = new ScriptedLLM([[{ name: "click", args: { id: 22, narration: "" } }]]);
    const io = new RecordingIO(["haan"]);
    await run(agentFor(browser, llm), io);
    expect(browser.log).toEqual([]);
    expect(io.asked).toEqual([]);
    expect(String(llm.calls[1].messages[1].content)).toContain("is still empty. Use compose_with_kivi");
  });

  it("stops offering dictation after the user rejected it twice", async () => {
    class Dictating extends RecordingIO {
      override async compose() {
        return "Coach mein bahut gandagi thi.";
      }
    }
    const browser = new FakeBrowser({ [HELP]: box }, HELP);
    const kivi = [{ name: "compose_with_kivi", args: { id: 21, what: "complaint" } }];
    const llm = new ScriptedLLM([kivi, kivi, kivi]);
    const io = new Dictating(Array(6).fill("nahi"));
    await run(agentFor(browser, llm), io);
    expect(io.asked).toHaveLength(6);
    expect(String(llm.calls[3].messages[1].content)).toContain("REFUSED: the user already rejected the dictated text twice");
  });

  it("tells the model to finish after the user said no twice", async () => {
    const RESULTS = "http://localhost:5174/#/results";
    const results = page(RESULTS, { "61": element("book ticket (SL ₹160 11)"), "62": element("book ticket (SL ₹170 86)") });
    const browser = new FakeBrowser({ [RESULTS]: results }, RESULTS);
    const llm = new ScriptedLLM([
      [{ name: "click", args: { id: 61, narration: "" } }],
      [{ name: "click", args: { id: 62, narration: "" } }],
    ]);
    await run(agentFor(browser, llm), new RecordingIO(["nahi", "nahi"]));
    expect(browser.log).toEqual([]);
    expect(String(llm.calls[2].messages[1].content)).toContain("USER DECLINED again. Stop: call done now");
  });
});

describe("Agent: when it can't finish", () => {
  const form = () => page(HOME, { "8": element("TO", { role: "textbox", tag: "input" }), "18": element("SEARCH TRAINS") });
  /** Types a station the site doesn't have, again and again; answers the explanation request in words. */
  function looping(): LLM & { calls: ChatOptions[] } {
    const calls: ChatOptions[] = [];
    return {
      calls,
      async chat(opts: ChatOptions): Promise<ChatResult> {
        calls.push(opts);
        if (!opts.tools)
          return { content: "Erode is not on this website's station list. Should I try Coimbatore instead?", toolCalls: [], ms: 1 };
        // Other spellings each time, as the live run did (an exact repeat is refused by the loop guard).
        const text = ["Erode", "Erode Jn", "Erode Junction", "ED", "Erode"][(calls.length - 1) % 5];
        const type = { name: "type_text", args: { id: 8, text, pick_suggestion: text, narration: "" } };
        return { content: "", toolCalls: [{ id: "c0", ...type }], ms: 1 };
      },
    };
  }

  it("says what stopped it, in words, instead of a fixed 'I'm stuck'", async () => {
    const browser = new FakeBrowser({ [HOME]: form() }, HOME);
    const llm = looping();
    const io = new RecordingIO();
    const r = await new Agent({ browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() }, { maxSteps: 6 }).run(
      "Book a ticket from Chennai to Erode tomorrow",
      io,
      new AbortController().signal,
    );
    expect(r.outcome).toBe("stuck");
    expect(io.said.at(-1)).toBe("Erode is not on this website's station list. Should I try Coimbatore instead?");
    expect(io.phrasesSaid).not.toContain("stuck");
    // The explanation request saw what happened, without tools.
    expect(String(llm.calls.at(-1)?.messages[1].content)).toContain("Erode");
  });

  it("tells the model the site has no such place after two empty searches", async () => {
    const browser = new FakeBrowser({ [HOME]: form() }, HOME);
    const llm = looping();
    await new Agent({ browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() }, { maxSteps: 3 }).run(
      "Book a ticket from Chennai to Erode tomorrow",
      new RecordingIO(),
      new AbortController().signal,
    );
    const history = String(llm.calls[2].messages[1].content);
    expect(history).toContain("Try once more with a shorter word");
    expect(history).toContain('This site most likely has no "Erode Jn". Stop trying other spellings: ask_user');
  });

  it("falls back to the fixed phrase when the explanation fails", async () => {
    const browser = new FakeBrowser({ [HOME]: form() }, HOME);
    const inner = looping();
    const llm: LLM = { chat: (o) => (o.tools ? inner.chat(o) : Promise.reject(new Error("network"))) };
    const io = new RecordingIO();
    await new Agent({ browser, llm, translator: echoTranslator, docs: noDocs, phrases: phrases() }, { maxSteps: 6 }).run(
      "Book a ticket to Erode",
      io,
      new AbortController().signal,
    );
    expect(io.phrasesSaid.at(-1)).toBe("stuck");
  });
});

describe("Agent: one question per payment", () => {
  const RESULTS = "http://localhost:5174/#/results";
  const REVIEW = "http://localhost:5174/#/review";
  const PAYP = "http://localhost:5174/#/pay";
  const results = page(
    RESULTS,
    {
      "61": element("book ticket (SL ₹160 11)"),
      "62": element("book ticket (3A ₹380 4)"),
      "63": element("book ticket (SL ₹175 20)"),
    },
    [
      'ROW: Chennai–Bengaluru Express · (12657) [61] clickable "book ticket (SL ₹160 11)" [62] clickable "book ticket (3A ₹380 4)"',
      'ROW: Brindavan Express · (12639) [63] clickable "book ticket (SL ₹175 20)"',
    ].join("\n"),
  );
  const review = (total: number) =>
    page(
      REVIEW,
      { "56": element("PROCEED TO PAY") },
      [
        `- Chennai–Bengaluru Express (12657) · MAS 22:30 → SBC 04:40 · Tue, 6 Oct, 2026 · SL · General Review your journey Train Chennai–Bengaluru Express (12657) From Chennai Central (MAS) at 22:30 To`,
        `- Bengaluru (SBC) at 04:40 Date Tue, 6 Oct, 2026 Class Sleeper (SL) Passengers Asha Verma (34, Female) Ticket fare × 1 ₹160 Convenience fee ₹20 Total ₹${total}`,
        '[56] clickable "PROCEED TO PAY"',
        "- Pathik Rail is a fictional demo website.",
      ].join("\n"),
    );
  const pay = (amount: number) =>
    page(
      PAYP,
      { "67": element(`PAY ₹${amount}`) },
      [`- Tue, 6 Oct, 2026 · SL · General Payment`, `[67] clickable "PAY ₹${amount}"`].join("\n"),
    );
  const flow = (payAmount: number) =>
    new FakeBrowser({ [RESULTS]: results, [REVIEW]: review(180), [PAYP]: pay(payAmount) }, RESULTS, { "61": REVIEW, "56": PAYP });
  // A fresh list each time: ScriptedLLM uses its steps up.
  const clicks = () => [61, 56, 67].map((id) => [{ name: "click", args: { id, narration: "" } }]);

  it("asks once, with the total, at the payment step: not for the train chosen, nor again at PAY", async () => {
    const browser = flow(180);
    const io = new RecordingIO(["haan"]);
    await run(agentFor(browser, new ScriptedLLM(clicks())), io, "Book a sleeper ticket from Chennai to Bengaluru");
    expect(io.asked.map((a) => a.q)).toEqual([
      "Please check before I pay: ₹180; Chennai–Bengaluru Express; Tue, 6 Oct, 2026; Sleeper (SL); Passengers Asha Verma (34, Female). Should I go ahead?",
    ]);
    expect(browser.log).toEqual(["click 61", "click 56", "click 67"]);
    expect(io.audits().map((a) => [a.target, a.confirmed])).toEqual([
      ["PROCEED TO PAY", true],
      ["PAY ₹180", true],
    ]);
  });

  it("asks again when the payment grows past what the user agreed to", async () => {
    const browser = flow(200);
    const io = new RecordingIO(["haan", "nahi"]);
    await run(agentFor(browser, new ScriptedLLM(clicks())), io, "Book a sleeper ticket from Chennai to Bengaluru");
    expect(io.asked).toHaveLength(2);
    expect(io.asked[1].q).toContain("₹200");
    expect(browser.log).not.toContain("click 67");
  });
});
