/**
 * Visuals for a piece: a module the visual pane runs, given a 2D canvas and the performance as
 * it plays. A visual is built into the page (src/karaoke/visuals/), or a module of its own, an
 * ES module whose default export is a `Visual`, loaded from a URL (songs.json's "visual" for a
 * song, under shows/karaoke/) or picked as a file on the page. It draws each frame from what
 * the host tells it: the time, the voices, the words being sung, the mix's level and spectrum,
 * and the backing's notes as they start.
 */
import type { MidiFile, MidiNote } from "../midifile.ts";
import type { Song } from "../song.ts";

export interface VoiceNow {
  /** pitch (Hz), how voiced (0..1), and output level */
  f0: number;
  voicing: number;
  rms: number;
}

export interface SungNow {
  part: number;
  /** the syllable sounding now, the word it is in, and its lyric line */
  syllable: string;
  word: string;
  line: string;
  /** changes with each new syllable */
  key: number;
}

export interface VisualHost {
  /** the song time (s) and whether it plays */
  time(): number;
  playing(): boolean;
  duration: number;
  song: Song;
  /** the backing as it plays, on the song's clock, or null */
  backing: MidiFile | null;
  /** the mix's level now (about 0..0.5) and its spectrum, in dB, low to high */
  level(): number;
  spectrum(): Float32Array;
  sampleRate: number;
  /** each voice now */
  voices(): VoiceNow[];
  /** what each part sings now, where it sings */
  sung(): SungNow[];
  /** the backing's notes that started since the last frame (none across a seek) */
  hits(): MidiNote[];
  /** the colour of each part */
  colors: string[];
}

export interface VisualInstance {
  /** draw a frame: `dt` seconds since the last, on a w×h canvas in CSS pixels */
  frame(dt: number, w: number, h: number): void;
  dispose?(): void;
}

export interface Visual {
  id: string;
  name: string;
  /** whether this visual is the one for a song, where the song names none */
  match?: (song: Song) => boolean;
  create(g: CanvasRenderingContext2D, host: VisualHost): VisualInstance;
}
