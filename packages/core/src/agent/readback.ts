/**
 * What the page itself says about an irreversible action, read back with every confirmation.
 *
 * The model writes the confirmation question, and traces showed it can be wrong: it asked "book
 * for 12 October?" while the page held a ticket for 6 October. The readback comes from the page,
 * so a user always hears the facts they are agreeing to.
 */
import type { ElementInfo, Snapshot } from "../types.js";

const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*";
const DATE = new RegExp(`\\b(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\\s+)?\\d{1,2}\\s+${MONTH},?\\s+\\d{4}\\b`, "g");
const TRAIN_NO = /\((\d{4,5})\)/g;
const LABELS = [
  "Train",
  "Date",
  "Class",
  "Quota",
  "Passengers?",
  "Total",
  "Amount payable",
  "Grand total",
  "Deliver to",
  "Pay to",
  "Category",
];
const LABELLED = new RegExp(
  `\\b(${LABELS.join("|")})\\s*:?\\s+(.{1,70}?)(?=\\s+(?:${LABELS.join("|")}|From|To|Ticket fare|Convenience fee)\\b|\\s*$|\\s+·)`,
  "gi",
);

const distinct = (xs: string[]) => [...new Set(xs.map((x) => x.trim()))];

export function readback(snap: Snapshot, id: string | number, el: ElementInfo | undefined): string {
  const facts: string[] = [];
  const lines = snap.text.split("\n");

  // The row the control sits in (a train in a results list): its name and number.
  const line = lines.find((l) => l.includes(`[${id}] `)) ?? "";
  if (line.startsWith("ROW:")) {
    const before = line.slice(0, line.indexOf(`[${id}] `));
    const train = before.match(/ROW:\s*([^·]{3,70}?)\s*·\s*\((\d{4,5})\)/);
    if (train) facts.push(`${train[1].trim()} (${train[2]})`);
  }
  if (el?.name && /₹|\d/.test(el.name)) facts.push(el.name);

  // Page-level facts, only on a page about one booking (one date, one train number).
  const text = lines.filter((l) => l.startsWith("- ")).join(" ");
  const dates = distinct(text.match(DATE) ?? []);
  const trains = distinct([...text.matchAll(TRAIN_NO)].map((m) => m[1]));
  if (dates.length <= 1 && trains.length <= 1) {
    const seen = new Set<string>();
    for (const m of text.matchAll(LABELLED)) {
      const label = m[1].toLowerCase().replace(/s$/, "");
      if (seen.has(label)) continue;
      seen.add(label);
      facts.push(`${m[1]} ${m[2].trim()}`);
    }
    // The page's own one-line summary often carries details the labels miss, like the quota:
    // "Express (20162) · SBC 19:50 → MYS 22:40 · Tue, 6 Oct, 2026 · SL · Tatkal". Only on a page
    // about exactly one train, never on a results list.
    const summary =
      dates.length === 1 && trains.length === 1 ? lines.find((l) => l.startsWith("- ") && l.includes(dates[0]) && l.includes(" · ")) : "";
    const parts = summary ? summary.slice(2).split(" · ") : [];
    const at = parts.findIndex((x) => x.includes(dates[0]));
    if (at >= 0)
      facts.push(
        parts
          .slice(at, at + 3)
          .map((x, k) => (k === 0 ? x : x.split(" ").slice(0, 2).join(" ")))
          .join(" · "),
      );
    else if (!seen.has("date") && dates.length === 1) facts.push(dates[0]);
  }
  return distinct(facts).join("; ").slice(0, 300);
}

/** The passengers a readback lists ("Passengers Asha Verma (34, Female), Ravi Verma (36, Male)"). */
export function readbackPassengers(facts: string): string[] {
  const m = facts.match(/\bPassengers?\s+(.+?)(?:;|$)/i);
  if (!m) return [];
  return m[1]
    .split(/(?<=\)),\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** The same person listed twice: almost always a slip that books a ticket nobody asked for. */
export function duplicatePassenger(facts: string): string {
  const seen = new Set<string>();
  for (const p of readbackPassengers(facts)) {
    const k = p.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(k)) return `the same passenger is listed twice (${p})`;
    seen.add(k);
  }
  return "";
}

/** The page says the task finished: a PNR, a reference or complaint number, a success message. */
export function looksComplete(snap: Snapshot): boolean {
  return /\bPNR\b[^a-z]{0,20}\d{6,}|booking (is )?confirmed|successfully (booked|submitted|placed|paid)|order (is )?placed|payment (is )?successful|complaint (is )?(registered|submitted)|reference (no\.?|number|id)\s*:?\s*\w+|\bCMP\d+/i.test(
    `${snap.title}\n${snap.text}`,
  );
}
