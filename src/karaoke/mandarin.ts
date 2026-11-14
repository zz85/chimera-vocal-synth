/**
 * Mandarin lyrics for the karaoke page: toneless pinyin syllables → sung syllables, one per note.
 * Ported from tools/performance/mandarin.mjs (the performance renderer's), for the Rust engine,
 * whose inventory has no alveolo-palatals, no tʂ, no ɥ, and no unaspirated voiceless stops (its
 * planner aspirates every voiceless stop before a vowel). So Mandarin's aspiration contrast is
 * sung as English voicing, as an English voice would: b d g z zh j as b d g dz dʒ dʒ, p t k c
 * ch q as aspirated p t k ts tʃ tʃ; x is ʃ, sh is the retroflex ʂ and r ɻ, and ɥ is j. Tones are
 * dropped: in singing the melody sets the pitch.
 */
import type { Syllable, Segment } from "../wasm/types.ts";

// initial → IPA
const INITIALS: Record<string, string> = {
  b: "b", p: "p", m: "m", f: "f",
  d: "d", t: "t", n: "n", l: "l",
  g: "g", k: "k", h: "x",
  j: "dʒ", q: "tʃ", x: "ʃ",
  zh: "dʒ", ch: "tʃ", sh: "ʂ", r: "ɻ",
  z: "dz", c: "ts", s: "s",
};
// final → [glide, nucleus, coda]; a diphthong is one nucleus, which the engine glides
const FINALS: Record<string, [string, string, string?]> = {
  a: ["", "a"], o: ["", "o"], e: ["", "ɤ"], er: ["", "ɚ"],
  ai: ["", "aɪ"], ei: ["", "eɪ"], ao: ["", "aʊ"], ou: ["", "oʊ"],
  an: ["", "a", "n"], en: ["", "ə", "n"], ang: ["", "ɑ", "ŋ"], eng: ["", "ə", "ŋ"], ong: ["", "ʊ", "ŋ"],
  i: ["", "i"], ia: ["j", "a"], ie: ["j", "e"], iao: ["j", "aʊ"], iou: ["j", "oʊ"],
  ian: ["j", "ɛ", "n"], in: ["", "i", "n"], iang: ["j", "ɑ", "ŋ"], ing: ["", "i", "ŋ"], iong: ["j", "ʊ", "ŋ"],
  u: ["", "u"], ua: ["w", "a"], uo: ["w", "o"], uai: ["w", "aɪ"], uei: ["w", "eɪ"],
  uan: ["w", "a", "n"], uen: ["w", "ə", "n"], uang: ["w", "ɑ", "ŋ"], ueng: ["w", "ə", "ŋ"],
  v: ["", "y"], ve: ["j", "e"], van: ["j", "ɛ", "n"], vn: ["", "y", "n"],
};
// y- and w- spellings of finals with no initial
const ZERO: Record<string, string> = {
  yi: "i", ya: "ia", ye: "ie", yao: "iao", you: "iou", yan: "ian", yin: "in", yang: "iang", ying: "ing", yong: "iong",
  yu: "v", yue: "ve", yuan: "van", yun: "vn",
  wu: "u", wa: "ua", wo: "uo", wai: "uai", wei: "uei", wan: "uan", wen: "uen", wang: "uang", weng: "ueng",
};
// spellings that shorten a final after an initial
const SHORT: Record<string, string> = { iu: "iou", ui: "uei", un: "uen" };
// interjections CEDICT spells outside the tables
const OTHER: Record<string, string> = { m: "m", n: "n", ng: "ŋ", hm: "m", hng: "ŋ", r: "ɚ" };
const TONE_MARKS: Record<string, string> = { ā: "a", á: "a", ǎ: "a", à: "a", ē: "e", é: "e", ě: "e", è: "e", ī: "i", í: "i", ǐ: "i", ì: "i", ō: "o", ó: "o", ǒ: "o", ò: "o", ū: "u", ú: "u", ǔ: "u", ù: "u", ǖ: "v", ǘ: "v", ǚ: "v", ǜ: "v", ü: "v" };

/** one pinyin syllable (tone marks, tone numbers or neither) → its initial and final, or null where it isn't pinyin */
export function parsePinyin(syllable: string): { initial: string; final: string } | null {
  let s = syllable.normalize("NFC").toLowerCase().replace(/u:/g, "v");
  s = [...s].map((c) => TONE_MARKS[c] ?? c).join("").replace(/[1-5]$/, "");
  if (ZERO[s]) return { initial: "", final: ZERO[s] };
  if (FINALS[s] && !["i", "u", "v", "ia", "ie", "iao", "iou", "ian", "in", "iang", "ing", "iong", "ua", "uo", "uai", "uei", "uan", "uen", "uang", "ueng", "ve", "van", "vn"].includes(s)) return { initial: "", final: s };
  const initial = ["zh", "ch", "sh"].find((i) => s.startsWith(i)) ?? (INITIALS[s[0]] ? s[0] : "");
  if (!initial) return null;
  let final = s.slice(initial.length);
  if (SHORT[final]) final = SHORT[final];
  // after j q x the written u is ü
  if ("jqx".includes(initial) && final.startsWith("u")) final = "v" + final.slice(1);
  return FINALS[final] ? { initial, final } : null;
}

const seg = (ipa: string): Segment => ({ ipa });

/** One toneless pinyin syllable → a sung syllable, shown as `text`; null where it isn't pinyin. */
export function mandarinSyllable(pinyin: string, text = pinyin): Syllable | null {
  const other = OTHER[pinyin.toLowerCase().replace(/[1-5]$/, "")];
  if (other) {
    // a syllabic nasal (嗯 ng, 呣 m) or r: hum it on a schwa that closes on the nasal
    const nasal = other !== "ɚ";
    return { text, onset: [], nucleus: { ipa: nasal ? "ə" : "ɚ", stress: 1 }, coda: nasal ? [seg(other)] : [], wordEnd: false, phraseEnd: false };
  }
  const p = parsePinyin(pinyin);
  if (!p) return null;
  const { initial, final } = p;
  let [glide, nucleus, coda] = FINALS[final];
  // the apical vowel of zi ci si and zhi chi shi ri: a close central vowel
  if (final === "i" && ["z", "c", "s", "zh", "ch", "sh", "r"].includes(initial)) nucleus = "ɨ";
  // bo po mo fo are buo puo muo fuo
  if (final === "o" && "bpmf".includes(initial) && initial) glide = "w";
  const onset: Segment[] = [];
  if (initial) onset.push(seg(INITIALS[initial]));
  if (glide) onset.push(seg(glide));
  return { text, onset, nucleus: { ipa: nucleus, stress: 1 }, coda: coda ? [seg(coda)] : [], wordEnd: false, phraseEnd: false };
}

/** pinyin text (syllables split by spaces or apostrophes) → sung syllables; null where a syllable isn't pinyin */
export function mandarinText(text: string): Syllable[] | null {
  const out: Syllable[] = [];
  for (const tok of text.trim().split(/[\s']+/).filter(Boolean)) {
    const s = mandarinSyllable(tok);
    if (!s) return null;
    out.push(s);
  }
  if (out.length) out[out.length - 1].wordEnd = true;
  return out.length ? out : null;
}
