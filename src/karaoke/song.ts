/**
 * Karaoke songs from the files people have: UltraStar .txt (notes with pitch and lyric
 * fragments, duets as P1/P2), karaoke MIDI (.kar: a melody track and lyric events) and plain MIDI
 * (no lyrics: the top line is sung on a scat syllable). Each becomes one Song: the parts to sing,
 * each a list of timed notes with their lyric fragments, and the backing as MIDI where the file
 * has one. Times are seconds from the song's start. Plain data, no DOM.
 */
import { parseMidi, trackLabel, type MidiFile, type MidiNote } from "./midifile.ts";
import { hasKana } from "./japanese.ts";
import { hasHan } from "./hanzi.ts";

export type Lang = "en" | "ja" | "zh";

/**
 * The language of a song's lyrics: Japanese where its language tag says so or any lyric holds
 * kana; else Chinese where at least a third of its lyrics hold Chinese characters (old Chinese
 * .kar files often carry an English tag); else English.
 */
export function lyricsLang(texts: string[], tag = ""): Lang {
  if (/jap|jpn|^ja/i.test(tag) || texts.some(hasKana)) return "ja";
  // by lyric, not by letter: an English credit line is one lyric of many letters
  const words = texts.filter((t) => /\p{L}/u.test(t));
  const han = words.filter(hasHan).length;
  return /chi|chn|zh|中文|國語|国语/i.test(tag) || (words.length && han / words.length >= 1 / 3) ? "zh" : "en";
}

export type BodyName = "male" | "female" | "child";

/** one sung note and the lyric fragment it carries */
export interface VNote {
  t0: number;
  t1: number;
  midi: number;
  /** the fragment as it is shown, without a continuation mark */
  text: string;
  /** the fragment continues the syllable before it (UltraStar "~"): a held vowel on a new pitch */
  cont: boolean;
  /** the first note of a word */
  wordStart: boolean;
  /** the first note of a lyric line */
  lineStart: boolean;
}

export interface Part {
  name: string;
  body: BodyName;
  notes: VNote[];
}

export interface Song {
  id: string;
  title: string;
  artist: string;
  kind: "ultrastar" | "kar" | "midi";
  parts: Part[];
  /** the backing, where the file holds one (MIDI); its sung melody notes are left out */
  backing: MidiFile | null;
  /** the melody notes the voice sings, kept apart so they can be played quietly as a guide */
  guide: MidiNote[];
  /** UltraStar: the audio file the song was timed to (#MP3), which the user may add */
  audioName?: string;
  duration: number;
  /** a karaoke MIDI: the share of its lyrics that a melody note sounds under (0..1); 0 where no
   *  track follows the lyrics */
  melodyHit?: number;
  /** the language the lyrics are sung in: Japanese reads kana and romaji by the mora, Chinese its
   *  characters by their pinyin */
  lang: Lang;
  /** a MIDI without lyrics: the file, and the track the voice sings, so words can be put to it */
  midi?: MidiFile;
  melodyKey?: string;
}

const FEMALE = /\b(adele|gaga|whitney|mariah|celine|beyonc|rihanna|taylor|ariana|madonna|britney|aretha|dolly|shakira|katy|pink|sia|amy|norah|alicia|tina|cher|lorde|billie eilish|dua)\b/i;

function guessBody(name: string): BodyName {
  return FEMALE.test(name) ? "female" : "male";
}

