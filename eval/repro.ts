/**
 * Run one command live against Pathik Rail (Playwright, real Sarvam LLM) and keep its trace, to see
 * exactly where a task goes wrong. Costs a rupee or two.
 *
 *   npx tsx eval/repro.ts <lang> "<command>" [answer…]
 *
 * Answers are given in order to Drishti's questions and confirmations; after them it hears nothing.
 * The trace goes to eval/runs/repro-<time>.jsonl (open with eval/viewer/index.html).
 */
import path from "node:path";
import { Agent, MemoryCache, NavigationPolicy, PhraseBook, DEFAULT_ALLOWED_DOMAINS, isLangCode } from "@drishti/core";
import { SarvamDocReader, SarvamLLM, SarvamTranslator, costMeter } from "@drishti/providers";
import { ROOT, config, requireApiKey } from "../apps/dev-harness/src/config.js";
import { PlaywrightDriver } from "../apps/dev-harness/src/playwright-driver.js";
import { startMockSite } from "../apps/dev-harness/src/mock-server.js";
import { Trace } from "./lib/tracing.js";
import { ScriptedIO } from "./lib/scripted-io.js";
import { TEST_PROFILE } from "./lib/tasks.js";

const [lang, command, ...answers] = process.argv.slice(2);
if (!isLangCode(lang) || !command) throw new Error('Usage: npx tsx eval/repro.ts ta-IN "<command>" [answer…]');
requireApiKey();

const mock = await startMockSite();
const file = path.join(ROOT, "eval/runs", `repro-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.jsonl`);
const trace = new Trace(file);
const driver = new PlaywrightDriver({ headless: !process.argv.includes("--headed") });
const home = `http://localhost:${config.mockPort}/`;
await driver.ensure(home);
const auth = { apiKey: config.apiKey };
const translator = new SarvamTranslator(auth);
const phrases = new PhraseBook(translator, new MemoryCache());
const agent = new Agent(
  {
    browser: trace.driver(driver),
    llm: trace.llm(new SarvamLLM({ ...auth, model: config.llmModel })),
    translator,
    docs: new SarvamDocReader(auth),
    phrases,
    policy: new NavigationPolicy(DEFAULT_ALLOWED_DOMAINS),
  },
  { maxSteps: config.maxSteps, firstStepReasoning: config.firstStepReasoning, profile: TEST_PROFILE },
);
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const io = new ScriptedIO(lang, { id: "repro", lang, command, answers, confirms: answers, expect: {} } as any, phrases, trace, today);
const r = await agent.run(command, io, new AbortController().signal);
console.log(`outcome: ${r.outcome} · ₹${costMeter.total.toFixed(2)} · trace ${path.relative(ROOT, file)}`);
for (const s of io.said) console.log(`  said: ${s}`);
trace.close();
await driver.close();
await mock.close();
process.exit(0);
