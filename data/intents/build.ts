/**
 * Labelled utterances for Drishti's fast path (Laya track, Phase 1): confirmation answers,
 * voice controls, and the read / task / chat split, in all 11 languages.
 *
 *   npx tsx data/intents/build.ts            rebuild from sources (no API calls)
 *   npx tsx data/intents/build.ts --translate  also machine-translate the English templates (costs ₹)
 *
 * Sources, each row tagged with where it came from:
 *   - spikes/laya/utterances.yaml   hand-written confirmation replies (hi, ta, bn)
 *   - eval/tasks/*.yaml             real eval commands → "task" or "read"
 *   - templates.yaml                English templates; --translate adds Sarvam Mayura
 *                                   translations, cached in translations.json, marked needs_review
 * Output: intents.jsonl (one {text, lang, intent, source, needs_review} per line) and a summary.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { LANGS, type LangCode } from "@drishti/core";
import { SarvamTranslator } from "@drishti/providers";
import { ROOT, config, requireApiKey } from "../../apps/dev-harness/src/config.js";
import { loadTasks } from "../../eval/lib/tasks.js";

export type Intent =
  | "confirm.yes"
  | "confirm.no"
  | "confirm.unclear"
  | "control.stop"
  | "control.repeat"
  | "control.faster"
  | "control.slower"
  | "read"
  | "task"
  | "chat";

interface Row {
  text: string;
  lang: LangCode;
  intent: Intent;
  source: string;
  needs_review: boolean;
}

const here = path.join(ROOT, "data/intents");
const rows: Row[] = [];
const add = (r: Row) => {
  if (!rows.some((x) => x.text === r.text && x.lang === r.lang)) rows.push(r);
};

// 1. Hand-written confirmation replies from spike 5.
type Spike = { lang: LangCode; text: string; label: "yes" | "no" | "unclear" };
for (const u of YAML.parse(fs.readFileSync(path.join(ROOT, "spikes/laya/utterances.yaml"), "utf8")) as Spike[]) {
  add({ text: u.text, lang: u.lang, intent: `confirm.${u.label}`, source: "spike5", needs_review: true });
}

// 2. Eval commands: reading tasks start on a saved page and ask about it; the rest are tasks.
for (const t of loadTasks(path.join(ROOT, "eval/tasks"))) {
  const reading = t.tags?.includes("reading") || /what.*page|पेज पर क्या|page எதை/i.test(t.command);
  add({ text: t.command, lang: t.lang, intent: reading ? "read" : "task", source: `eval:${t.id}`, needs_review: false });
}

// 3. English templates, plus cached machine translations.
const templates: Record<Intent, string[]> = YAML.parse(fs.readFileSync(path.join(here, "templates.yaml"), "utf8"));
const cacheFile = path.join(here, "translations.json");
const cache: Record<string, string> = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
const translate = process.argv.includes("--translate");
const translator = translate ? (requireApiKey(), new SarvamTranslator({ apiKey: config.apiKey })) : undefined;

for (const [intent, texts] of Object.entries(templates) as [Intent, string[]][]) {
  for (const en of texts) {
    add({ text: en, lang: "en-IN", intent, source: "template", needs_review: false });
    for (const lang of Object.keys(LANGS) as LangCode[]) {
      if (lang === "en-IN") continue;
      const key = `${lang}|${en}`;
      if (!cache[key] && translator) cache[key] = await translator.translate(en, lang, { source: "en-IN", mode: "modern-colloquial" });
      if (cache[key]) add({ text: cache[key], lang, intent, source: "template+mayura", needs_review: true });
    }
  }
}
if (translate) fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1) + "\n");

fs.writeFileSync(path.join(here, "intents.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const table: Record<string, Record<string, number>> = {};
for (const r of rows) (table[r.intent] ??= {})[r.lang] = (table[r.intent][r.lang] ?? 0) + 1;
console.log(`${rows.length} utterances → data/intents/intents.jsonl`);
console.table(table);
