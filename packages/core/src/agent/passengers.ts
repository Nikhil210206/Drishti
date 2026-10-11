/**
 * How many passengers the user asked for, and whether the page lists that many.
 *
 * A live run was asked for two tickets ("दो टिकट … एक मेरे लिए और एक मेरे पति के लिए"), filled in one
 * passenger, and wrote its own question as "2 passengers … ₹975". The readback named one person,
 * which a blind user has to catch by ear: the agent refuses the payment instead.
 *
 * The count is read only where it is said outright: a number right before "tickets" or a word for
 * people ("2 tickets", "दो लोगों", "இரண்டு பேருக்கு"), or a word that means so many people
 * ("ఇద్దరికి", "दोघांसाठी"). Anything less clear gives no count and no check: a wrong guess would
 * block a good booking. The Indic words are from references, not native speakers (see docs/phase-2.md).
 */
import { skeleton } from "./match.js";
import { readbackPassengers } from "./readback.js";

// Counting words for 1 to 6 (one booking holds at most six), by index. Latin "do" and "be" are
// left out: they are English words too.
const NUMBERS = [
  "",
  "one ek एक এক একটা একটি એક ਇੱਕ ਇਕ ଏକ ଗୋଟିଏ ஒரு ஒன்று ஒண்ணு ఒక ఒకటి ಒಂದು ഒരു ഒന്ന്",
  "two दो दोन দুই দু দুটো দুটি দুটা দুইটা দুইটি બે ਦੋ ଦୁଇ ଦୁଇଟି ଦୁଇଟା இரண்டு ரெண்டு రెండు ಎರಡು രണ്ട് രണ്ടു",
  "three teen तीन তিন তিনটে তিনটি তিনটা ત્રણ ਤਿੰਨ ତିନି ତିନୋଟି ତିନିଟି மூன்று மூணு మూడు ಮೂರು മൂന്ന് മൂന്നു",
  "four चार চার চারটে চারটি চারটা ચાર ਚਾਰ ଚାରି ଚାରୋଟି ଚାରିଟି நான்கு நாலு నాలుగు ನಾಲ್ಕು നാല് നാലു",
  "five पांच पाँच पाच পাঁচ পাঁচটা পাঁচটি પાંચ ਪੰਜ ପାଞ୍ଚ ପାଞ୍ଚଟି ஐந்து அஞ்சு ఐదు అయిదు ಐದು അഞ്ച് അഞ്ചു",
  "six छह छः छे सहा ছয় ছয়টা ছয়টি છ ਛੇ ଛଅ ଛଅଟି ஆறு ఆరు ಆರು ആറ് ആറു",
];
const nfc = (s: string) => s.normalize("NFC");
const NUMBER = new Map<string, number>(
  NUMBERS.flatMap((words, n) =>
    words
      .split(" ")
      .filter(Boolean)
      .map((w) => [nfc(w), n] as [string, number]),
  ),
);
const NUMBER_WORDS = [...NUMBER.keys()].sort((a, b) => b.length - a.length);

// One word for "so many people": ఇద్దరు, ఇద్దరికి (Telugu); ಇಬ್ಬರು, ಇಬ್ಬರಿಗೆ (Kannada); இருவர் (Tamil);
// दोघे, दोघांसाठी (Marathi). Matched by how the word starts.
const PEOPLE: [string, number][] = (
  [
    ["ఇద్దర", 2],
    ["ముగ్గుర", 3],
    ["నలుగుర", 4],
    ["ಇಬ್ಬರ", 2],
    ["ಮೂವರ", 3],
    ["ನಾಲ್ವರ", 4],
    ["இருவர", 2],
    ["மூவர", 3],
    ["நால்வர", 4],
    ["दोघ", 2],
    ["तिघ", 3],
    ["चौघ", 4],
  ] as [string, number][]
).map(([w, n]) => [nfc(w), n]);
// A number written together with its word for people: দুজনের, ଦୁଇଜଣ, രണ്ടുപേർക്ക്, ரெண்டுபேர்.
const JOINED = ["জন", "ଜଣ", "പേർ", "പേര", "பேர"].map(nfc);

