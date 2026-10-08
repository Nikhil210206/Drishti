/**
 * The travel date the user asked for, and whether a booking is for that date.
 *
 * Live traces showed the right date said but the wrong one clicked ("Tomorrow" narrated, [12]
 * "Day after" clicked), and a date skipped altogether. The readback tells the user the page's date,
 * but a booking on another date should not even reach the question.
 */

// Relative days in the 11 languages. Day-after words come first: "நாளை மறுநாள்" contains "நாளை".
// Indic words may carry suffixes (நாளைக்கு, কালকে), so only the start must be a word boundary;
// short words that start other words (कल → कलम, કાલ → Kalupur) must also end at one.
const START = "(?<![\\p{L}\\p{M}])";
const END = "(?![\\p{L}\\p{M}])";
const RELATIVE: [number, RegExp][] = [
  [
    2,
    new RegExp(
      `day after tomorrow|${START}(parso|parson|परसों|परसो|परवा|நாளை\\s*மறுநாள்|ఎల్లుండి|ನಾಡಿದ್ದು|മറ്റന്നാൾ|পরশু|પરમ\\s*દિવસ|પરમદિવસ|ਪਰਸੋਂ|ପଅରଦିନ|ପରଦିନ)`,
      "iu",
    ),
  ],
  [1, new RegExp(`\\btomorrow\\b|${START}(kal|कल|उद्या|કાલ)${END}|${START}(நாளை|రేపు|ನಾಳೆ|നാളെ|আগামীকাল|কাল|કાલે|ਕੱਲ੍ਹ|ਕੱਲ|କାଲି)`, "iu")],
  [0, new RegExp(`\\btoday\\b|${START}(aaj|आज|இன்று|ఈ\\s*రోజు|ఈరోజు|ಇಂದು|ഇന്ന്|আজ|આજે|ਅੱਜ|ଆଜି)`, "iu")],
];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
const EXPLICIT = [
  new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, "i"),
  new RegExp(`\\b${MONTH}\\s+(\\d{1,2})\\b`, "i"),
];
// The page's own dates, as Pathik and most Indian sites print them: "Tue, 6 Oct, 2026", "06 Oct 2026".
const PAGE_DATE = new RegExp(`\\b(\\d{1,2})\\s+${MONTH},?\\s+(\\d{4})\\b`, "gi");

/** Today's calendar date in India, as a UTC-midnight Date for day arithmetic. */
function istDay(now: Date): Date {
  const [y, m, d] = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const key = (d: Date) => d.toISOString().slice(0, 10);
const say = (d: Date) => d.toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

/** The one date the user asked for, or undefined when they named none, or several. */
export function requestedDate(texts: string[], now: Date): Date | undefined {
  const today = istDay(now);
  const found = new Set<string>();
  for (const t of texts) {
    for (const [offset, re] of RELATIVE) {
      if (re.test(t)) {
        found.add(key(addDays(today, offset)));
        break; // "day after tomorrow" also contains "tomorrow"
      }
    }
    for (const re of EXPLICIT) {
      const m = t.match(re);
      if (!m) continue;
      const [day, mon] = /^\d/.test(m[1]) ? [Number(m[1]), m[2]] : [Number(m[2]), m[1]];
      const month = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
      let d = new Date(Date.UTC(today.getUTCFullYear(), month, day));
      if (d < today) d = new Date(Date.UTC(today.getUTCFullYear() + 1, month, day));
      found.add(key(d));
    }
  }
  return found.size === 1 ? new Date(`${[...found][0]}T00:00:00Z`) : undefined;
}

/** Dates printed in page text ("Tue, 6 Oct, 2026"), as YYYY-MM-DD. */
export function pageDates(text: string): string[] {
  return [...text.matchAll(PAGE_DATE)].map((m) =>
    key(new Date(Date.UTC(Number(m[3]), MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), Number(m[1])))),
  );
}

/**
 * "" when the booking is for the requested date, else why not. Only applies when the user named
 * exactly one date and the page text shows exactly one.
 */
export function dateMismatch(userTexts: string[], shown: string, now: Date): string {
  return mismatch(userTexts, pageDates(shown), now);
}

/**
 * The same for a results page, from its address ("#/results?…&date=2026-10-29"): a live run
 * searched 29 Oct for "tomorrow" and answered "tomorrow, 29 October". Only when the address
 * carries exactly one date, so an article's own date never counts.
 */
export function urlDateMismatch(userTexts: string[], url: string, now: Date): string {
  return mismatch(userTexts, url.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [], now);
}

function mismatch(userTexts: string[], shown: string[], now: Date): string {
  const want = requestedDate(userTexts, now);
  if (!want) return "";
  const dates = new Set(shown);
  if (dates.size !== 1) return "";
  const [got] = dates;
  if (got === key(want)) return "";
  const rel = ["today", "tomorrow", "the day after tomorrow"][Math.round((want.getTime() - istDay(now).getTime()) / 86400000)];
  return `the user asked for ${rel ? `${rel} (${say(want)})` : say(want)}, but this is for ${say(new Date(`${got}T00:00:00Z`))}`;
}
