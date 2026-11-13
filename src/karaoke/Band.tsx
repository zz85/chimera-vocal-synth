/**
 * The band: one tile for each instrument of the backing, drawn from the notes it plays now, in
 * the page's vector style. Keyboards light their keys, guitars and basses pluck their strings,
 * bowed strings vibrate while a note holds, winds and voices breathe out rings, pads glow, and
 * the drum kit flashes each drum it hits. A click on a tile mutes that instrument.
 */
import { useEffect, useMemo, useRef } from "react";
import { GM_NAMES, type MidiFile, type MidiNote } from "./midifile.ts";
import { V } from "../ui/colors.ts";
import type { KaraokePlayer } from "./player.ts";

type Family = "keys" | "mallet" | "organ" | "guitar" | "bass" | "strings" | "ensemble" | "choir" | "brass" | "reed" | "pipe" | "lead" | "pad" | "fx" | "drums";

export interface Instrument {
  key: string;
  name: string;
  family: Family;
  notes: MidiNote[];
  lo: number;
  hi: number;
}

function familyOf(ch: number, program: number): Family {
  if (ch === 9) return "drums";
  const p = Math.max(0, program);
  if (p < 8) return "keys";
  if (p < 16) return p === 15 ? "guitar" : "mallet";
  if (p < 24) return p >= 21 ? "reed" : "organ";
  if (p < 32) return "guitar";
  if (p < 40) return "bass";
  if (p < 46) return "strings";
  // harp is plucked, timpani low and pitched
  if (p < 48) return p === 46 ? "guitar" : "bass";
  if (p < 52) return "strings";
  if (p < 56) return p === 55 ? "fx" : "choir";
  if (p < 64) return "brass";
  if (p < 72) return "reed";
  if (p < 80) return "pipe";
  if (p < 88) return "lead";
  if (p < 96) return "pad";
  if (p < 104) return "fx";
  if (p < 112) return "guitar";
  return "drums";
}

const COLOR: Record<Family, string> = {
  keys: V.white,
  mallet: V.white,
  organ: V.pink,
  guitar: V.amber,
  bass: V.red,
  strings: V.green,
  ensemble: V.green,
  choir: V.pink,
  brass: V.amber,
  reed: V.pink,
  pipe: V.blue,
  lead: V.blue,
  pad: V.blueMid,
  fx: V.blueMid,
  drums: V.red,
};