const median = (xs: number[]) => {
  if (!xs.length) return 60;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** the comfortable middle of each body's singing range (MIDI) */
export const RANGE_CENTER: Record<BodyName, number> = { male: 53, female: 65, child: 69 };

/** whole octaves that bring a part's median pitch nearest its body's middle */
export function autoOctave(notes: VNote[], body: BodyName): number {
  return Math.round((RANGE_CENTER[body] - median(notes.map((n) => n.midi))) / 12);
}

// ---------------------------------------------------------------- UltraStar

export function parseUltraStar(text: string, id: string): Song {
  const head: Record<string, string> = {};
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let bpm = 0;
  let gap = 0;
  let relative = false;
  let offset = 0; // relative mode: beats added by line breaks
  const raw: { part: number; start: number; len: number; pitch: number; text: string; kind: string; lineStart: boolean }[] = [];
  let part = 1;
  let lineStart = true;
  for (const line of lines) {
    if (line.startsWith("#")) {
      const i = line.indexOf(":");
      if (i > 0) head[line.slice(1, i).trim().toUpperCase()] = line.slice(i + 1).trim();
      continue;
    }
    const c = line[0];
    if (c === "E") break;
    if (c === "P") {
      const n = parseInt(line.slice(1).trim(), 10);
      if (n) part = n;
      lineStart = true;
      continue;
    }
    if (c === "-") {
      const [a, b] = line.slice(1).trim().split(/\s+/).map(Number);
      if (relative) offset += Number.isFinite(b) ? b : a;
      lineStart = true;
      continue;
    }
    const m = /^([:*FRG])\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s?(.*)$/.exec(line);
    if (!m) continue;
    raw.push({ part, start: Number(m[2]) + (relative ? offset : 0), len: Number(m[3]), pitch: Number(m[4]), text: m[5], kind: m[1], lineStart });
    lineStart = false;
    if (raw.length === 1) {
      bpm = parseFloat((head.BPM ?? "0").replace(",", "."));
      gap = parseFloat((head.GAP ?? "0").replace(",", "."));
      relative = /^yes$/i.test(head.RELATIVE ?? "");
    }
  }
  if (!bpm) throw new Error("UltraStar file without #BPM");
  const beat = 60 / (bpm * 4);
  const sec = (b: number) => gap / 1000 + b * beat;
  // singer names: #P1/#DUETSINGERP1 headers, or the p1=/p2= keys some files put in #VIDEO
  const video = Object.fromEntries((head.VIDEO ?? "").split(",").map((kv) => kv.split("=")).filter((kv) => kv.length === 2)) as Record<string, string>;
  const singer = (n: number) => head[`P${n}`] || head[`DUETSINGERP${n}`] || video[`p${n}`] || "";
  const artist = head.ARTIST ?? "";
  const ids = [...new Set(raw.map((r) => r.part))].sort();
  // P3 in some duet files: both sing it
  const sung = ids.filter((p) => p !== 3);
  const parts: Part[] = (sung.length ? sung : [1]).map((p, k) => {
    const mine = raw.filter((r) => r.part === p || r.part === 3).sort((a, b) => a.start - b.start);
    const name = singer(p) || (ids.length > 1 ? `Singer ${k + 1}` : artist || "Voice");
    const notes: VNote[] = [];
    let wordOpen = false;
    for (const r of mine) {
      const cont = r.text.startsWith("~") || r.text.trimStart().startsWith("~");
      const lead = /^\s/.test(r.text);
      const shown = r.text.replace(/~/g, "").trim();
      const wordStart = !cont && (r.lineStart || lead || !wordOpen);
      notes.push({ t0: sec(r.start), t1: sec(r.start + Math.max(1, r.len)), midi: 60 + r.pitch, text: shown, cont: cont && notes.length > 0 && !r.lineStart, wordStart: wordStart || notes.length === 0, lineStart: r.lineStart });
      // a fragment ending in a space closes its word
      wordOpen = !/\s$/.test(r.text);
    }
    return { name, body: guessBody(name || artist), notes };
  });
  // two singers the names don't tell apart: the lower part is the man
  if (parts.length === 2 && parts[0].body === parts[1].body) {
    const [a, b] = parts.map((p) => median(p.notes.map((n) => n.midi)));
    parts[a <= b ? 0 : 1].body = "male";
    parts[a <= b ? 1 : 0].body = "female";
  }
  const duration = Math.max(0, ...parts.flatMap((p) => p.notes.map((n) => n.t1))) + 2;
  const lang = lyricsLang(parts.flatMap((p) => p.notes.map((n) => n.text)), head.LANGUAGE ?? "");
  return { id, title: head.TITLE ?? id, artist, kind: "ultrastar", parts, backing: null, guide: [], audioName: head.MP3 || head.AUDIO, duration, lang };
}

// ---------------------------------------------------------------- MIDI and .kar

/** Soft Karaoke text: "@" lines are tags, "\" starts a paragraph, "/" a line, a space a word */
interface Lyric {
  t: number;
  text: string;
  wordStart: boolean;
  lineStart: boolean;
}

function karaokeLyrics(m: MidiFile): { lyrics: Lyric[]; title: string; artist: string; langTag: string } {
  let title = "";
  let artist = "";
  // the track with the most lyric (or text) events holds the words
  const counts = new Map<string, number>();
  for (const t of m.texts) if (!t.text.startsWith("@")) counts.set(`${t.track}:${t.kind}`, (counts.get(`${t.track}:${t.kind}`) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  const tags = m.texts.filter((t) => t.text.startsWith("@T"));
  const langTag = m.texts.find((t) => t.text.startsWith("@L"))?.text.slice(2).trim() ?? "";
  if (tags[0]) title = tags[0].text.slice(2).trim();
  if (tags[1]) artist = tags[1].text.slice(2).trim();
  if (!best || best[1] < 8) return { lyrics: [], title, artist, langTag };
  const [track, kind] = best[0].split(":").map(Number);
  const lyrics: Lyric[] = [];
  let pendingLine = true;
  for (const t of m.texts) {
    if (t.track !== track || t.kind !== kind || t.text.startsWith("@")) continue;
    // a carriage return is a line break in some files ("\r" alone, or after the syllable)
    let s = t.text.replace(/\r\n?/g, "/");
    let line: boolean = pendingLine;
    if (/^[\\/\n]/.test(s)) {
      line = true;
      s = s.replace(/^[\\/\n]+/, "");
    }
    // a line break at the end of a lyric (the other common convention) starts the next line
    pendingLine = /[\\/\n]$/.test(s);
    s = s.replace(/[\\/\n]+$/, "");
    const word = line || /^\s/.test(s) || lyrics.length === 0 || /\s$/.test(lyrics[lyrics.length - 1].text);
    const text = s.trim();
    if (!text) {
      pendingLine = pendingLine || line;
      continue;
    }
    lyrics.push({ t: t.t, text, wordStart: word, lineStart: line });
  }
  return { lyrics, title, artist, langTag };
}

/** the track and channel whose note starts best match the lyrics' times */
function melodyOf(m: MidiFile, lyrics: Lyric[]): { track: number; ch: number; offset: number } | null {
  const keys = new Map<string, number[]>();
  for (const n of m.notes) if (n.ch !== 9) (keys.get(`${n.track}:${n.ch}`) ?? keys.set(`${n.track}:${n.ch}`, []).get(`${n.track}:${n.ch}`)!).push(n.t0);
  let best: { track: number; ch: number; offset: number } | null = null;
  let bestScore = 0;
  for (const [k, raw] of keys) {
    const starts = [...raw].sort((a, b) => a - b);
    // a karaoke file often shows each word a little before its note: the track's own lead, the
    // median gap from each lyric to the nearest note start after it within 0.3 s
    const gaps: number[] = [];
    let j = 0;
    for (const l of lyrics) {
      while (j < starts.length && starts[j] < l.t - 0.06) j++;
      if (j < starts.length && starts[j] - l.t <= 0.3) gaps.push(starts[j] - l.t);
    }
    gaps.sort((a, b) => a - b);
    const offset = gaps.length > lyrics.length * 0.3 ? Math.max(0, gaps[gaps.length >> 1]) : 0;
    let hit = 0;
    j = 0;
    for (const l of lyrics) {
      const t = l.t + offset;
      while (j < starts.length && starts[j] < t - 0.06) j++;
      if (j < starts.length && Math.abs(starts[j] - t) <= 0.06) hit++;
    }
    const named = /melody|vocal|voice|lead vox|sing/i.test(m.trackNames[Number(k.split(":")[0])] ?? "") ? 1.15 : 1;
    // an accompaniment that plays on every beat hits the lyrics too: a melody has about one
    // note per syllable, so a much busier track counts for less
    const busy = Math.min(1, (2 * lyrics.length) / starts.length);
    const score = (hit / lyrics.length) * named * busy;
    if (score > bestScore) {
      bestScore = score;
      const [track, ch] = k.split(":").map(Number);
      best = { track, ch, offset };
    }
  }
  return bestScore > 0.3 ? best : null;
}

/** one line through a polyphonic track: at each moment, the highest note sounding */
function skyline(notes: MidiNote[]): MidiNote[] {
  const sorted = [...notes].sort((a, b) => a.t0 - b.t0 || b.midi - a.midi);
  const out: MidiNote[] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(n.t0 - last.t0) < 0.03) continue; // a chord: its top note came first
    if (last && n.t0 < last.t1) {
      if (n.midi < last.midi - 2) continue; // a lower inner voice under a held melody note
      last.t1 = n.t0;
    }
    out.push({ ...n });
  }
  return out.filter((n) => n.t1 - n.t0 > 0.04);
}

/** a monophonic line: a note cut where the next one starts */
function monophonic(notes: MidiNote[]): MidiNote[] {
  const s = [...notes].sort((a, b) => a.t0 - b.t0 || b.midi - a.midi);
  const out: MidiNote[] = [];
  for (const n of s) {
    const last = out[out.length - 1];
    if (last && Math.abs(n.t0 - last.t0) < 0.02) continue;
    if (last && last.t1 > n.t0) last.t1 = n.t0;
    out.push({ ...n });
  }
  return out;
}

export function parseMidiSong(bytes: ArrayBuffer | Uint8Array, id: string, fileTitle: string, scat = "doo"): Song {
  const m = parseMidi(bytes);
  const { lyrics, title, artist, langTag } = karaokeLyrics(m);
  const [fArtist, fTitle] = fileTitle.includes(" - ") ? fileTitle.split(" - ", 2) : ["", fileTitle];
  const name = artist || fArtist || "Voice";
  const notes: VNote[] = [];
  const guide: MidiNote[] = [];
  const sungKeys = new Set<MidiNote>();
  const mel = lyrics.length ? melodyOf(m, lyrics) : null;
  let missed = 0;
  if (mel && mel.offset) for (const l of lyrics) l.t += mel.offset;
  if (mel) {
    const line = monophonic(m.notes.filter((n) => n.track === mel.track && n.ch === mel.ch));
    const orig = m.notes.filter((n) => n.track === mel.track && n.ch === mel.ch);
    // each lyric takes the note starting at it and the notes after it, up to the next lyric
    let j = 0;
    for (let i = 0; i < lyrics.length; i++) {
      const l = lyrics[i];
      const next = lyrics[i + 1]?.t ?? Infinity;
      while (j < line.length && line[j].t0 < l.t - 0.08) j++;
      let first = true;
      while (j < line.length && line[j].t0 < next - 0.08) {
        const n = line[j];
        // a long instrumental run after the word (a fill on the melody track) isn't sung
        if (!first && n.t0 - notes[notes.length - 1].t1 > 0.25) break;
        notes.push({ t0: first ? Math.min(n.t0, l.t) : n.t0, t1: n.t1, midi: n.midi, text: first ? l.text : "", cont: !first, wordStart: first && l.wordStart, lineStart: first && l.lineStart });
        const o = orig.find((x) => x.t0 === n.t0 && x.midi === n.midi);
        if (o) sungKeys.add(o);
        first = false;
        j++;
      }
      if (first) {
        missed++;
        // no melody note under this lyric: sing it at the pitch around it, for its time
        const prev = notes[notes.length - 1];
        const t1 = Math.min(next, l.t + 0.5);
        notes.push({ t0: l.t, t1, midi: prev?.midi ?? 60, text: l.text, cont: false, wordStart: l.wordStart, lineStart: l.lineStart });
      }
    }
    for (const n of orig) if (sungKeys.has(n)) guide.push(n);
  }
  const body = guessBody(name);
  const songTitle = title ? title.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()) : fTitle;
  if (!mel && lyrics.length) {
    // lyrics, but no track starts its notes with them: each word sung for its time at the pitch
    // the most melodic track sounds then
    const key = melodyTracks(m)[0]?.key;
    const tune = key ? tuneOf(m, key).line : [];
    const lyricNotes: VNote[] = [];
    let k = 0;
    lyrics.forEach((l, i) => {
      const next = lyrics[i + 1]?.t ?? l.t + 1;
      while (k + 1 < tune.length && tune[k + 1].t0 <= l.t + 0.05) k++;
      const prev = lyricNotes[lyricNotes.length - 1];
      lyricNotes.push({ t0: l.t, t1: Math.min(next, l.t + 1.2), midi: tune[k]?.midi ?? prev?.midi ?? 64, text: l.text, cont: false, wordStart: l.wordStart, lineStart: l.lineStart });
    });
    return {
      id,
      title: songTitle,
      artist: artist || fArtist,
      kind: "kar",
      melodyHit: 0,
      lang: lyricsLang(lyrics.map((l) => l.text), langTag),
      parts: [{ name, body, notes: lyricNotes }],
      backing: m,
      guide: [],
      duration: m.duration + 1,
    };
  }
  if (!mel) {
    // no lyrics: the most melodic track, on a scat syllable, until words are put to it
    const key = melodyTracks(m)[0]?.key ?? null;
    const sung = key ? singLine(m, key, scat) : { notes: [], used: [] };
    const used = new Set(sung.used);
    return {
      id,
      title: songTitle,
      artist: artist || fArtist,
      kind: "midi",
      parts: [{ name: `${name} (scat)`, body, notes: sung.notes }],
      backing: { ...m, notes: m.notes.filter((n) => !used.has(n)) },
      guide: sung.used,
      duration: m.duration + 1,
      lang: "en",
      midi: m,
      melodyKey: key ?? undefined,
    };
  }
  const backing: MidiFile = { ...m, notes: m.notes.filter((n) => !sungKeys.has(n)) };
  return {
    id,
    title: songTitle,
    artist: artist || fArtist,
    kind: "kar",
    melodyHit: 1 - missed / lyrics.length,
    lang: lyricsLang(lyrics.map((l) => l.text), langTag),
    parts: [{ name, body, notes }],
    backing,
    guide,
    duration: m.duration + 1,
  };
}