// Words for people, after a number. Whole words where a longer word could be something else
// ("जन" is a person, "जनवरी" is January), and word starts where endings vary.
const NOUNS = new Set(
  "passenger passengers people person persons adult adults traveller travellers traveler travelers seat seats berth berths pax members जन जने जनों जण लोक सीट सीटें सीटों জন লোক ଜଣ ଲୋକ જણ જણા જણને ਲੋਕ ਜਣੇ ਬੰਦੇ ஆள் ஆட்கள் ಜನ ಜನರು ಜನರಿಗೆ ಜನಕ್ಕೆ ആൾ"
    .split(" ")
    .map(nfc),
);
// Malayalam writes "ticket" as ടിക്കറ്റ്, which the skeleton below reads as "tkr": hence "ടിക്ക".
const NOUN_STARTS =
  "लोग लोकां यात्री यात्रि सवारी सवारि व्यक्ति व्यक्ती जणां प्रवासी प्रवाशां জনের জনকে লোকের যাত্রী ଜଣଙ୍କ ଯାତ୍ରୀ લોકો વ્યક્તિ મુસાફર ਲੋਕਾਂ ਯਾਤਰੀ ਸਵਾਰੀ பேர நபர பயணி మంది ప్రయాణిక ప్రయాణీక ಮಂದಿ ಪ್ರಯಾಣಿಕ പേർ പേര യാത്രക്കാ ആളുക ടിക്ക"
    .split(" ")
    .map(nfc);

/** "ticket" in any script (टिकट, টিকিট, டிக்கெட், తికెట్, तिकीट …) reduces to "tkt". */
const isNoun = (w: string) => NOUNS.has(w) || NOUN_STARTS.some((s) => w.startsWith(s)) || skeleton(w).startsWith("tkt");

// "two sleeper tickets", "दो तत्काल टिकट": one such word may stand between the number and the noun.
// Never "tier", "AC" or a month, so "3 tier ticket" and "6 October ticket" stay class and date.
const BETWEEN = new Set(["slpr", "tkl", "gnrl", "jnrl"]); // sleeper, tatkal, general (जनरल)
const mayStandBetween = (w: string) => BETWEEN.has(skeleton(w));

// "कर दो टिकट" is "do book the ticket", not two tickets.
const GIVE = new Set(["दो", "ਦੋ"].map(nfc));
const BEFORE_GIVE = new Set(["कर", "करा", "करवा", "दे", "दिला", "दिलवा", "बता", "बना", "ਕਰ", "ਕਰਾ", "ਦੇ", "ਦਿਵਾ"].map(nfc));

/** Indic digits (२, ௨, ೨ …) as ASCII: the scripts' blocks share one layout. */
const asciiDigits = (s: string) =>
  s.replace(/[ऀ-ൿ]/g, (ch) => {
    const off = ch.codePointAt(0)! & 0x7f;
    return off >= 0x66 && off <= 0x6f ? String(off - 0x66) : ch;
  });

function numberOf(word: string): number | undefined {
  if (/^[1-9]$/.test(word)) return Number(word);
  return NUMBER.get(word);
}

/** Every passenger count the texts state, in the order said. */
function counts(text: string): number[] {
  const out: number[] = [];
  const words = asciiDigits(nfc(text).toLowerCase())
    .split(/[\s,.;:!?()"'।॥/–—-]+/)
    .filter(Boolean);
  words.forEach((w, i) => {
    const n = numberOf(w);
    if (n !== undefined) {
      if (GIVE.has(w) && BEFORE_GIVE.has(words[i - 1] ?? "")) return;
      const next = words[i + 1] ?? "";
      const after = words[i + 2] ?? "";
      // "two of us"
      if (isNoun(next) || (mayStandBetween(next) && isNoun(after)) || (next === "of" && after === "us")) out.push(n);
      return;
    }
    const people = PEOPLE.find(([start]) => w.startsWith(start));
    if (people) return void out.push(people[1]);
    const lead = NUMBER_WORDS.find((x) => w.startsWith(x) && JOINED.some((j) => w.startsWith(j, x.length)));
    if (lead) out.push(NUMBER.get(lead)!);
  });
  return out;
}

/**
 * How many passengers the user asked for: the last count they stated, when it is two or more.
 * "One ticket" gives nothing: "एक टिकट" is also just "a ticket", and "two tickets, one ticket for me
 * and one for Ravi" ends on a one.
 */
export function requestedPassengers(texts: string[]): number | undefined {
  const last = texts.flatMap(counts).at(-1);
  return last !== undefined && last >= 2 ? last : undefined;
}

/**
 * "" unless the user stated a count and the page's readback lists another number of passengers.
 * Only a list in the form the readback knows, "Name (age, gender), …", is counted.
 */
export function passengerMismatch(userTexts: string[], facts: string): string {
  const want = requestedPassengers(userTexts);
  if (!want) return "";
  const listed = readbackPassengers(facts);
  if (!listed.length || !listed.every((p) => /\([^()]+\)$/.test(p)) || listed.length === want) return "";
  return `the user asked for ${want} passengers, but the page lists ${listed.length} (${listed.join(", ")})`;
}