/** the backing's instruments, busiest first, the drums last */
export function instrumentsOf(m: MidiFile | null): Instrument[] {
  if (!m) return [];
  const by = new Map<string, MidiNote[]>();
  for (const n of m.notes) {
    const k = `${n.track}:${n.ch}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(n);
  }
  const out: Instrument[] = [];
  for (const [key, notes] of by) {
    const ch = Number(key.split(":")[1]);
    const prog = m.programs[ch];
    const family = familyOf(ch, prog);
    let lo = 127, hi = 0;
    for (const n of notes) {
      lo = Math.min(lo, n.midi);
      hi = Math.max(hi, n.midi);
    }
    notes.sort((a, b) => a.t0 - b.t0);
    out.push({ key, name: ch === 9 ? "Drums" : prog >= 0 ? GM_NAMES[prog] : `Channel ${ch + 1}`, family, notes, lo, hi });
  }
  // two of one instrument: tell them apart
  for (const x of out) if (out.filter((y) => y.name === x.name).length > 1) x.name = `${x.name} ${Number(x.key.split(":")[1]) + 1}`;
  out.sort((a, b) => (a.family === "drums" ? 1 : 0) - (b.family === "drums" ? 1 : 0) || b.notes.length - a.notes.length);
  return out;
}

/** the notes sounding at t, and those that started in the last `recent` seconds */
function around(notes: MidiNote[], t: number, recent = 0.35): MidiNote[] {
  let lo = 0, hi = notes.length - 1, k = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (notes[m].t0 <= t) {
      k = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  const out: MidiNote[] = [];
  for (let i = k; i >= 0 && i > k - 160 && notes[i].t0 > t - 12; i--) if (notes[i].t1 > t || t - notes[i].t0 < recent) out.push(notes[i]);
  return out;
}

const BLACK = new Set([1, 3, 6, 8, 10]);

function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function drawTile(g: CanvasRenderingContext2D, ins: Instrument, r: Rect, t: number, muted: boolean, level: number) {
  const c = COLOR[ins.family];
  const on = around(ins.notes, t);
  // the frame and the name
  g.strokeStyle = alpha(muted ? V.blueDim : c, muted ? 0.4 : 0.25 + 0.5 * level);
  g.lineWidth = 1;
  g.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  g.fillStyle = muted ? V.blueDim : alpha(c, 0.85);
  g.font = "10px system-ui";
  g.fillText(ins.name.toUpperCase(), r.x + 6, r.y + 13, r.w - 12);
  if (muted) {
    g.fillStyle = V.blueDim;
    g.fillText("MUTED", r.x + r.w - 44, r.y + r.h - 7);
  }
  // the level, a thin bar along the bottom
  g.fillStyle = alpha(c, muted ? 0.15 : 0.6);
  g.fillRect(r.x + 1, r.y + r.h - 3, (r.w - 2) * Math.min(1, level), 2);
  const a = { x: r.x + 6, y: r.y + 20, w: r.w - 12, h: r.h - 30 };
  if (a.w < 10 || a.h < 10) return;
  const dim = muted ? 0.25 : 1;
  const env = (n: MidiNote) => {
    const age = t - n.t0;
    const held = n.t1 > t ? 1 : Math.max(0, 1 - (t - n.t1) / 0.25);
    return (n.vel / 127) * held * (age < 0.08 ? 1.3 : 1) * dim;
  };
  g.save();
  g.beginPath();
  g.rect(a.x, a.y, a.w, a.h);
  g.clip();
  switch (ins.family) {
    case "keys":
    case "mallet":
    case "organ": {
      // a keyboard over the instrument's range, its playing keys lit
      const lo = Math.max(0, ins.lo - 2 - ((ins.lo - 2) % 12));
      const hi = Math.min(127, ins.hi + 2);
      const whites: number[] = [];
      for (let m = lo; m <= hi; m++) if (!BLACK.has(m % 12)) whites.push(m);
      const kw = a.w / whites.length;
      const lit = new Map<number, number>();
      for (const n of on) lit.set(n.midi, Math.max(lit.get(n.midi) ?? 0, env(n)));
      const kh = Math.min(a.h, kw * 5.5);
      const ky = a.y + a.h - kh;
      whites.forEach((m, i) => {
        const v = lit.get(m) ?? 0;
        g.fillStyle = v ? alpha(c, 0.25 + 0.75 * v) : "rgba(238,246,248,0.07)";
        g.fillRect(a.x + i * kw + 0.5, ky, kw - 1, kh);
      });
      whites.forEach((m, i) => {
        if (!BLACK.has((m + 1) % 12) || m + 1 > hi) return;
        const v = lit.get(m + 1) ?? 0;
        g.fillStyle = v ? alpha(c, 0.35 + 0.65 * v) : "#02060a";
        g.fillRect(a.x + (i + 0.65) * kw, ky, kw * 0.7, kh * 0.6);
      });
      // notes rising off the keys as they play
      for (const n of on) {
        const i = whites.findIndex((m) => m >= n.midi);
        const x = a.x + (Math.max(0, i) + 0.5) * kw;
        const rise = Math.min(1, (t - n.t0) / 0.6) * (ky - a.y);
        g.fillStyle = alpha(c, 0.5 * env(n));
        g.fillRect(x - 1, ky - rise, 2, rise);
      }
      break;
    }
    case "guitar":
    case "bass":
    case "strings":
    case "ensemble": {
      // strings across the tile: a plucked one rings and dies away, a bowed one shakes while held
      const n = ins.family === "bass" ? 4 : ins.family === "guitar" ? 6 : 4;
      const bowed = ins.family === "strings" || ins.family === "ensemble";
      const span = Math.max(1, ins.hi - ins.lo);
      for (let s = 0; s < n; s++) {
        const y = a.y + a.h * ((s + 0.5) / n);
        let amp = 0;
        let f = 3;
        for (const x of on) {
          const si = Math.min(n - 1, Math.floor(((ins.hi - x.midi) / (span + 1)) * n));
          if (si !== s) continue;
          const age = t - x.t0;
          const e = bowed ? env(x) : (x.vel / 127) * Math.exp(-age * 3) * dim;
          if (e > amp) {
            amp = e;
            f = 2 + (x.midi % 12) / 3;
          }
        }
        g.strokeStyle = alpha(c, 0.25 + 0.75 * amp);
        g.lineWidth = ins.family === "bass" ? 2 : 1;
        g.beginPath();
        const A = amp * (a.h / n) * 0.42;
        for (let k = 0; k <= 40; k++) {
          const u = k / 40;
          const yy = y + A * Math.sin(Math.PI * u) * Math.sin(u * f * Math.PI * 2 + t * (bowed ? 40 : 60));
          if (k === 0) g.moveTo(a.x + u * a.w, yy);
          else g.lineTo(a.x + u * a.w, yy);
        }
        g.stroke();
      }
      break;
    }
    case "brass":
    case "reed":
    case "pipe":
    case "choir":
    case "lead": {
      // each note breathes out a ring from its pitch's height
      const span = Math.max(1, ins.hi - ins.lo);
      const cx = a.x + a.w * 0.2;
      for (const n of on) {
        const y = a.y + a.h * (1 - (n.midi - ins.lo) / span) * 0.8 + a.h * 0.1;
        const age = t - n.t0;
        const e = env(n);
        for (let k = 0; k < 3; k++) {
          const rr = ((age * 1.4 + k / 3) % 1) * a.w * 0.8;
          g.strokeStyle = alpha(c, e * (1 - rr / (a.w * 0.8)) * 0.8);
          g.beginPath();
          g.arc(cx, y, rr, -0.7, 0.7);
          g.stroke();
        }
        g.fillStyle = alpha(c, e);
        g.beginPath();
        g.arc(cx, y, 3, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case "pad":
    case "fx": {
      // a glow that swells with the chord
      let sum = 0;
      for (const n of on) sum += env(n);
      const v = Math.min(1, sum / 3);
      const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
      const rad = Math.min(a.w, a.h) * (0.25 + 0.25 * v + 0.03 * Math.sin(t * 2));
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
      grad.addColorStop(0, alpha(c, 0.7 * v));
      grad.addColorStop(1, alpha(c, 0));
      g.fillStyle = grad;
      g.fillRect(a.x, a.y, a.w, a.h);
      break;
    }
    case "drums": {
      // the kit: each drum a pad that flashes as it's hit
      const pads: { label: string; x: number; y: number; r: number; notes: number[] }[] = [
        { label: "kick", x: 0.5, y: 0.72, r: 0.2, notes: [35, 36] },
        { label: "snare", x: 0.3, y: 0.5, r: 0.12, notes: [37, 38, 39, 40] },
        { label: "hat", x: 0.12, y: 0.32, r: 0.09, notes: [42, 44, 46] },
        { label: "toms", x: 0.62, y: 0.36, r: 0.1, notes: [41, 43, 45, 47, 48, 50] },
        { label: "crash", x: 0.86, y: 0.22, r: 0.12, notes: [49, 52, 55, 57] },
        { label: "ride", x: 0.86, y: 0.62, r: 0.11, notes: [51, 53, 59] },
      ];
      const known = new Set(pads.flatMap((p) => p.notes));
      const s = Math.min(a.w, a.h * 1.6);
      for (const p of pads) {
        let v = 0;
        for (const n of on) if (p.notes.includes(n.midi)) v = Math.max(v, (n.vel / 127) * Math.max(0, 1 - (t - n.t0) / 0.3) * dim);
        const x = a.x + p.x * a.w, y = a.y + p.y * a.h, rr = p.r * s * (1 + 0.15 * v);
        g.strokeStyle = alpha(c, 0.3 + 0.7 * v);
        g.fillStyle = alpha(c, 0.6 * v);
        g.beginPath();
        if (p.label === "crash" || p.label === "ride" || p.label === "hat") g.ellipse(x, y, rr, rr * 0.35, 0, 0, Math.PI * 2);
        else g.arc(x, y, rr, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
      // the rest of the percussion: sparks across the top
      for (const n of on)
        if (!known.has(n.midi)) {
          const v = Math.max(0, 1 - (t - n.t0) / 0.25) * dim;
          g.fillStyle = alpha(V.amber, v);
          g.fillRect(a.x + ((n.midi * 37) % 100) / 100 * a.w, a.y + 2, 3, 3);
        }
      break;
    }
  }
  g.restore();
}

/** tiles for n instruments in a w×h area, as square as they go */
function layout(n: number, w: number, h: number): Rect[] {
  if (!n) return [];
  // the column count whose tiles come out biggest at about 3:2
  let cols = 1, size = 0;
  for (let c = 1; c <= n; c++) {
    const s = Math.min(w / c / 1.5, h / Math.ceil(n / c));
    if (s > size) {
      size = s;
      cols = c;
    }
  }
  const rows = Math.ceil(n / cols);
  const tw = w / cols, th = h / rows;
  return Array.from({ length: n }, (_, i) => ({ x: (i % cols) * tw + 2, y: Math.floor(i / cols) * th + 2, w: tw - 4, h: th - 4 }));
}

export function Band(props: { player: KaraokePlayer; backing: MidiFile | null; muted: string[]; onToggle: (key: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const instruments = useMemo(() => instrumentsOf(props.backing), [props.backing]);
  const live = useRef({ instruments, muted: props.muted, rects: [] as Rect[], levels: new Map<string, number>() });
  live.current.instruments = instruments;
  live.current.muted = props.muted;
  useEffect(() => {
    const c = ref.current!;
    const g = c.getContext("2d")!;
    let raf = 0;
    let last = performance.now();
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const dpr = Math.min(2, devicePixelRatio);
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const L = live.current;
      const rects = layout(L.instruments.length, w, h);
      L.rects = rects;
      const t = props.player.time();
      const playing = props.player.playing;
      L.instruments.forEach((ins, i) => {
        // how busy it is now, eased
        let sum = 0;
        if (playing) for (const n of around(ins.notes, t, 0.15)) sum += n.vel / 127;
        const prev = L.levels.get(ins.key) ?? 0;
        const target = Math.min(1, sum / (ins.family === "drums" ? 1.5 : 2.5));
        L.levels.set(ins.key, prev + (target - prev) * Math.min(1, dt * (target > prev ? 25 : 4)));
        drawTile(g, ins, rects[i], playing ? t : -1, L.muted.includes(ins.key), L.levels.get(ins.key)!);
      });
      if (!L.instruments.length) {
        g.fillStyle = V.blueMid;
        g.font = "12px system-ui";
        g.fillText("No backing instruments", 12, 24);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
    // the player outlives the panel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <canvas
      ref={ref}
      className="k-band"
      title="Click an instrument to mute it"
      onClick={(e) => {
        const b = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - b.left, y = e.clientY - b.top;
        const L = live.current;
        const i = L.rects.findIndex((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
        if (i >= 0) props.onToggle(L.instruments[i].key);
      }}
    />
  );
}
