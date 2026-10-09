/**
 * Add the machine translation of new fixed phrases to the recorded cassettes, without re-recording
 * the runs. A replay that now says a new phrase in a language without a hand-written table would
 * otherwise fail with "translation missing". One Sarvam call per phrase and language (paise).
 *
 *   npx tsx eval/top-up-phrases.ts confirmLead [otherPhraseKey…]
 */
import fs from "node:fs";
import path from "node:path";
import { PHRASES, type LangCode, type PhraseKey } from "@drishti/core";
import { SarvamTranslator } from "@drishti/providers";
import { ROOT, config, requireApiKey } from "../apps/dev-harness/src/config.js";
import { sha } from "./lib/cassette.js";
import { loadTasks } from "./lib/tasks.js";

const keys = process.argv.slice(2) as PhraseKey[];
if (!keys.length || keys.some((k) => !(k in PHRASES))) throw new Error(`Name phrase keys from PHRASES: ${Object.keys(PHRASES).join(", ")}`);
requireApiKey();
const translator = new SarvamTranslator({ apiKey: config.apiKey });

const done = new Map<string, string>();
let added = 0;
for (const task of loadTasks(path.join(ROOT, "eval/tasks"))) {
  const file = path.join(ROOT, "eval/cassettes", `${task.id}.json`);
  if (!fs.existsSync(file)) continue;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  let changed = false;
  for (const key of keys) {
    const table = PHRASES[key] as Partial<Record<LangCode, string>>;
    if (table[task.lang]) continue; // hand-written: no translation asked for
    const text = table["en-IN"]!;
    const opts = { source: "en-IN" };
    // The key Cassette.translator looks PhraseBook's calls up by.
    const k = sha({ text, target: task.lang, opts });
    if (data.translate[k] !== undefined) continue;
    const once = `${key}|${task.lang}`;
    if (!done.has(once)) done.set(once, await translator.translate(text, task.lang, opts));
    data.translate[k] = done.get(once);
    changed = true;
    added++;
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(data, null, 1) + "\n");
}
console.log(`${added} translation(s) added to cassettes, ${done.size} asked of Sarvam:`);
for (const [k, v] of done) console.log(`  ${k}: ${v}`);
