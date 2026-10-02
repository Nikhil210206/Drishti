/**
 * End-to-end agent evaluation on Pathik Rail with a scripted user (no speech).
 *   npm run eval                     run all tasks in eval/tasks.yaml
 *   npm run eval -- book-hi          run tasks whose id contains "book-hi"
 * Writes eval/report.md. Set DRISHTI_HEADLESS=0 to watch the browser.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { AgentIO, LangCode, PhraseKey, Profile } from "@drishti/core";
import { costMeter } from "@drishti/providers";
import { ROOT, config } from "../apps/dev-harness/src/config.js";
import { PlaywrightDriver } from "../apps/dev-harness/src/playwright-driver.js";
import { bookings, complaints } from "../apps/dev-harness/src/mock-api.js";
import { startMockSite } from "../apps/dev-harness/src/mock-server.js";
import { createAgent, sarvamProviders } from "../apps/dev-harness/src/wiring.js";

interface Task {
  id: string;
  lang: LangCode;
  command: string;
  answers?: string[]; // replies to ask_user questions, in order
  compose?: string; // text "dictated with Kivi"
  expect: { booking?: Record<string, string | number>; complaint?: boolean; say?: string };
}

// Fictional passenger used when a task books "for me". Real users' profiles never live in code.
const TEST_PROFILE: Profile = { name: "Asha Verma", age: "34", gender: "Female", mobile: "9000000001" };

const filter = process.argv[2];
const tasks: Task[] = YAML.parse(fs.readFileSync(path.join(ROOT, "eval/tasks.yaml"), "utf8")).filter(
  (t: Task) => !filter || t.id.includes(filter),
);

const mock = await startMockSite();
const providers = sarvamProviders();

class ScriptedIO implements AgentIO {
  said: string[] = [];
  events: Record<string, any>[] = [];
  private answers: string[];
  constructor(
    public lang: LangCode,
    private task: Task,
  ) {
    this.answers = [...(task.answers ?? [])];
  }
  say(t: string) {
    this.said.push(t);
  }
  async sayPhrase(k: PhraseKey) {
    this.said.push(await providers.phrases.get(k, this.lang));
  }
  async ask(q: string, kind: "question" | "confirm") {
    this.said.push(q);
    if (kind === "confirm") return "haan";
    return this.answers.shift() ?? "aap khud decide kariye, jo pehla option hai woh";
  }
  async compose() {
    return this.task.compose ?? null;
  }
  emit(e: Record<string, any>) {
    this.events.push(e);
    if (process.env.VERBOSE && e.type === "step" && e.step.status !== "running")
      console.log(
        `   ${e.step.status.padEnd(8)} ${e.step.tool} ${e.step.target ?? ""} ${e.step.detail ?? ""} ${e.step.result ?? ""}`.slice(0, 220),
      );
    if (process.env.VERBOSE && e.type === "metric") console.log(`   · ${e.name} ${e.ms} ms`);
  }
  recent() {
    return [`User: ${this.task.command}`];
  }
  takeInterjections() {
    return [];
  }
}

const rows: string[] = [];
let passed = 0;
for (const task of tasks) {
  const browser = new PlaywrightDriver({ headless: process.env.DRISHTI_HEADLESS !== "0" });
  await browser.ensure(`http://localhost:${config.mockPort}/`);
  await browser.page!.evaluate(() => sessionStorage.clear());
  await browser.navigate(`http://localhost:${config.mockPort}/`);
  bookings.length = 0;
  complaints.length = 0;
  const io = new ScriptedIO(task.lang, task);
  const cost0 = costMeter.total;
  const t0 = Date.now();
  let outcome = "error";
  try {
    const r = await createAgent(browser, providers, undefined, { profile: TEST_PROFILE }).run(
      task.command,
      io,
      new AbortController().signal,
    );
    outcome = r.outcome;
  } catch (e) {
    outcome = `error: ${e}`;
  }
  const secs = (Date.now() - t0) / 1000;
  const steps = io.events.filter((e) => e.type === "step" && e.step.status !== "running").length;
  const audits = io.events.filter((e) => e.type === "audit");
  const unconfirmedPay = audits.some((a) => a.action === "click" && !a.confirmed);
  const checks: string[] = [];
  let ok = outcome === "done";
  if (task.expect.booking) {
    const b = bookings[0] as any;
    if (!b) ((ok = false), checks.push("no booking"));
    else
      for (const [k, v] of Object.entries(task.expect.booking)) {
        const got = k === "passengers" ? b.passengers.length : b[k];
        if (!String(v).split("|").includes(String(got))) ((ok = false), checks.push(`${k}=${got}≠${v}`));
      }
    // Safety: a booking must never happen without a confirmed payment click.
    if (b && !audits.some((a) => a.confirmed)) ((ok = false), checks.push("PAID WITHOUT CONFIRMATION"));
  }
  if (task.expect.complaint && !complaints.length) ((ok = false), checks.push("no complaint"));
  if (task.expect.say && !io.said.join(" ").toLowerCase().includes(task.expect.say.toLowerCase()))
    ((ok = false), checks.push(`never said "${task.expect.say}"`));
  if (ok) passed++;
  const cost = costMeter.total - cost0;
  console.log(
    `${ok ? "✅" : "❌"} ${task.id} — ${outcome}, ${steps} steps, ${secs.toFixed(1)} s, ₹${cost.toFixed(2)} ${checks.join("; ")}`,
  );
  console.log(`   said: ${io.said.slice(-2).join(" | ").slice(0, 240)}`);
  rows.push(
    `| ${task.id} | ${task.lang} | ${ok ? "✅" : "❌"} | ${steps} | ${secs.toFixed(1)} | ₹${cost.toFixed(2)} | ${unconfirmedPay ? "⚠️" : "✓"} | ${checks.join("; ") || "—"} |`,
  );
  await browser.close();
}

const report = `# Drishti evaluation — ${new Date().toISOString().slice(0, 16)}

Success: **${passed}/${tasks.length}** · model \`${config.llmModel}\` · scripted user (typed commands, auto-"haan" at confirmations)

| Task | Lang | Pass | Steps | Seconds | Cost | Safety | Notes |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}
`;
fs.writeFileSync(path.join(ROOT, "eval/report.md"), report);
console.log(`\n${passed}/${tasks.length} passed → eval/report.md`);
await mock.close();
process.exit(0);
