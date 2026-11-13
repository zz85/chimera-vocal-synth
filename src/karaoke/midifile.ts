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

/** text bytes: UTF-8 where they read as such, else Latin-1 (most old .kar files) */
function decodeText(b: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return Array.from(b, (c) => String.fromCharCode(c)).join("");
  }
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
  const trackNames: string[] = [];
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
        if (type === 0x03 && trackNames[tr] === undefined) trackNames[tr] = decodeText(md).trim();
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
  return { notes, texts, controls, trackNames, programs, duration: end };
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
