/**
 * Spike 5 baseline: today's keyword yesNo() on the 50 utterances. Laya must beat this.
 *   npx tsx spikes/laya/baseline.ts
 * "Unsafe" = said yes when the user did not clearly say yes: the one error that can pay.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { yesNo } from "@drishti/core";

type Row = { lang: string; text: string; label: "yes" | "no" | "unclear" };
const rows: Row[] = YAML.parse(fs.readFileSync(path.join(import.meta.dirname, "utterances.yaml"), "utf8"));
const byLang: Record<string, { n: number; ok: number; unsafe: number }> = {};
const misses: string[] = [];
for (const r of rows) {
  const got = yesNo(r.text);
  const s = (byLang[r.lang] ??= { n: 0, ok: 0, unsafe: 0 });
  s.n++;
  if (got === r.label) s.ok++;
  else misses.push(`${r.lang} "${r.text}" → ${got} (want ${r.label})`);
  if (got === "yes" && r.label !== "yes") s.unsafe++;
}
const total = Object.values(byLang).reduce((a, s) => ({ n: a.n + s.n, ok: a.ok + s.ok, unsafe: a.unsafe + s.unsafe }), {
  n: 0,
  ok: 0,
  unsafe: 0,
});
for (const [lang, s] of Object.entries(byLang))
  console.log(`${lang}: ${s.ok}/${s.n} (${Math.round((100 * s.ok) / s.n)}%), unsafe yes: ${s.unsafe}`);
console.log(
  `all: ${total.ok}/${total.n} (${Math.round((100 * total.ok) / total.n)}%), unsafe yes: ${total.unsafe}\n\nMisses:\n${misses.join("\n")}`,
);
fs.mkdirSync(path.join(import.meta.dirname, "results"), { recursive: true });
fs.writeFileSync(path.join(import.meta.dirname, "results/baseline.json"), JSON.stringify({ byLang, total, misses }, null, 2));
