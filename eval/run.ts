/**
 * End-to-end agent eval with a scripted user (typed commands, no speech).
 *
 *   npm run eval                       replay every task from its cassette (free; what CI runs)
 *   npm run eval -- --live             call Sarvam for real and re-record the cassettes (costs ₹)
 *   npm run eval -- book-hi            only tasks whose id contains "book-hi"
 *   npm run eval -- --tag=reading      only tasks with that tag (tags include the tasks/*.yaml name)
 *   npm run eval -- --ids=a,b          only these task ids
 *   npm run eval -- --headed           watch the browser
 *   npm run eval -- --strict           fail replayed tasks whose prompts drifted from the recording
 *   npm run eval -- --ci               exit 1 only on a safety incident or fewer passes than eval/baseline.json
 *   npm run eval -- --live --update-baseline   record, then raise the baseline to this run's pass count
 *
 * Writes a JSONL trace per task to eval/runs/<time>/ (open with eval/viewer/index.html),
 * a summary there, and eval/report.md when every task ran.
 */
import fs from "node:fs";
import path from "node:path";
import { Agent, MemoryCache, NavigationPolicy, PhraseBook, DEFAULT_ALLOWED_DOMAINS } from "@drishti/core";
import { costMeter, SarvamDocReader, SarvamLLM, SarvamTranslator } from "@drishti/providers";
import { ROOT, config, requireApiKey } from "../apps/dev-harness/src/config.js";
import { PlaywrightDriver } from "../apps/dev-harness/src/playwright-driver.js";
import { bookings, complaints } from "../apps/dev-harness/src/mock-api.js";
import { startMockSite } from "../apps/dev-harness/src/mock-server.js";
import { Cassette } from "./lib/cassette.js";
import { Trace } from "./lib/tracing.js";
import { ScriptedIO } from "./lib/scripted-io.js";
import { check } from "./lib/checks.js";
import { TEST_PROFILE, loadTasks, type Task } from "./lib/tasks.js";

// Every run happens "on" Monday 5 Oct 2026, 9:30 IST, so pages and prompts are identical
// between a recording and its replays.
const FIXED_NOW = "2026-10-05T09:30:00+05:30";
const TODAY = "2026-10-05";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const live = flag("live");
const strict = flag("strict");
const filter = args.find((a) => !a.startsWith("--"));
const tag = opt("tag");

if (live) requireApiKey();
const all = loadTasks(path.join(ROOT, "eval/tasks"));
const ids = opt("ids")?.split(",");
const tasks = all.filter((t) => (!filter || t.id.includes(filter)) && (!tag || t.tags?.includes(tag)) && (!ids || ids.includes(t.id)));
if (!tasks.length) throw new Error(`No tasks match ${filter ?? ""} ${tag ?? ""}`);

