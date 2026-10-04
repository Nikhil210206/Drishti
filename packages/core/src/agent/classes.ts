/**
 * Travel classes the user asked for, and the class a booking control would book.
 *
 * Live traces showed the model booking a cheaper or emptier class than the one asked for
 * (Sleeper for "second sitting", Sleeper for "chair car"). The readback tells the user, but a
 * wrong class should not even reach the question: the agent refuses the click instead.
 */
import { skeleton } from "./match.js";

export const CLASS_NAMES: Record<string, string> = {
  SL: "Sleeper",
  "3A": "AC 3 tier",
  "2A": "AC 2 tier",
  "1A": "First AC",
  CC: "AC Chair Car",
  "2S": "Second Sitting",
  "3E": "AC 3 economy",
  EC: "Executive Chair Car",
};

// How users say them: in English letters (also inside Indic sentences), and a few spoken forms
// that the consonant skeleton recognises in any script (स्लीपर, ஸ்லீப்பர், স্লিপার → "slpr").
const SPOKEN: [string, RegExp][] = [
  ["SL", /\bsleeper\b|\bSL\b/i],
  ["3A", /\b3\s*-?\s*tier\b|\bthree\s*tier\b|\bthird\s*ac\b|\b3\s*ac\b|\b3A\b/i],
  ["2A", /\b2\s*-?\s*tier\b|\btwo\s*tier\b|\bsecond\s*ac\b|\b2\s*ac\b|\b2A\b/i],
  ["1A", /\bfirst\s*(ac|class)\b|\b1\s*ac\b|\b1A\b/i],
  ["CC", /\bchair\s*car\b|\bCC\b/i],
  ["2S", /\bsecond\s*sitting\b|\b2S\b/i],
  ["3E", /\b3\s*e(conomy)?\b/i],
  ["EC", /\bexecutive\b|\bEC\b/i],
];
const SKELETONS: [string, string][] = [
  ["SL", "slpr"], // sleeper
  ["CC", "crkr"], // चेयर कार, चेअर कार
];

/** Class codes named anywhere in what the user said. Empty when they named none. */
export function requestedClasses(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const [code, re] of SPOKEN) if (re.test(t)) out.add(code);
    const sk = skeleton(t);
    for (const [code, s] of SKELETONS) if (sk.includes(s)) out.add(code);
  }
  return out;
}

/** Class codes a control or page text shows, e.g. "book ticket (SL ₹160 21)" → SL. */
export function shownClasses(text: string): Set<string> {
  return new Set([...text.matchAll(/(?<![A-Za-z0-9])(SL|3A|2A|1A|CC|2S|3E|EC)(?![A-Za-z0-9])/g)].map((m) => m[1]));
}

/**
 * "" when the booking matches, else why not. Only applies when the user named a class and the
 * control (or, for a confirmation, the page's own readback) shows exactly one class.
 */
export function classMismatch(userTexts: string[], shown: string): string {
  const want = requestedClasses(userTexts);
  const got = shownClasses(shown);
  if (!want.size || got.size !== 1) return "";
  const [code] = got;
  if (want.has(code)) return "";
  const asked = [...want].map((c) => `${CLASS_NAMES[c]} (${c})`).join(" or ");
  return `the user asked for ${asked}, but this books ${CLASS_NAMES[code] ?? code} (${code})`;
}

// Quotas. Tatkal is the one people ask for by name, in every script: तत्काल, தட்கல், তৎকাল and
// "tatkal" all reduce to the skeleton "tkl". Matched per word, since "टिकट क्लास" ("ticket class")
// also contains "tkl" across the two words.
const QUOTAS: [string, (word: string) => boolean][] = [
  ["Tatkal", (w) => skeleton(w).startsWith("tkl")],
  ["Ladies", (w) => /^ladies$/i.test(w)],
];
const SHOWN_QUOTA = /(?<![A-Za-z])(General|Premium Tatkal|Tatkal|Ladies|Senior Citizen)(?![A-Za-z])/g;

/** Quotas the user named ("Tatkal", "Ladies"). Empty means General, or that they named none. */
export function requestedQuotas(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const w of t.split(/[\s,.;:!?()"'।-]+/)) for (const [q, test] of QUOTAS) if (w && test(w)) out.add(q);
  if (texts.some((t) => /senior\s*citizen/i.test(t))) out.add("Senior Citizen");
  return out;
}

/** "" unless the user named a quota and the page shows exactly one other quota. */
export function quotaMismatch(userTexts: string[], shown: string): string {
  const want = requestedQuotas(userTexts);
  const got = new Set([...shown.matchAll(SHOWN_QUOTA)].map((m) => m[1]));
  if (!want.size || got.size !== 1) return "";
  const [quota] = got;
  return want.has(quota) ? "" : `the user asked for the ${[...want].join(" or ")} quota, but this is ${quota}`;
}
