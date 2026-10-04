/**
 * Did the user say this? Names come in one script and get typed in another ("रवि वर्मा" said,
 * "Ravi Verma" typed), so compare consonant skeletons that ignore script and vowels.
 *
 * The Unicode blocks of Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada
 * and Malayalam share one layout (from ISCII): the same offset is the same consonant in each.
 */

// Offsets 0x15–0x39 within a block: क ख ग घ ङ | च छ ज झ ञ | ट ठ ड ढ ण | त थ द ध न ऩ | प फ ब भ म | य र ऱ ल ळ ऴ व | श ष स ह
// (य is dropped like Latin "y", which the Latin side treats as a vowel.)
const CONSONANTS = "k k g g n c c j j n t t d d n t t d d n n p p b b m _ r r l l l b s s s h".split(" ").map((c) => (c === "_" ? "" : c));
// Latin spellings folded the same way.
const LATIN: [RegExp, string][] = [
  [/ph|f/g, "p"],
  [/bh/g, "b"],
  [/kh|q|ck/g, "k"],
  [/gh/g, "g"],
  [/chh|ch|c/g, "c"],
  [/jh|z/g, "j"],
  [/th/g, "t"],
  [/dh/g, "d"],
  [/sh|x/g, "s"],
  // Bengali and Odia write "v" with ব/ବ (b): treat v, w and b as one sound.
  [/[vw]/g, "b"],
];

/** Consonants and digits only, script-free: "Ravi Verma" and "रवि वर्मा" both give "rbrm". */
export function skeleton(text: string): string {
  let out = "";
  let latin = "";
  const flushLatin = () => {
    let t = latin.toLowerCase();
    for (const [re, to] of LATIN) t = t.replace(re, to);
    out += t.replace(/[^a-z0-9]/g, "").replace(/[aeiouy]/g, "");
    latin = "";
  };
  for (const ch of text.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x0900 && cp <= 0x0d7f) {
      flushLatin();
      const off = cp & 0x7f;
      if (off >= 0x15 && off <= 0x39) out += CONSONANTS[off - 0x15];
      else if (off >= 0x66 && off <= 0x6f)
        out += String(off - 0x66); // Indic digits
      else if (off === 0x58 || off === 0x5b) out += off === 0x58 ? "k" : "j"; // क़ ज़ precomposed
    } else latin += ch;
  }
  flushLatin();
  // y as a consonant was dropped with the vowels; doubled letters (रवि→rv, Ravi→rv) collapse.
  return out.replace(/(.)\1+/g, "$1");
}

/** True when `value` (≥ 2 consonants or digits) appears, in any script, in what the user said. */
export function saidBy(userTexts: string[], value: string): boolean {
  const v = skeleton(value);
  if (v.length < 2) return value.trim().length > 0 && userTexts.some((t) => t.toLowerCase().includes(value.trim().toLowerCase()));
  return userTexts.some((t) => skeleton(t).includes(v));
}
