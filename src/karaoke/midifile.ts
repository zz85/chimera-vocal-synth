/**
 * A Standard MIDI File reader (formats 0 and 1, and .kar karaoke files, which are format 1 with
 * lyrics as text or lyric meta events). Every event comes out on one clock in seconds, through
 * the file's tempo map. Plain data, no DOM: it also runs under Bun.
 */

export interface MidiNote {
  t0: number;
  t1: number;
  track: number;
  ch: number;
  midi: number;
  vel: number;
}

/** a lyric or text event (karaoke text lives in either) */
export interface MidiText {
  t: number;
  track: number;
  /** 0x01 text, 0x05 lyric */
  kind: number;
  text: string;
}

/** a channel message other than a note, as raw bytes (program, controller, pitch bend, pressure) */
export interface MidiControl {
  t: number;
  track: number;
  bytes: number[];
}

export interface MidiFile {
  notes: MidiNote[];
  texts: MidiText[];
  controls: MidiControl[];
  /** each track's name, where it has one */
  trackNames: string[];
  /** the program each channel starts with (its first program change), -1: none */
  programs: number[];
  duration: number;
  /** the encoding its text events were read in (textEncoding) */
  encoding: string;
}

interface RawEvent {
  tick: number;
  track: number;
  order: number;
  status: number;
  data: number[];
  meta?: number;
  metaData?: Uint8Array;
}

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

/** a decoder for the encoding, or null where the runtime lacks it */
function decoder(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

/** how many characters the encoding can't read in the texts (U+FFFD), or Infinity without it */
const unread = (label: string, all: Uint8Array[]) => {
  const dec = decoder(label);
  if (!dec) return Infinity;
  let n = 0;
  for (const b of all) for (const c of dec.decode(b)) if (c === "\ufffd") n++;
  return n;
};

/**
 * The encoding of a file's text events, chosen once for the whole file, so a character split
 * across two events still reads: UTF-8 where every event reads as UTF-8; else, where its high
 * bytes pair up as double-byte characters, Shift_JIS (Japanese), Big5 (traditional Chinese) or
 * GBK (simplified Chinese); else Windows-1252, the Latin-1 most old .kar files are in.
 *  - Shift_JIS puts its kana, punctuation, full-width letters and most used kanji on first bytes
 *    0x81-0x9F, where Big5 and GB2312 have no characters. Windows-1252 has its curly quotes and
 *    dashes there, but between the letters and words of a phrase ("don\x92t").
 *  - Accented letters are high bytes inside words ("Tr\xe4ume", "cora\xe7\xe3o"), with a letter
 *    before them, and a handful of them make few pairs on few first bytes; CJK lyrics make tens
 *    of pairs on many first bytes, after spaces, punctuation or each other.
 *  - Big5 and GBK read many of the same bytes. Big5 puts about two of every five common
 *    characters' second byte in 0x40-0x7E, which GB2312's common characters never use, so a
 *    file whose pairs often do is Big5.
 */
export function textEncoding(all: Uint8Array[]): string {
  if (unread("utf-8", all) === 0) return "utf-8";
  const letter = (c: number | undefined) => c !== undefined && ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a));
  let pairs = 0, low = 0, high = 0, sjisLead = 0, accents = 0, quotes = 0;
  const leads = new Set<number>();
  let trail = -1;
  // the events run on into each other here: a .kar file splits words into syllables ("can",
  // "\x92t"), so a byte's neighbours are often in the next or the last event
  const b = new Uint8Array(all.reduce((n, e) => n + e.length, 0));
  all.reduce((at, e) => (b.set(e, at), at + e.length), 0);
  for (let i = 0; i < b.length; i++) {
    if (b[i] < 0x81 || b[i] > 0xfe || i + 1 >= b.length) continue;
    pairs++;
    leads.add(b[i]);
    // a letter of a word before it, but not a .kar tag's ("@T")
    if (b[i] >= 0xc0 && letter(b[i - 1]) && b[i - 2] !== 0x40) accents++;
    if (b[i + 1] >= 0x40 && b[i + 1] <= 0x7e) low++;
    if (b[i + 1] >= 0x80) high++;
    if (b[i] <= 0x9f) sjisLead++;
    // Windows-1252's apostrophe and dashes inside a phrase ("don\x92t", "word\x97 word"),
    // after a letter that isn't the second byte of a character before (full-width "\x82\x73")
    if (b[i] <= 0x9f && letter(b[i - 1]) && trail !== i - 1 && (letter(b[i + 1]) || b[i + 1] === 0x20)) quotes++;
    trail = ++i;
  }
  // an encoding reads the file where it reads all but a few of its characters; Shift_JIS files
  // also use vendor characters the standard table lacks (box drawing in row 0x86)
  const reads = (label: string, share = 0.03) => unread(label, all) <= Math.max(2, share * pairs);
  // (two in five: Shift_JIS's half-width katakana are single bytes, which shift the pairing)
  if (sjisLead >= 8 && sjisLead / pairs > 0.4 && quotes / sjisLead < 0.3 && reads("shift_jis", 0.35)) return "shift_jis";
  if (pairs < 16 || leads.size < 6 || high / pairs < 0.3 || accents / pairs > 0.2) return "windows-1252";
  if (reads("shift_jis")) {
    const text = all.map((b) => decoder("shift_jis")!.decode(b)).join("");
    const wide = [...text].filter((c) => c.charCodeAt(0) > 0xff).length;
    const kana = [...text].filter((c) => /[\u3040-\u30ff]/.test(c)).length;
    if (wide && kana / wide > 0.2) return "shift_jis";
  }
  const big5 = reads("big5"), gbk = reads("gbk");
  if (big5 && (!gbk || low / pairs > 0.15)) return "big5";
  if (gbk) return "gbk";
  return "windows-1252";
}