const runDir = path.join(ROOT, "eval/runs", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
const mock = await startMockSite();
const auth = { apiKey: config.apiKey };
const realLLM = new SarvamLLM({ ...auth, model: config.llmModel });
const realTranslator = new SarvamTranslator(auth);
const realDocs = new SarvamDocReader(auth);

interface Row {
  id: string;
  lang: string;
  tags: string[];
  ok: boolean;
  outcome: string;
  steps: number;
  llmCalls: number;
  inr: number;
  llmMsP50: number;
  seconds: number;
  failures: string[];
  safety: string[];
  confirmations: number;
  drift: number;
  speech: string;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function runTask(task: Task): Promise<Row> {
  const cassette = new Cassette(path.join(ROOT, "eval/cassettes", `${task.id}.json`), live ? "record" : "replay", task.id, config.llmModel);
  const trace = new Trace(path.join(runDir, `${task.id}.jsonl`));
  trace.write("task", { ...task, mode: cassette.mode, model: live ? config.llmModel : cassette.recordedModel, fixedNow: FIXED_NOW });

  const driver = new PlaywrightDriver({ headless: !flag("headed"), fixedTime: FIXED_NOW, offline: true });
  const start = `http://localhost:${config.mockPort}/${task.start ?? ""}`;
  await driver.ensure(start);
  await driver.page!.evaluate(() => sessionStorage.clear());
  await driver.navigate(start);
  bookings.length = 0;
  complaints.length = 0;

  const translator = cassette.translator(realTranslator);
  const phrases = new PhraseBook(translator, new MemoryCache());
  const agent = new Agent(
    {
      browser: trace.driver(driver),
      llm: trace.llm(cassette.llm(realLLM)),
      translator,
      docs: cassette.docs(realDocs),
      phrases,
      policy: new NavigationPolicy(DEFAULT_ALLOWED_DOMAINS),
    },
    {
      maxSteps: config.maxSteps,
      firstStepReasoning: config.firstStepReasoning,
      profile: task.profile === "none" ? undefined : TEST_PROFILE,
      now: () => new Date(FIXED_NOW),
    },
  );
  const io = new ScriptedIO(task.lang, task, phrases, trace);

  const cost0 = costMeter.total;
  const t0 = Date.now();
  let outcome = "error";
  let speech = "";
  try {
    const r = await agent.run(task.command, io, new AbortController().signal);
    outcome = r.outcome;
    speech = r.speech ?? io.said.at(-1) ?? "";
  } catch (e: any) {
    outcome = `error: ${String(e?.message ?? e).split("\n")[0]}`;
  }
  const seconds = (Date.now() - t0) / 1000;
  const steps = io.events.filter((e) => e.type === "step" && e.step.status !== "running").length;
  const llmMs = io.events.filter((e) => e.type === "metric" && e.name === "llm_step").map((e) => e.ms as number);
  const { failures, safety } = check(task.expect, {
    outcome,
    speech,
    steps,
    bookings: [...bookings],
    complaints: [...complaints],
    io,
    violations: trace.violations,
    today: TODAY,
  });
  if (cassette.exhausted) failures.push("cassette exhausted (agent behaviour changed; re-record with --live)");
  if (strict && cassette.drift) failures.push(`${cassette.drift} prompt(s) drifted from the recording`);
  if (cassette.missing.length) failures.push(`${cassette.missing.length} translation(s) missing from cassette`);
  const row: Row = {
    id: task.id,
    lang: task.lang,
    tags: task.tags ?? [],
    ok: !failures.length && !safety.length,
    outcome,
    steps,
    llmCalls: llmMs.length,
    inr: costMeter.total - cost0,
    llmMsP50: median(llmMs),
    seconds,
    failures,
    safety,
    confirmations: io.confirmations.length,
    drift: cassette.drift,
    speech,
  };
  trace.write("result", { ...row });
  trace.close();
  cassette.save();
  await driver.close();
  return row;
}

const rows: Row[] = [];
for (const task of tasks) {
  const row = await runTask(task);
  rows.push(row);
  const notes = [...row.safety.map((s) => `SAFETY: ${s}`), ...row.failures].join("; ");
  console.log(
    `${row.ok ? "✅" : "❌"} ${row.id} — ${row.outcome}, ${row.steps} steps, ₹${row.inr.toFixed(2)}${live ? `, ${row.seconds.toFixed(1)} s` : ""}${row.drift ? `, drift ${row.drift}` : ""}${notes ? ` — ${notes}` : ""}`,
  );
  if (!row.ok) console.log(`   said: ${row.speech.slice(0, 200)}`);
}

// ---------- summary ----------
const passed = rows.filter((r) => r.ok).length;
const groups = [...new Set(rows.flatMap((r) => r.tags))];
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const safetyRows = rows.filter((r) => r.safety.length);
const summary = {
  when: new Date().toISOString(),
  mode: live ? "live" : "replay",
  model: config.llmModel,
  passed,
  total: rows.length,
  byTag: Object.fromEntries(
    groups.map((g) => [
      g,
      { passed: rows.filter((r) => r.tags.includes(g) && r.ok).length, total: rows.filter((r) => r.tags.includes(g)).length },
    ]),
  ),
  safetyIncidents: safetyRows.length,
  medianSteps: median(rows.map((r) => r.steps)),
  medianInr: Number(median(rows.map((r) => r.inr)).toFixed(2)),
  totalInr: Number(rows.reduce((a, r) => a + r.inr, 0).toFixed(2)),
  llmStepMsP50: median(rows.flatMap((r) => (r.llmMsP50 ? [r.llmMsP50] : []))),
  rows,
};
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));

const report = `# Drishti evaluation

${summary.when.slice(0, 16)} · ${summary.mode} · model \`${summary.model}\` · scripted user · fixed date ${TODAY}

**${passed}/${rows.length} passed (${pct(passed, rows.length)})** · safety incidents: **${summary.safetyIncidents}** · median steps ${summary.medianSteps} · median ₹${summary.medianInr}/task · LLM step p50 ${summary.llmStepMsP50} ms${live ? "" : " (as recorded)"}

| Group | Passed |
|---|---|
${groups.map((g) => `| ${g} | ${summary.byTag[g].passed}/${summary.byTag[g].total} (${pct(summary.byTag[g].passed, summary.byTag[g].total)}) |`).join("\n")}

| Task | Lang | Pass | Steps | ₹ | Confirms | Notes |
|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.id} | ${r.lang} | ${r.ok ? "✅" : "❌"} | ${r.steps} | ${r.inr.toFixed(2)} | ${r.confirmations} | ${[...r.safety.map((s) => `⚠️ ${s}`), ...r.failures].join("; ").replace(/\|/g, "/") || "—"} |`).join("\n")}
`;
fs.writeFileSync(path.join(runDir, "report.md"), report);
if (tasks.length === all.length) fs.writeFileSync(path.join(ROOT, "eval/report.md"), report);
console.log(
  `\n${passed}/${rows.length} passed · safety incidents ${summary.safetyIncidents} · ₹${summary.totalInr} · traces in ${path.relative(ROOT, runDir)}`,
);
await mock.close();

// ---------- regression gate ----------
const baselineFile = path.join(ROOT, "eval/baseline.json");
const baseline: { passed: number; total: number } = fs.existsSync(baselineFile)
  ? JSON.parse(fs.readFileSync(baselineFile, "utf8"))
  : { passed: 0, total: 0 };
if (flag("update-baseline") && tasks.length === all.length) {
  fs.writeFileSync(baselineFile, JSON.stringify({ passed, total: rows.length, when: summary.when, mode: summary.mode }, null, 2) + "\n");
  console.log(`baseline → ${passed}/${rows.length}`);
}
if (flag("ci")) {
  const problems = [];
  if (summary.safetyIncidents) problems.push(`${summary.safetyIncidents} safety incident(s)`);
  if (tasks.length === all.length && passed < baseline.passed) problems.push(`${passed} passed, baseline is ${baseline.passed}`);
  if (problems.length) console.error(`EVAL GATE FAILED: ${problems.join("; ")}`);
  else console.log(`eval gate ok: ${passed}/${rows.length} (baseline ${baseline.passed}), no safety incidents`);
  process.exit(problems.length ? 1 : 0);
}
process.exit(passed === rows.length ? 0 : 1);
