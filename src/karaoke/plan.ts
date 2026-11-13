/**
 * A part's notes → phrases the voice sings: lyric fragments become sung syllables (through the
 * pronouncing dictionary), each phrase is planned whole with planSong, and the player sends each
 * phrase's gestures to its voice shortly before it starts.
 */
import { lyricsToSyllables, planSong, type Syllable, type SungNote, type Gesture } from "../wasm/engine.ts";
import type { BodyMix } from "../wasm/types.ts";
import type { VNote } from "./song.ts";
import { japaneseText } from "./japanese.ts";

/** the planned gestures start this long before the phrase's first note (consonants come first) */
export const PRE = 0.4;

export interface Phrase {
  /** song time of the first note (s) */
  start: number;
  end: number;
  /** gestures on the phrase's own clock: its first note at PRE */
  gestures: Gesture[];
  /** what each note sings, for the mouth: [song time, lyric fragment] ("": a held vowel) */
  sung: [number, string][];
}

/** a new phrase after a lyric line ends, or after a silence this long (s) */
const BREATH_GAP = 0.45;

const AH: Syllable = { text: "ah", onset: [], nucleus: { ipa: "ɑ", stress: 1 }, coda: [], wordEnd: true, phraseEnd: false };

function clean(text: string): string {
  return text
    .replace(/[’‘`´]/g, "'")
    .replace(/[-–—_]/g, "")
    .replace(/[.,!?;:"“”()[\]{}…¿¡*]/g, "")
    .trim();
}

function syllables(text: string, lang: "en" | "ja" = "en", notes?: number): Syllable[] {
  const t = clean(text);
  if (!t || !/[\p{L}\p{N}]/u.test(t)) return [];
  if (lang === "ja") {
    const j = japaneseText(t, notes);
    if (j) return j.filter((s) => !s.melisma || notes !== undefined);
  }
  try {
    return lyricsToSyllables(t).filter((s) => !s.melisma);
  } catch {
    return [];
  }
}

const melismaOf = (s: Syllable): Syllable => ({ text: "~", onset: [], nucleus: s.nucleus, coda: [], melisma: true, wordEnd: s.wordEnd, phraseEnd: false });

/** Split notes into phrases: at each lyric line and at each breath-length silence between words. */
function phrasesOf(notes: VNote[]): VNote[][] {
  const out: VNote[][] = [];
  let cur: VNote[] = [];
  for (const n of notes) {
    const prev = cur[cur.length - 1];
    const brk = prev && (n.lineStart || (n.wordStart && n.t0 - prev.t1 > BREATH_GAP) || n.t0 - prev.t1 > 1.5);
    if (brk) {
      out.push(cur);
      cur = [];
    }
    cur.push(n);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** a phrase's notes → sung notes, one syllable each (a note split where a group has more syllables) */
function sungNotes(phrase: VNote[], shift: number, lang: "en" | "ja"): { midi: number; t0: number; t1: number; syl: Syllable }[] {
  // words, each of groups: a fragment and the continuations after it
  const words: VNote[][][] = [];
  for (const n of phrase) {
    if (!words.length || (n.wordStart && !n.cont)) words.push([]);
    const w = words[words.length - 1];
    if (!w.length || !n.cont) w.push([]);
    w[w.length - 1].push(n);
  }
  const out: { midi: number; t0: number; t1: number; syl: Syllable }[] = [];
  let last: Syllable | null = null;
  for (const groups of words) {
    const texts = groups.map((g) => g.map((n) => n.text).join(""));
    // the whole word through the dictionary first; where its syllables don't fall one to a group,
    // each group alone
    // Japanese: each mora is a note, and ん or ー a held vowel, so the whole word fits its notes
    const whole = groups.length > 1 ? syllables(texts.join(""), lang, lang === "ja" ? groups.length : undefined) : [];
    const per = whole.length === groups.length ? whole.map((s) => [s]) : texts.map((x, gi) => syllables(x, lang, lang === "ja" ? groups[gi].length : undefined));
    const wordOut: { midi: number; t0: number; t1: number; syl: Syllable }[] = [];
    groups.forEach((g, gi) => {
      const syls = per[gi];
      if (!syls.length) {
        // nothing to say (a bare "~" or punctuation): hold the last vowel
        const base = last ?? AH;
        for (const n of g) wordOut.push({ midi: n.midi + shift, t0: n.t0, t1: n.t1, syl: last ? melismaOf(base) : { ...AH } });
        if (!last) last = AH;
        return;
      }
      if (syls.length <= g.length) {
        g.forEach((n, k) => {
          const s = k < syls.length ? syls[k] : melismaOf(syls[syls.length - 1]);
          wordOut.push({ midi: n.midi + shift, t0: n.t0, t1: n.t1, syl: s });
        });
      } else {
        // more syllables than notes: the group's last note shares its time among the rest
        g.slice(0, -1).forEach((n, k) => wordOut.push({ midi: n.midi + shift, t0: n.t0, t1: n.t1, syl: syls[k] }));
        const n = g[g.length - 1];
        const rest = syls.slice(g.length - 1);
        const span = (n.t1 - n.t0) / rest.length;
        rest.forEach((s, k) => wordOut.push({ midi: n.midi + shift, t0: n.t0 + k * span, t1: n.t0 + (k + 1) * span, syl: s }));
      }
      last = syls[syls.length - 1];
    });
    // the word's last syllable (and the held vowels after it) end the word
    for (let k = 0; k < wordOut.length; k++) wordOut[k].syl = { ...wordOut[k].syl, wordEnd: k === wordOut.length - 1, phraseEnd: false };
    const lastBase = [...wordOut].reverse().find((x) => !x.syl.melisma);
    if (lastBase) lastBase.syl.wordEnd = true;
    out.push(...wordOut);
  }
  if (out.length) out[out.length - 1].syl.phraseEnd = true;
  return out;
}

export interface PlanOptions {
  body: BodyMix;
  /** octaves to move the part by */
  octave: number;
  /** vibrato on held vowels (cents) */
  vibrato: number;
  /** semitones on top of the octave */
  transpose?: number;
  lang?: "en" | "ja";
}

export function planPart(notes: VNote[], o: PlanOptions): Phrase[] {
  const shift = 12 * o.octave + (o.transpose ?? 0);
  const phrases: Phrase[] = [];
  for (const p of phrasesOf(notes)) {
    const sung = sungNotes(p, shift, o.lang ?? "en");
    if (!sung.length) continue;
    const start = sung[0].t0;
    // planSong's notes are back to back: each lasts until the next starts (short gaps inside a
    // phrase are bridged), the last for its own length
    const sn: SungNote[] = sung.map((n, k) => ({
      midi: Math.max(24, Math.min(100, n.midi)),
      beats: Math.max(0.06, k < sung.length - 1 ? sung[k + 1].t0 - n.t0 : n.t1 - n.t0),
      syl: n.syl,
    }));
    let plan;
    try {
      plan = planSong(sn, { body: o.body, bpm: 60, t0: PRE, vibrato: o.vibrato });
    } catch (e) {
      console.warn("karaoke: a phrase could not be planned:", e, sung.map((s) => s.syl.text).join(" "));
      continue;
    }
    const end = start + sn.reduce((a, n) => a + n.beats, 0);
    phrases.push({ start, end, gestures: plan.gestures, sung: p.map((n): [number, string] => [n.t0, n.cont ? "" : clean(n.text)]) });
  }
  return phrases;
}