/** Read a song from a file's name and bytes. */
export function parseSong(name: string, bytes: Uint8Array): Song {
  const base = name.replace(/\.[^.]+$/, "");
  if (/\.txt$/i.test(name)) return parseUltraStar(new TextDecoder().decode(bytes), base);
  if (/\.(mid|midi|kar|rmi)$/i.test(name)) return parseMidiSong(bytes, base, base);
  throw new Error(`${name}: not an UltraStar .txt, .kar or .mid file`);
}

/** a pitched track a voice could sing, with how much it reads as a melody */
export interface MelodyTrack {
  key: string;
  name: string;
  notes: number;
  score: number;
}

/**
 * The tracks of a MIDI without lyrics that could carry its tune, best first: a single line (few
 * chords), in a voice's register, named like a melody, busy enough to be the tune.
 */
export function melodyTracks(m: MidiFile): MelodyTrack[] {
  const by = new Map<string, MidiNote[]>();
  for (const n of m.notes) {
    if (n.ch === 9) continue;
    const k = `${n.track}:${n.ch}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(n);
  }
  const out: MelodyTrack[] = [];
  for (const [key, ns] of by) {
    if (ns.length < 12) continue;
    const sorted = [...ns].sort((a, b) => a.t0 - b.t0);
    let chords = 0;
    for (let i = 1; i < sorted.length; i++) if (sorted[i].t0 - sorted[i - 1].t0 < 0.03) chords++;
    const single = 1 - chords / ns.length;
    const mid = median(ns.map((n) => n.midi));
    const register = mid >= 58 && mid <= 82 ? 1 : mid >= 52 && mid <= 88 ? 0.5 : 0.1;
    const tn = m.trackNames[Number(key.split(":")[0])] ?? "";
    const named = /melod|vocal|voice|vox|lead|sing|melody/i.test(tn) ? 3 : 1;
    // a piano-only file carries its tune on top of its chords: a single line of it still counts
    const score = Math.min(ns.length, 900) * single * single * register * named;
    out.push({ key, name: tn, notes: ns.length, score });
  }
  out.sort((a, b) => b.score - a.score);
  const keys = out.map((t) => t.key);
  for (const t of out) t.name = trackLabel(m, t.key, keys);
  for (const t of out) if (out.filter((x) => x.name === t.name).length > 1) t.name = `${t.name} · ch ${Number(t.key.split(":")[1]) + 1}`;
  return out;
}

/** a track's tune as one line, in a voice's register: the top note of each chord */
function tuneOf(m: MidiFile, key: string): { line: MidiNote[]; used: MidiNote[] } {
  const ns = m.notes.filter((n) => `${n.track}:${n.ch}` === key);
  const line = skyline(ns.filter((n) => n.midi >= 50));
  // a piano's runs go far beyond a voice: fold the outliers back toward the middle of the line
  const mid = median(line.map((n) => n.midi));
  for (const n of line) {
    while (n.midi > mid + 9) n.midi -= 12;
    while (n.midi < mid - 9) n.midi += 12;
  }
  return { line, used: ns };
}

/** a track's tune on a scat syllable, a line at each breath */
export function singLine(m: MidiFile, key: string, scat = "doo"): { notes: VNote[]; used: MidiNote[] } {
  const { line, used } = tuneOf(m, key);
  const notes: VNote[] = [];
  let prevEnd = -1;
  for (const n of line) {
    notes.push({ t0: n.t0, t1: n.t1, midi: n.midi, text: scat, cont: false, wordStart: true, lineStart: n.t0 - prevEnd > 1.2 || notes.length === 0 });
    prevEnd = n.t1;
  }
  return { notes, used };
}

/** where a track's tune starts (s) */
export function tuneStart(m: MidiFile, key: string): number {
  return tuneOf(m, key).line[0]?.t0 ?? 0;
}

/**
 * Words put to a track's tune, one unit a note in order from `from` s: `units` are the lyric's
 * lines, each of words, each of the pieces sung one to a note (syllables, or morae), "-" or "~"
 * holding the vowel onto the next note and "_" leaving a note to the instrument. A line starts
 * on the next note after the last line's, or after a rest where one comes within its first
 * two notes. Notes after the last word aren't sung.
 */
export function wordsToTune(m: MidiFile, key: string, units: string[][][], from: number): { notes: VNote[]; used: MidiNote[]; left: number } {
  const { line, used } = tuneOf(m, key);
  let j = line.findIndex((n) => n.t0 >= from - 0.05);
  if (j < 0) j = line.length;
  const notes: VNote[] = [];
  const sungAt = new Set<number>();
  let left = 0;
  for (const l of units) {
    let lineStart = true;
    for (const w of l) {
      let wordStart = true;
      for (const u of w) {
        if (j >= line.length) {
          left++;
          continue;
        }
        const n = line[j++];
        if (u === "_") continue;
        const hold = u === "-" || u === "~";
        notes.push({ t0: n.t0, t1: n.t1, midi: n.midi, text: hold ? "" : u, cont: hold && notes.length > 0, wordStart: !hold && wordStart, lineStart: lineStart && !hold });
        sungAt.add(j - 1);
        if (!hold) {
          wordStart = false;
          lineStart = false;
        }
      }
    }
  }
  // the instrument plays the notes the voice doesn't sing
  const sungTimes = new Set([...sungAt].map((k) => Math.round(line[k].t0 * 1000)));
  return { notes, used: used.filter((n) => sungTimes.has(Math.round(n.t0 * 1000))), left };
}