function decoderFor(encoding: string): (b: Uint8Array) => string {
  const dec = decoder(encoding);
  if (!dec) return latin1;
  return (b) => dec.decode(b);
}

export function parseMidi(buf: ArrayBuffer | Uint8Array): MidiFile {
  const d = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let p = 0;
  const u32 = () => ((d[p++] << 24) | (d[p++] << 16) | (d[p++] << 8) | d[p++]) >>> 0;
  const u16 = () => (d[p++] << 8) | d[p++];
  const str4 = () => String.fromCharCode(d[p++], d[p++], d[p++], d[p++]);
  // RIFF-wrapped MIDI (.rmi)
  if (str4() === "RIFF") {
    p = 12;
    while (p + 8 <= d.length) {
      const id = str4();
      const size = u32();
      if (id === "data") break;
      p += size + (size & 1);
    }
  } else p = 0;
  if (str4() !== "MThd") throw new Error("not a MIDI file");
  const hlen = u32();
  const hstart = p;
  u16(); // format
  const ntracks = u16();
  const division = u16();
  p = hstart + hlen;
  if (division & 0x8000) throw new Error("SMPTE time division is not supported");
  const events: RawEvent[] = [];
  const trackNameBytes: Uint8Array[] = [];
  let order = 0;
  for (let tr = 0; tr < ntracks && p < d.length; tr++) {
    const id = str4();
    const len = u32();
    const end = Math.min(d.length, p + len);
    if (id !== "MTrk") {
      p = end;
      continue;
    }
    let tick = 0;
    let running = 0;
    const vlq = () => {
      let v = 0;
      for (let i = 0; i < 4; i++) {
        const b = d[p++];
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return v;
    };
    while (p < end) {
      tick += vlq();
      let status = d[p];
      if (status & 0x80) p++;
      else status = running;
      if (status === 0xff) {
        const type = d[p++];
        const l = vlq();
        const md = d.subarray(p, p + l);
        p += l;
        if (type === 0x2f) break;
        if (type === 0x03 && trackNameBytes[tr] === undefined) trackNameBytes[tr] = md;
        events.push({ tick, track: tr, order: order++, status, data: [], meta: type, metaData: md });
      } else if (status === 0xf0 || status === 0xf7) {
        p += vlq();
      } else {
        running = status;
        const hi = status & 0xf0;
        const n = hi === 0xc0 || hi === 0xd0 ? 1 : 2;
        const data = Array.from(d.subarray(p, p + n));
        p += n;
        events.push({ tick, track: tr, order: order++, status, data });
      }
    }
    p = end;
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  // one encoding for every text event of the file, so a character isn't read alone
  const encoding = textEncoding(events.filter((e) => e.meta !== undefined && e.meta >= 0x01 && e.meta <= 0x07 && e.metaData).map((e) => e.metaData!));
  const decodeText = decoderFor(encoding);
  const trackNames: string[] = [];
  trackNameBytes.forEach((b, i) => (trackNames[i] = decodeText(b).trim()));

  // ticks to seconds through the tempo changes
  let tempo = 500000;
  let lastTick = 0;
  let lastSec = 0;
  const sec = (tick: number) => lastSec + ((tick - lastTick) * tempo) / 1e6 / division;
  const notes: MidiNote[] = [];
  const texts: MidiText[] = [];
  const controls: MidiControl[] = [];
  const programs = new Array<number>(16).fill(-1);
  const open = new Map<number, { t0: number; vel: number; track: number }[]>();
  let end = 0;
  for (const e of events) {
    const t = sec(e.tick);
    end = Math.max(end, t);
    if (e.status === 0xff) {
      if (e.meta === 0x51 && e.metaData && e.metaData.length >= 3) {
        lastSec = t;
        lastTick = e.tick;
        tempo = (e.metaData[0] << 16) | (e.metaData[1] << 8) | e.metaData[2];
      } else if ((e.meta === 0x01 || e.meta === 0x05) && e.metaData) {
        texts.push({ t, track: e.track, kind: e.meta, text: decodeText(e.metaData) });
      }
      continue;
    }
    const hi = e.status & 0xf0;
    const ch = e.status & 0x0f;
    if (hi === 0x90 && e.data[1] > 0) {
      const key = ch * 128 + e.data[0];
      let list = open.get(key);
      if (!list) open.set(key, (list = []));
      list.push({ t0: t, vel: e.data[1], track: e.track });
    } else if (hi === 0x80 || hi === 0x90) {
      const key = ch * 128 + e.data[0];
      const on = open.get(key)?.shift();
      if (on) notes.push({ t0: on.t0, t1: Math.max(t, on.t0 + 0.01), track: on.track, ch, midi: e.data[0], vel: on.vel });
    } else {
      if (hi === 0xc0 && programs[ch] < 0) programs[ch] = e.data[0];
      controls.push({ t, track: e.track, bytes: [e.status, ...e.data] });
    }
  }
  for (const [key, list] of open) for (const on of list) notes.push({ t0: on.t0, t1: end, track: on.track, ch: Math.floor(key / 128), midi: key % 128, vel: on.vel });
  notes.sort((a, b) => a.t0 - b.t0 || a.midi - b.midi);
  // some files open with minutes (or hours) of nothing, a broken first delta: start them 2 s
  // before their first note, keeping the set-up events at 0
  const first = notes[0]?.t0 ?? 0;
  if (first > 30) {
    const cut = first - 2;
    const at = (t: number) => Math.max(0, t - cut);
    for (const n of notes) {
      n.t0 = at(n.t0);
      n.t1 = at(n.t1);
    }
    for (const x of texts) x.t = at(x.t);
    for (const c of controls) c.t = at(c.t);
    end = at(end);
  }
  return { notes, texts, controls, trackNames, programs, duration: end, encoding };
}

/** the General MIDI instrument of each program number */
export const GM_NAMES = "Acoustic Grand Piano|Bright Piano|Electric Grand|Honky-tonk Piano|Electric Piano 1|Electric Piano 2|Harpsichord|Clavinet|Celesta|Glockenspiel|Music Box|Vibraphone|Marimba|Xylophone|Tubular Bells|Dulcimer|Drawbar Organ|Percussive Organ|Rock Organ|Church Organ|Reed Organ|Accordion|Harmonica|Bandoneon|Nylon Guitar|Steel Guitar|Jazz Guitar|Clean Guitar|Muted Guitar|Overdriven Guitar|Distortion Guitar|Guitar Harmonics|Acoustic Bass|Finger Bass|Pick Bass|Fretless Bass|Slap Bass 1|Slap Bass 2|Synth Bass 1|Synth Bass 2|Violin|Viola|Cello|Contrabass|Tremolo Strings|Pizzicato Strings|Harp|Timpani|Strings|Slow Strings|Synth Strings 1|Synth Strings 2|Choir Aahs|Voice Oohs|Synth Voice|Orchestra Hit|Trumpet|Trombone|Tuba|Muted Trumpet|French Horn|Brass Section|Synth Brass 1|Synth Brass 2|Soprano Sax|Alto Sax|Tenor Sax|Baritone Sax|Oboe|English Horn|Bassoon|Clarinet|Piccolo|Flute|Recorder|Pan Flute|Blown Bottle|Shakuhachi|Whistle|Ocarina|Square Lead|Saw Lead|Calliope Lead|Chiff Lead|Charang|Voice Lead|Fifths Lead|Bass Lead|New Age Pad|Warm Pad|Polysynth|Choir Pad|Bowed Pad|Metallic Pad|Halo Pad|Sweep Pad|Rain|Soundtrack|Crystal|Atmosphere|Brightness|Goblins|Echoes|Sci-fi|Sitar|Banjo|Shamisen|Koto|Kalimba|Bagpipe|Fiddle|Shanai|Tinkle Bell|Agogo|Steel Drums|Woodblock|Taiko Drum|Melodic Tom|Synth Drum|Reverse Cymbal|Guitar Fret Noise|Breath Noise|Seashore|Bird Tweet|Telephone Ring|Helicopter|Applause|Gunshot".split("|");

/**
 * A track's name as the page shows it: its own name where that tells it from the others, else
 * the instrument its channel starts on (a format 0 file names every track after the song).
 */
export function trackLabel(m: MidiFile, key: string, keys: string[]): string {
  const [tr, ch] = key.split(":").map(Number);
  const own = (m.trackNames[tr] ?? "").trim();
  const shared = keys.filter((k) => (m.trackNames[Number(k.split(":")[0])] ?? "").trim() === own).length > 1;
  const instrument = ch === 9 ? "Drums" : m.programs[ch] >= 0 ? GM_NAMES[m.programs[ch]] : "";
  if (own && !shared && /[a-z]/i.test(own)) return own;
  return instrument ? `${instrument}${own && !shared ? ` (${own})` : ""}` : own || `Track ${tr} · ch ${ch + 1}`;
}
