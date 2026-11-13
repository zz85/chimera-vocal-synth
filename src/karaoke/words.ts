/**
 * Words for a MIDI without lyrics: lyrics typed or pasted on the page are put to a track's tune,
 * one syllable (English, through the pronouncing dictionary) or one mora (Japanese, kana or
 * romaji) to a note. The words, the track, where they start and their language are kept per
 * song in the browser.
 */
import { lyricsToSyllables } from "../wasm/engine.ts";
import { moraeOf } from "./japanese.ts";
import { wordsToTune, type Song } from "./song.ts";

export interface Words {
  text: string;
  lang: "en" | "ja";
  /** the track the tune is on, "track:ch" */
  key: string;
  /** where the first word is sung (s) */
  from: number;
}

const key = (song: Song) => `chimera-karaoke:words:${song.id}`;

export function loadWords(song: Song): Words | null {
  try {
    return JSON.parse(localStorage.getItem(key(song)) ?? "null");
  } catch {
    return null;
  }
}

export function saveWords(song: Song, w: Words | null): void {
  if (w) localStorage.setItem(key(song), JSON.stringify(w));
  else localStorage.removeItem(key(song));
}

/** one word → the pieces sung one to a note, as they are written */
function pieces(word: string, lang: "en" | "ja"): string[] {
  // marks typed on their own: a held note, a note left to the instrument
  if (/^[-~_]+$/.test(word)) return [...word];
  // "ti-ger": the writer's own split
  if (word.includes("-") && lang === "en") return word.split("-").filter(Boolean);
  if (lang === "ja") return moraeOf(word.replace(/[-.,!?;:"“”()「」、。]/g, ""));
  const clean = word.replace(/[^\p{L}\p{N}'’]/gu, "");
  if (!clean) return [];
  try {
    const syl = lyricsToSyllables(clean).filter((s) => !s.melisma);
    if (syl.length <= 1) return [word];
    // the dictionary's split, as it spells each syllable (the word itself where it doesn't)
    const parts = syl.map((s) => s.text.replace(/~/g, ""));
    if (parts.join("").toLowerCase() === clean.toLowerCase().replace(/’/g, "'")) return parts;
    // otherwise the word on its first note, held over the rest (the planner splits it the same way)
    return [clean, ...Array<string>(syl.length - 1).fill("~")];
  } catch {
    return [word];
  }
}

/** lyrics → lines of words of pieces */
export function unitsOf(text: string, lang: "en" | "ja"): string[][][] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/).map((w) => pieces(w, lang)).filter((p) => p.length));
}

/** The song with its words put to the tune (a MIDI without lyrics), and how many pieces were left over. */
export function withWords(song: Song, w: Words): { song: Song; pieces: number; left: number } {
  if (!song.midi) return { song, pieces: 0, left: 0 };
  const units = unitsOf(w.text, w.lang);
  const { notes, used, left } = wordsToTune(song.midi, w.key, units, w.from);
  const usedSet = new Set(used);
  const total = units.flat(2).filter((u) => u !== "_").length;
  return {
    song: {
      ...song,
      kind: "midi",
      lang: w.lang,
      melodyKey: w.key,
      parts: [{ ...song.parts[0], name: song.parts[0].name.replace(/ \(scat\)$/, ""), notes }],
      backing: { ...song.midi, notes: song.midi.notes.filter((n) => !usedSet.has(n)) },
      guide: used,
    },
    pieces: total,
    left,
  };
}
