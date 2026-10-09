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
  // A value also ends where the next page line begins (" - "): Pathik's "Total ₹570" is followed by
  // the footer, and was never read back.
  `\\b(${LABELS.join("|")})\\s*:?\\s+(.{1,70}?)(?=\\s+(?:${LABELS.join("|")}|From|To|Ticket fare|Convenience fee)\\b|\\s+-\\s|\\s*$|\\s+·)`,
  "gi",
);

// Passenger lists run long: three people overflowed the 70 characters above, so a live run paid for
// "Asha Verma (34, Female)" three times with nothing in the readback to catch it.
const PASSENGERS = /\bPassengers?\s*:?\s+((?:[^()]{1,60}\([^)]{1,30}\)(?:,\s*)?){1,9})/i;

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
    const people = text.match(PASSENGERS);
    if (people) {
      facts.push(`Passengers ${people[1].trim().replace(/,$/, "")}`);
      seen.add("passenger");
    }
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
  return distinct(facts).join("; ").slice(0, 500);
}

/**
 * A payment's readback as it is spoken: the amount, then only what a user checks, once each —
 * train, date, class, the quota when it matters, and the passengers last. The full readback
 * repeats the date and class in the page's summary line, and used to follow the model's own
 * restatement of it all: a tester found the result confusing.
 */
export interface SpokenFacts {
  amount?: number;
  train: string;
  date: string;
  /** The class code ("SL", "3A"), whichever way the page wrote the class. */
  cls: string;
  quota: string;
  text: string;
}

export function spokenFacts(facts: string, opts: { quotaAsked?: boolean } = {}): SpokenFacts {
  let amount: number | undefined;
  let train = "";
  let date = "";
  let cls = "";
  let quota = "";
  let passengers = "";
  const others: string[] = [];
  const money = (s: string) => {
    const m = s.match(/₹\s?(\d[\d,]*)/);
    return m ? Number(m[1].replace(/,/g, "")) : undefined;
  };
  for (const part of facts.split(/;\s*/).filter(Boolean)) {
    let m: RegExpMatchArray | null;
    if (/^Passengers?\s/i.test(part)) passengers = part;
    else if ((m = part.match(/^(?:Total|Amount payable|Grand total)\s+(.*)$/i))) amount = money(m[1]) ?? amount;
    else if ((m = part.match(/^Train\s+(.+?)(?:\s*\(\d{4,5}\))?$/i))) train = m[1];
    else if ((m = part.match(/^Date\s+(.+)$/i))) date = m[1];
    else if ((m = part.match(/^Class\s+(.+)$/i))) cls = m[1];
    else if ((m = part.match(/^Quota\s+.*?\b(General|Premium Tatkal|Tatkal|Ladies|Senior Citizen)\b/i))) quota = m[1];
    else if (part.includes(" · ")) {
      // The page's summary line ("Tue, 6 Oct, 2026 · SL · Tatkal Payment"): only what's missing.
      const bits = part.split(" · ");
      date ||= bits.find((b) => /\d{4}/.test(b)) ?? "";
      cls ||= bits.find((b) => /^(SL|3A|2A|1A|CC|2S|3E|EC)$/.test(b)) ?? "";
      quota ||= bits.map((b) => b.match(/^(General|Premium Tatkal|Tatkal|Ladies|Senior Citizen)\b/)?.[1]).find(Boolean) ?? "";
    } else if ((m = part.match(/^(.{3,70}?)\s*\((\d{4,5})\)$/))) train ||= m[1];
    else if (money(part) !== undefined)
      amount ??= money(part); // the control itself: "PAY ₹570"
    // Only facts a user checks; anything else ("· 1 trains found") is page chrome.
    else if (/^(Deliver to|Pay to|Category)\s/i.test(part)) others.push(part);
  }
  const said = quota === "General" && !opts.quotaAsked ? "" : quota;
  const text = [amount !== undefined ? `₹${amount}` : "", train, date, cls, said && `${said} quota`, ...others, passengers]
    .filter(Boolean)
    .join("; ");
  const code = cls.match(/\b(SL|3A|2A|1A|CC|2S|3E|EC)\b/)?.[1] ?? "";
  return { amount, train, date: date.replace(/\s+/g, " ").trim(), cls: code, quota, text };
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
