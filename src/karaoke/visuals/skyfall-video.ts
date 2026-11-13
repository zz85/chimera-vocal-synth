/**
 * Skyfall, the music video: a visual for Adele's "Skyfall" cut like a film's title sequence.
 * It reads the song's sections from its lyrics (the verses, the build, the choruses, the bridge,
 * the instrumental break) and gives each its own scene, drawn from scratch after the mood of a
 * spy film's titles rather than copied from any of them:
 *
 *   intro        smoke, and the title coming up out of it
 *   verse 1      a man in a suit sinking through dark water, red ink blooming as she sings
 *   the build    a rifled barrel turning, a figure walking at its end, red running down
 *   chorus 1     the night sky cracking and falling in pieces over the hills
 *   verse 2      the highlands at night: a stag, a lodge with lit windows, mist and lightning
 *   chorus 2     a kaleidoscope of red ink and shadow figures
 *   the break    targets in a dark range, shot through on the drums
 *   the bridge   two figures in the rain under one lamp, closing the distance
 *   last chorus  the lodge burning, a man walking out of the fire
 *   outro        embers, the title, and an iris closing to black
 *
 * Inside a section the camera cuts to a new framing every couple of lines and drifts slowly
 * (a push in, a pan); sections cross-fade, a chorus comes in on a flash. The picture is
 * letterboxed with grain and a vignette, and the line being sung runs as a caption under it.
 */
import type { MidiNote } from "../midifile.ts";
import type { Song } from "../song.ts";
import type { Visual, VisualHost } from "./types.ts";

type Kind = "intro" | "verse" | "pre" | "chorus" | "bridge" | "break" | "outro";
interface Section {
  kind: Kind;
  /** which of its kind it is, from 0, and how many of its kind the song has */
  n: number;
  of: number;
  t0: number;
  t1: number;
  /** the start of each line in it */
  lines: number[];
}

/** what a scene draws a frame from */
interface Frame {
  t: number;
  dt: number;
  /** seconds into the section, and how far through it (0..1) */
  lt: number;
  sp: number;
  /** the camera shot within the section */
  shot: number;
  /** the mix's loudness and the voice's (0..1, smoothed) */
  loud: number;
  sing: number;
  playing: boolean;
  /** this frame: a kick, a snare, a cymbal; the backing's other notes */
  kick: number;
  snare: number;
  crash: number;
  notes: MidiNote[];
  /** a word that began this frame, lower case, or "" */
  word: string;
  /** the whole song's progress (0..1) */
  p: number;
}

interface Scene {
  draw(g: CanvasRenderingContext2D, w: number, h: number, f: Frame): void;
}
type SceneMaker = (rand: () => number, host: VisualHost) => Scene;

/** a small seeded random, so a seek replays the same picture */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const TAU = Math.PI * 2;
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x: number) => x * x * (3 - 2 * x);

// ---- the song's sections, from its lyrics -------------------------------------------------

const KINDS: [Kind, RegExp][] = [
  ["bridge", /where you go|what you see|never be|security|loving arms|from harm|hand in my hand|we'?ll stand$/i],
  ["chorus", /let the sky fall|crumbles|stand tall|face it|together|^at sky ?fall/i],
  ["pre", /for this is the end|drowned|overdue|swept away/i],
];

export function sections(song: Song, duration: number): Section[] {
  const notes = song.parts[0]?.notes ?? [];
  const lines: { t0: number; t1: number; text: string }[] = [];
  notes.forEach((n, i) => {
    if (n.lineStart || i === 0) lines.push({ t0: n.t0, t1: n.t1, text: "" });
    const l = lines[lines.length - 1];
    l.text += (n.wordStart && l.text ? " " : "") + n.text;
    l.t1 = n.t1;
  });
  const out: Section[] = [];
  const end = Math.max(duration, lines.length ? lines[lines.length - 1].t1 + 4 : 30);
  const push = (kind: Kind, t0: number, line?: number) => {
    const last = out[out.length - 1];
    if (last) last.t1 = t0;
    out.push({ kind, n: 0, of: 0, t0, t1: end, lines: line === undefined ? [] : [line] });
  };
  push("intro", 0);
  let prevEnd = 0;
  for (const l of lines) {
    const kind = KINDS.find(([, re]) => re.test(l.text.trim()))?.[0] ?? "verse";
    const cur = out[out.length - 1];
    // a long gap with nothing sung is the band's
    if (cur.kind !== "intro" && l.t0 - prevEnd > 12) push("break", prevEnd + 1.5);
    const now = out[out.length - 1];
    if (now.kind === kind) now.lines.push(l.t0);
    else push(kind, now.kind === "intro" || now.kind === "break" ? l.t0 - 0.6 : l.t0, l.t0);
    prevEnd = l.t1;
  }
  if (lines.length) push("outro", prevEnd + 1.5);
  // too short to be a section of its own: part of the one before
  for (let i = out.length - 2; i >= 1; i--)
    if (out[i].t1 - out[i].t0 < 4 && out[i].kind !== "outro") {
      out[i - 1].t1 = out[i].t1;
      out[i - 1].lines.push(...out[i].lines);
      out.splice(i, 1);
    }
  // a line or two sung after the last chorus is the song's tail
  const tail = out[out.length - 2];
  if (out.length > 2 && out[out.length - 1].kind === "outro" && tail.kind === "verse" && tail.lines.length <= 2) {
    tail.kind = "outro";
    tail.t1 = out[out.length - 1].t1;
    out.pop();
  }
  const count = new Map<Kind, number>();
  for (const s of out) {
    s.n = count.get(s.kind) ?? 0;
    count.set(s.kind, s.n + 1);
  }
  for (const s of out) s.of = count.get(s.kind)!;
  return out;
}

// ---- shared drawing -----------------------------------------------------------------------

/** a soft round puff, for smoke and mist */
function puffSprite(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.5, "rgba(255,255,255,0.35)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return c;
}

/** a man in a suit, feet at (0,0), about 1 unit tall: standing, walking, or sinking arms-up */
function man(g: CanvasRenderingContext2D, x: number, y: number, s: number, pose: "stand" | "walk" | "sink", phase: number, fill: string, rim?: string) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  const leg = pose === "walk" ? 0.09 * Math.sin(phase) : 0;
  const arm = pose === "walk" ? 0.06 * Math.sin(phase) : 0;
  g.beginPath();
  g.arc(0, -0.9, 0.065, 0, TAU);
  // jacket and trousers
  g.moveTo(-0.13, -0.8);
  g.lineTo(0.13, -0.8);
  g.lineTo(0.11, -0.42);
  g.lineTo(0.08 + leg, 0);
  g.lineTo(0.03 + leg, 0);
  g.lineTo(0, -0.38);
  g.lineTo(-0.03 - leg, 0);
  g.lineTo(-0.08 - leg, 0);
  g.lineTo(-0.11, -0.42);
  g.closePath();
  for (const side of [-1, 1]) {
    g.moveTo(side * 0.12, -0.78);
    if (pose === "sink") {
      g.lineTo(side * 0.38, -1.08);
      g.lineTo(side * 0.41, -1.04);
      g.lineTo(side * 0.135, -0.68);
    } else {
      g.lineTo(side * 0.15 + side * arm * side, -0.4);
      g.lineTo(side * 0.115 + side * arm * side, -0.4);
      g.lineTo(side * 0.1, -0.7);
    }
    g.closePath();
  }
  g.fillStyle = fill;
  g.fill();
  if (rim) {
    g.strokeStyle = rim;
    g.lineWidth = 1.2 / s;
    g.stroke();
  }
  g.restore();
}

/** a woman in a long dress, feet at (0,0), about 0.95 tall; `reach` lifts her near arm */
function woman(g: CanvasRenderingContext2D, x: number, y: number, s: number, dir: number, reach: number, fill: string) {
  g.save();
  g.translate(x, y);
  g.scale(s * dir, s);
  g.beginPath();
  g.arc(0, -0.86, 0.06, 0, TAU);
  g.moveTo(-0.025, -0.95);
  g.quadraticCurveTo(-0.12, -0.9, -0.09, -0.72); // her hair down the back
  g.lineTo(-0.06, -0.78);
  g.moveTo(-0.1, -0.76);
  g.lineTo(0.1, -0.76);
  g.lineTo(0.06, -0.5);
  g.quadraticCurveTo(0.12, -0.2, 0.2, 0);
  g.lineTo(-0.18, 0);
  g.quadraticCurveTo(-0.1, -0.2, -0.06, -0.5);
  g.closePath();
  g.moveTo(0.09, -0.74);
  g.lineTo(0.09 + 0.25 * reach + 0.03, -0.45 - 0.18 * reach);
  g.lineTo(0.09 + 0.25 * reach, -0.42 - 0.18 * reach);
  g.lineTo(0.07, -0.66);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.restore();
}

/** a stone lodge with steep gables and chimneys, its base centred at (x, y), `s` wide */
function lodge(g: CanvasRenderingContext2D, x: number, y: number, s: number, fill: string, lit: number, t: number) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.beginPath();
  g.moveTo(-0.5, 0);
  g.lineTo(-0.5, -0.3);
  g.lineTo(-0.36, -0.52);
  g.lineTo(-0.22, -0.3);
  g.lineTo(0.12, -0.3);
  g.lineTo(0.27, -0.58);
  g.lineTo(0.42, -0.3);
  g.lineTo(0.5, -0.3);
  g.lineTo(0.5, 0);
  g.closePath();
  g.rect(-0.3, -0.62, 0.05, 0.3);
  g.rect(0.33, -0.72, 0.05, 0.3);
  g.fillStyle = fill;
  g.fill();
  if (lit > 0) {
    const wins = [-0.42, -0.31, -0.12, 0.02, 0.21, 0.33];
    wins.forEach((wx, i) => {
      const fl = 0.75 + 0.25 * Math.sin(t * (5 + i) + i * 3);
      g.fillStyle = `rgba(255,${170 + 40 * fl},90,${lit * fl})`;
      g.fillRect(wx, -0.22, 0.05, 0.08);
      if (i % 2 === 0) g.fillRect(wx + 0.01, -0.44 + (i === 2 ? 0.12 : 0), 0.03, 0.06);
    });
  }
  g.restore();
}

/** a stag in profile, hooves at (x, y), facing `dir` */
function stag(g: CanvasRenderingContext2D, x: number, y: number, s: number, dir: number, fill: string, t: number) {
  g.save();
  g.translate(x, y);
  g.scale(s * dir, s);
  g.fillStyle = fill;
  g.strokeStyle = fill;
  g.beginPath();
  g.ellipse(0, -0.55, 0.3, 0.13, 0, 0, TAU);
  g.fill();
  for (const lx of [-0.22, -0.15, 0.17, 0.24]) g.fillRect(lx, -0.5, 0.035, 0.5);
  // neck and head, lifting now and then
  const lift = 0.04 * Math.sin(t * 0.5);
  g.beginPath();
  g.moveTo(0.18, -0.62);
  g.lineTo(0.34, -0.95 - lift);
  g.lineTo(0.47, -0.92 - lift);
  g.lineTo(0.42, -0.86 - lift);
  g.lineTo(0.3, -0.52);
  g.closePath();
  g.fill();
  // antlers
  g.lineWidth = 0.022;
  g.lineCap = "round";
  const hx = 0.36, hy = -0.98 - lift;
  for (const side of [0, 1]) {
    const o = side * 0.05;
    g.beginPath();
    g.moveTo(hx + o, hy);
    g.quadraticCurveTo(hx - 0.1 + o, hy - 0.2, hx - 0.02 + o, hy - 0.38);
    for (const [k, dx, dy] of [[0.25, 0.1, -0.06], [0.55, 0.1, -0.05], [0.8, -0.08, -0.07]] as const) {
      const px = hx + o - 0.07 * k, py = hy - 0.38 * k;
      g.moveTo(px, py);
      g.lineTo(px + dx, py + dy);
    }
    g.stroke();
  }
  g.restore();
}

/** the line of a ridge across the picture, seeded, filled down to the bottom */
function ridge(g: CanvasRenderingContext2D, w: number, h: number, y0: number, amp: number, seed: number, fill: string | CanvasGradient) {
  g.beginPath();
  g.moveTo(0, h);
  for (let x = 0; x <= w + 8; x += 8) {
    const u = x / w;
    const y = y0 - amp * (0.55 * Math.sin(u * 5.1 + seed) + 0.3 * Math.sin(u * 11.7 + seed * 2.3) + 0.15 * Math.sin(u * 23 + seed * 5.1));
    g.lineTo(x, y);
  }
  g.lineTo(w, h);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

/** a jagged bolt from (x, 0) down to y1 */
function bolt(g: CanvasRenderingContext2D, rand: () => number, x: number, y1: number, a: number) {
  g.save();
  g.strokeStyle = `rgba(230,240,255,${a})`;
  g.lineWidth = 2;
  g.shadowColor = "rgba(180,200,255,0.9)";
  g.shadowBlur = 12;
  g.beginPath();
  let px = x, py = 0;
  g.moveTo(px, py);
  while (py < y1) {
    px += (rand() - 0.5) * 30;
    py += 10 + rand() * 25;
    g.lineTo(px, py);
  }
  g.stroke();
  g.restore();
}

// ---- the scenes ---------------------------------------------------------------------------

/** intro: smoke, and the title coming up out of it */
const smokeTitle: SceneMaker = (rand, host) => {
  const puff = puffSprite();
  const puffs = Array.from({ length: 46 }, () => ({ x: rand(), y: rand(), s: 0.15 + rand() * 0.35, v: 0.005 + rand() * 0.01, ph: rand() * TAU }));
  const sparks: { x: number; y: number; a: number }[] = [];
  const title = (host.song.title || "Skyfall").toUpperCase();
  const artist = (host.song.artist || "").toUpperCase();
  return {
    draw(g, w, h, f) {
      g.fillStyle = "#030304";
      g.fillRect(0, 0, w, h);
      g.save();
      for (const p of puffs) {
        const y = ((p.y - f.t * p.v) % 1 + 1) % 1;
        const x = p.x + 0.05 * Math.sin(f.t * 0.2 + p.ph);
        const s = p.s * Math.max(w, h);
        g.globalAlpha = 0.06 + 0.05 * Math.sin(f.t * 0.3 + p.ph) + 0.06 * f.loud;
        g.drawImage(puff, x * w - s / 2, y * h * 1.2 - s / 2, s, s);
      }
      g.restore();
      // a soft light on each note of the piano
      for (const n of f.notes) if (n.ch !== 9) sparks.push({ x: clamp((n.midi - 36) / 60), y: 0.3 + rand() * 0.4, a: 0.6 * (n.vel / 127) });
      g.save();
      g.globalCompositeOperation = "lighter";
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.a -= f.dt * 0.4;
        if (s.a <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        g.globalAlpha = s.a;
        const r = Math.min(w, h) * 0.08;
        g.drawImage(puff, s.x * w - r / 2, s.y * h - r / 2, r, r);
      }
      g.restore();
      // the title: its letters spread as it comes up, a red rule grows under it
      const a = ease(clamp((f.lt - 3) / 8)) * (1 - ease(clamp((f.lt - (f.lt / Math.max(f.sp, 1e-3)) + 3) / 3)));
      if (a > 0) {
        const size = Math.min(w * 0.09, h * 0.2);
        g.save();
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillStyle = `rgba(236,232,224,${a})`;
        g.font = `300 ${size}px Georgia, "Times New Roman", serif`;
        const track = size * (0.25 + 0.25 * f.sp);
        const chars = [...title];
        const widths = chars.map((c) => g.measureText(c).width + track);
        let x = w / 2 - (widths.reduce((s, v) => s + v, 0) - track) / 2;
        chars.forEach((c, i) => {
          g.fillText(c, x + widths[i] / 2 - track / 2, h * 0.5);
          x += widths[i];
        });
        g.fillStyle = `rgba(170,14,20,${a})`;
        const rw = w * 0.4 * ease(clamp((f.lt - 6) / 10));
        g.fillRect(w / 2 - rw / 2, h * 0.5 + size * 0.62, rw, Math.max(1.5, size * 0.03));
        if (artist) {
          g.fillStyle = `rgba(200,196,188,${a * 0.7})`;
          g.font = `${Math.round(size * 0.22)}px Georgia, serif`;
          g.fillText([...artist].join(" "), w / 2, h * 0.5 - size * 0.8);
        }
        g.restore();
      }
    },
  };
};

/** verse: a man in a suit sinking through dark water, red ink as she sings */
const water: SceneMaker = (rand) => {
  const ink: { x: number; y: number; vx: number; vy: number; r: number; life: number; age: number }[] = [];
  const rings: { x: number; y: number; r: number; v: number; a: number }[] = [];
  const rays = Array.from({ length: 7 }, () => ({ x: rand(), w: 0.03 + rand() * 0.07, s: 0.2 + rand() * 0.5, p: rand() * 6 }));
  const motes = Array.from({ length: 80 }, () => ({ x: rand(), y: rand(), z: 0.3 + rand() * 0.7 }));
  let emit = 0;
  return {
    draw(g, w, h, f) {
      const surface = h * (0.14 - 0.3 * f.sp); // he sinks; the surface moves up out of the picture
      const water = g.createLinearGradient(0, surface, 0, h);
      water.addColorStop(0, "#0b3440");
      water.addColorStop(1, "#000304");
      g.fillStyle = "#070a0e";
      g.fillRect(0, 0, w, h);
      g.fillStyle = water;
      g.fillRect(0, Math.max(0, surface), w, h);
      if (surface > 0) {
        g.strokeStyle = "rgba(160,210,230,0.35)";
        g.beginPath();
        for (let x = 0; x <= w; x += 8) g.lineTo(x, surface + 2 * Math.sin(x * 0.03 + f.t * 1.3));
        g.stroke();
      }
      g.save();
      g.globalCompositeOperation = "lighter";
      for (const r of rays) {
        const x = (r.x + 0.04 * Math.sin(f.t * r.s + r.p)) * w;
        const top = Math.max(0, surface);
        const gr = g.createLinearGradient(0, top, 0, h);
        gr.addColorStop(0, `rgba(120,190,210,${0.1 * (1 - 0.6 * f.sp)})`);
        gr.addColorStop(1, "rgba(120,190,210,0)");
        g.fillStyle = gr;
        g.beginPath();
        g.moveTo(x - r.w * w * 0.3, top);
        g.lineTo(x + r.w * w * 0.3, top);
        g.lineTo(x + r.w * w * 2, h);
        g.lineTo(x - r.w * w, h);
        g.fill();
      }
      g.restore();
      for (const m of motes) {
        m.y = (m.y - f.dt * 0.01 * m.z + 1) % 1;
        g.fillStyle = `rgba(170,210,220,${0.18 * m.z})`;
        g.fillRect(m.x * w + 6 * Math.sin(f.t * 0.3 + m.y * 9), m.y * h, 1.6 * m.z, 1.6 * m.z);
      }
      const fs = h * 0.42;
      const fx = w * (0.46 + 0.04 * Math.sin(f.t * 0.21));
      const fy = h * (0.58 + 0.12 * f.sp) + fs * 0.5;
      emit += f.dt * (2 + 45 * f.sing + 20 * f.loud);
      while (emit >= 1 && f.playing) {
        emit -= 1;
        const a = rand() * TAU, sp = 8 + 45 * rand() * (0.4 + f.sing);
        ink.push({ x: fx + Math.cos(a) * fs * 0.06, y: fy - fs * 0.6 + Math.sin(a) * fs * 0.1, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 6, r: 4 + rand() * 8, life: 3 + rand() * 4, age: 0 });
      }
      if (ink.length > 450) ink.splice(0, ink.length - 450);
      for (let i = ink.length - 1; i >= 0; i--) {
        const k = ink[i];
        k.age += f.dt;
        if (k.age > k.life) {
          ink.splice(i, 1);
          continue;
        }
        k.vx *= Math.exp(-f.dt);
        k.vy = k.vy * Math.exp(-f.dt) - f.dt * 3;
        k.x += k.vx * f.dt;
        k.y += k.vy * f.dt;
        k.r += f.dt * 9;
        const gr = g.createRadialGradient(k.x, k.y, 0, k.x, k.y, k.r);
        gr.addColorStop(0, `rgba(170,8,18,${0.22 * Math.sin((k.age / k.life) * Math.PI)})`);
        gr.addColorStop(1, "rgba(90,0,8,0)");
        g.fillStyle = gr;
        g.fillRect(k.x - k.r, k.y - k.r, k.r * 2, k.r * 2);
      }
      if (f.kick) rings.push({ x: fx, y: fy - fs * 0.5, r: fs * 0.1, v: fs * 1.4, a: 0.3 * f.kick });
      g.lineWidth = 1.5;
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i];
        r.r += r.v * f.dt;
        r.a -= f.dt * 0.45;
        if (r.a <= 0) {
          rings.splice(i, 1);
          continue;
        }
        g.strokeStyle = `rgba(238,246,248,${r.a})`;
        g.beginPath();
        g.ellipse(r.x, r.y, r.r, r.r * 0.8, 0, 0, TAU);
        g.stroke();
      }
      g.save();
      g.translate(fx, fy - fs * 0.5);
      g.rotate(0.2 * Math.sin(f.t * 0.13) + 0.15);
      man(g, 0, fs * 0.5, fs, "sink", 0, "#010305", "rgba(79,182,242,0.35)");
      g.restore();
    },
  };
};

/** the build: a rifled barrel turning, a figure walking at its end, red running down */
const barrel: SceneMaker = (rand) => {
  const drips = Array.from({ length: 28 }, () => ({ x: rand(), d: 0.4 + rand() * 0.8, w: 0.01 + rand() * 0.03 }));
  let flash = 0;
  return {
    draw(g, w, h, f) {
      const cx = w / 2, cy = h / 2, R = Math.hypot(w, h) * 0.6;
      g.fillStyle = "#e9e6df";
      g.fillRect(0, 0, w, h);
      // the bore: rings coming at the eye, and the rifling turning along them
      const spin = f.t * 0.35 + f.sp * 2;
      for (let k = 14; k >= 1; k--) {
        const z = k - ((f.t * 1.2) % 1);
        const r = R / (z * 0.55 + 0.4);
        const shade = Math.round(220 - 200 * clamp(r / R));
        g.fillStyle = `rgb(${shade},${shade - 4},${shade - 10})`;
        g.beginPath();
        g.arc(cx, cy, r, 0, TAU);
        g.fill();
      }
      g.save();
      g.beginPath();
      g.arc(cx, cy, R, 0, TAU);
      g.clip();
      g.strokeStyle = "rgba(0,0,0,0.55)";
      for (let k = 0; k < 8; k++) {
        g.lineWidth = R * 0.02;
        g.beginPath();
        for (let u = 0; u <= 1.001; u += 0.02) {
          const r = R * 0.04 + R * u * u;
          const a = spin + (k / 8) * TAU + u * 2.6;
          g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        }
        g.stroke();
      }
      g.restore();
      // the end of the barrel: a bright disc, and a man walking in it
      const er = Math.min(w, h) * 0.16;
      g.fillStyle = "#faf8f2";
      g.beginPath();
      g.arc(cx, cy, er, 0, TAU);
      g.fill();
      man(g, cx + er * 0.3 * Math.sin(f.lt * 0.15), cy + er * 0.6, er * 1.05, "walk", f.t * 5, "#0a0a0c");
      // the barrel's edge, dark
      const vg = g.createRadialGradient(cx, cy, Math.min(w, h) * 0.35, cx, cy, R);
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(0,0,0,0.95)");
      g.fillStyle = vg;
      g.fillRect(0, 0, w, h);
      if (f.kick) flash = Math.max(flash, 0.25 * f.kick);
      flash *= Math.exp(-f.dt * 8);
      if (flash > 0.01) {
        g.fillStyle = `rgba(255,250,235,${flash})`;
        g.fillRect(0, 0, w, h);
      }
      // red running down from the top, in the second half
      const fill = ease(clamp((f.sp - 0.45) / 0.55));
      if (fill > 0) {
        g.fillStyle = "rgba(128,4,10,0.92)";
        g.beginPath();
        g.moveTo(0, 0);
        for (const d of drips) {
          const y = h * fill * d.d * (1 + 0.06 * Math.sin(f.t * 0.7 + d.x * 20));
          g.lineTo((d.x - d.w) * w, h * fill * 0.25);
          g.quadraticCurveTo(d.x * w - d.w * w * 0.5, y, d.x * w, y + d.w * w);
          g.quadraticCurveTo(d.x * w + d.w * w * 0.5, y, (d.x + d.w) * w, h * fill * 0.25);
        }
        g.lineTo(w, 0);
        g.closePath();
        g.fill();
      }
    },
  };
};

/** chorus: the night sky cracks and falls in pieces over the hills; a man stands on the ridge */
const skyFalls: SceneMaker = (rand) => {
  interface Tri {
    p: [number, number][];
    cx: number;
    cy: number;
    down: boolean;
    x: number;
    y: number;
    vx: number;
    vy: number;
    rot: number;
    vr: number;
    age: number;
  }
  const cols = 13, rows = 7;
  const pt: [number, number][][] = [];
  for (let j = 0; j <= rows; j++) {
    pt.push([]);
    for (let i = 0; i <= cols; i++) {
      const edge = i === 0 || j === 0 || i === cols || j === rows;
      pt[j].push([(i + (edge ? 0 : (rand() - 0.5) * 0.7)) / cols, ((j + (edge ? 0 : (rand() - 0.5) * 0.7)) / rows) * 0.72]);
    }
  }
  const tris: Tri[] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const a = pt[j][i], b = pt[j][i + 1], c = pt[j + 1][i], d = pt[j + 1][i + 1];
      for (const p of rand() < 0.5 ? [[a, b, d], [a, d, c]] : [[a, b, c], [b, d, c]]) {
        const cx = (p[0][0] + p[1][0] + p[2][0]) / 3, cy = (p[0][1] + p[1][1] + p[2][1]) / 3;
        tris.push({ p: p as [number, number][], cx, cy, down: false, x: 0, y: 0, vx: 0, vy: 0, rot: 0, vr: 0, age: 0 });
      }
    }
  const stars = Array.from({ length: 90 }, () => ({ x: rand(), y: rand() * 0.7, b: rand() }));
  let fallen = 0;
  const drop = (count: number) => {
    // the cracks run outward from the middle of the sky
    const left = tris.filter((t) => !t.down);
    left.sort((a, b) => Math.hypot(a.cx - 0.5, a.cy - 0.25) - Math.hypot(b.cx - 0.5, b.cy - 0.25) + (rand() - 0.5) * 0.3);
    for (const t of left.slice(0, count)) {
      t.down = true;
      t.vx = (t.cx - 0.5) * 0.15 + (rand() - 0.5) * 0.05;
      t.vy = -0.02 * rand();
      t.vr = (rand() - 0.5) * 3;
      fallen++;
    }
  };
  return {
    draw(g, w, h, f) {
      // behind the sky: a red dark
      const back = g.createRadialGradient(w / 2, h * 0.3, 0, w / 2, h * 0.3, w * 0.7);
      back.addColorStop(0, `rgb(${110 + 80 * f.loud},10,14)`);
      back.addColorStop(1, "#090102");
      g.fillStyle = back;
      g.fillRect(0, 0, w, h);
      const skyCol = (y: number) => `rgb(${Math.round(8 + 14 * y)},${Math.round(16 + 30 * y)},${Math.round(36 + 46 * y)})`;
      if (f.word && /sky|fall|crumbl/.test(f.word)) drop(f.word.includes("fall") ? 10 : 5);
      // the sky goes on falling through the chorus, faster as it builds
      if (f.playing && fallen < tris.length * f.sp * 0.9) drop(1);
      for (const t of tris) {
        g.save();
        if (t.down) {
          t.age += f.dt;
          t.vy += f.dt * 0.35;
          t.x += t.vx * f.dt;
          t.y += t.vy * f.dt;
          t.rot += t.vr * f.dt;
          g.translate((t.cx + t.x) * w, (t.cy + t.y) * h);
          g.rotate(t.rot);
          g.translate(-t.cx * w, -t.cy * h);
        }
        if (t.y < 1.2) {
          g.beginPath();
          for (const [x, y] of t.p) g.lineTo(x * w, y * h);
          g.closePath();
          g.fillStyle = skyCol(t.cy);
          g.fill();
          g.strokeStyle = t.down ? "rgba(220,230,255,0.5)" : "rgba(200,215,255,0.06)";
          g.lineWidth = 1;
          g.stroke();
          if (!t.down) {
            g.clip();
            for (const s of stars)
              if (Math.abs(s.x - t.cx) < 0.06 && Math.abs(s.y - t.cy) < 0.07) {
                g.fillStyle = `rgba(230,236,255,${0.4 + 0.5 * s.b * (0.7 + 0.3 * Math.sin(f.t * 2 + s.b * 20))})`;
                g.fillRect(s.x * w, s.y * h, 1.6, 1.6);
              }
          }
        }
        g.restore();
      }
      // the moon, red, low over the hills
      g.fillStyle = `rgba(${200 + 50 * f.loud},40,30,0.95)`;
      g.beginPath();
      g.arc(w * 0.7, h * 0.52, Math.min(w, h) * 0.09, 0, TAU);
      g.fill();
      ridge(g, w, h, h * 0.74, h * 0.07, 2.2, "#14080a");
      ridge(g, w, h, h * 0.84, h * 0.05, 5.7, "#060203");
      // he stands on the near ridge, taller as they stand tall
      man(g, w * 0.3, h * 0.83, h * (0.2 + 0.05 * f.sp), "stand", 0, "#000", `rgba(255,80,60,${0.3 + 0.4 * f.loud})`);
    },
  };
};

/** verse 2: the highlands at night: a stag on the hill, the lodge's lit windows, mist, lightning */
const highlands: SceneMaker = (rand) => {
  const puff = puffSprite();
  const mist = Array.from({ length: 26 }, () => ({ x: rand(), y: 0.6 + rand() * 0.35, s: 0.2 + rand() * 0.3, v: 0.004 + rand() * 0.01 }));
  const rain = Array.from({ length: 160 }, () => ({ x: rand(), y: rand(), v: 0.8 + rand() * 0.6 }));
  let light = 0;
  let boltX = 0.5;
  let boltSeed = 1;
  return {
    draw(g, w, h, f) {
      if (f.crash || (f.kick && rand() < 0.15)) {
        light = 1;
        boltX = 0.15 + rand() * 0.7;
        boltSeed = Math.floor(rand() * 1e6);
      }
      light *= Math.exp(-f.dt * 5);
      const sky = g.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, `rgb(${10 + 120 * light},${16 + 125 * light},${28 + 140 * light})`);
      sky.addColorStop(1, `rgb(${34 + 50 * light},${40 + 50 * light},${52 + 50 * light})`);
      g.fillStyle = sky;
      g.fillRect(0, 0, w, h);
      if (light > 0.3) bolt(g, rng(boltSeed), boltX * w, h * 0.55, light);
      ridge(g, w, h, h * 0.6, h * 0.12, 1.3, `rgb(${18 + 30 * light},${22 + 30 * light},${28 + 30 * light})`);
      ridge(g, w, h, h * 0.76, h * 0.06, 4.1, "#07090b");
      const flip = f.shot % 2 ? -1 : 1;
      const lx = flip > 0 ? w * 0.72 : w * 0.28;
      lodge(g, lx, h * 0.78, Math.min(w * 0.36, h * 0.6), "#030405", 0.85, f.t);
      stag(g, flip > 0 ? w * 0.22 : w * 0.78, h * 0.7, h * 0.2, flip, "#020304", f.t);
      g.save();
      for (const m of mist) {
        const x = ((m.x + f.t * m.v) % 1.3) - 0.15;
        const s = m.s * w;
        g.globalAlpha = 0.09 + 0.05 * f.loud;
        g.drawImage(puff, x * w - s / 2, m.y * h - s * 0.2, s, s * 0.4);
      }
      g.restore();
      g.strokeStyle = "rgba(180,200,220,0.25)";
      g.lineWidth = 1;
      g.beginPath();
      for (const r of rain) {
        r.y = (r.y + f.dt * r.v) % 1;
        const x = r.x * w - r.y * 40, y = r.y * h;
        g.moveTo(x, y);
        g.lineTo(x - 4, y + 14);
      }
      g.stroke();
    },
  };
};

/** chorus 2: a kaleidoscope of red ink and shadow figures, turning */
const mirrors: SceneMaker = (rand) => {
  const S = 360;
  const wedge = document.createElement("canvas");
  wedge.width = wedge.height = S;
  const wg = wedge.getContext("2d")!;
  const blobs: { x: number; y: number; r: number; a: number; dark: boolean }[] = [];
  const N = 10;
  return {
    draw(g, w, h, f) {
      // the content of one wedge: ink and figures drifting out from the middle
      wg.fillStyle = "rgba(8,0,2,0.12)";
      wg.fillRect(0, 0, S, S);
      if (f.playing && rand() < 0.3 + f.sing) blobs.push({ x: rand() * 0.3, y: rand() * 0.15, r: 6 + rand() * 18, a: 0.5, dark: rand() < 0.3 });
      if (f.kick) blobs.push({ x: 0.05, y: 0.05, r: 30, a: 0.8, dark: false });
      for (let i = blobs.length - 1; i >= 0; i--) {
        const b = blobs[i];
        b.x += f.dt * (0.05 + 0.1 * f.loud);
        b.y += f.dt * 0.03;
        b.r += f.dt * 8;
        b.a -= f.dt * 0.12;
        if (b.a <= 0 || b.x > 1.1) {
          blobs.splice(i, 1);
          continue;
        }
        wg.fillStyle = b.dark ? `rgba(0,0,0,${b.a})` : `rgba(${150 + 80 * f.loud},6,16,${b.a})`;
        wg.beginPath();
        wg.arc(b.x * S, b.y * S, b.r, 0, TAU);
        wg.fill();
      }
      // a figure floats out along the wedge
      const u = (f.lt * 0.07) % 1;
      wg.save();
      wg.translate(S * (0.15 + 0.7 * u), S * 0.12);
      wg.rotate(Math.PI / 2);
      man(wg, 0, 0, S * 0.22, "sink", 0, "rgba(0,0,0,0.6)");
      wg.restore();

      g.fillStyle = "#060001";
      g.fillRect(0, 0, w, h);
      const R = Math.hypot(w, h) * 0.55;
      const turn = f.t * 0.08 + f.sp * 0.6;
      for (let k = 0; k < N; k++) {
        g.save();
        g.translate(w / 2, h / 2);
        g.rotate(turn + (k * TAU) / N);
        if (k % 2) g.scale(1, -1);
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(R, 0);
        g.lineTo(R * Math.cos(TAU / N), R * Math.sin(TAU / N));
        g.closePath();
        g.clip();
        g.drawImage(wedge, 0, 0, R, R);
        g.restore();
      }
      const c = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.min(w, h) * 0.2);
      c.addColorStop(0, `rgba(255,235,220,${0.25 + 0.5 * f.sing})`);
      c.addColorStop(1, "rgba(255,235,220,0)");
      g.fillStyle = c;
      g.fillRect(0, 0, w, h);
    },
  };
};

/** the break: targets in a dark range, shot through on the drums */
const targets: SceneMaker = (rand) => {
  const holes: { tg: number; x: number; y: number; a: number }[] = [];
  const sparks: { x: number; y: number; vx: number; vy: number; a: number }[] = [];
  return {
    draw(g, w, h, f) {
      g.fillStyle = "#07080a";
      g.fillRect(0, 0, w, h);
      const lane = g.createLinearGradient(0, h * 0.45, 0, h);
      lane.addColorStop(0, "#0e1013");
      lane.addColorStop(1, "#1c1e22");
      g.fillStyle = lane;
      g.fillRect(0, h * 0.62, w, h * 0.38);
      const n = 3;
      for (let k = 0; k < n; k++) {
        const depth = 1 - k * 0.22;
        const tx = w * (0.25 + 0.25 * k) + w * 0.02 * Math.sin(f.t * 0.6 + k);
        const tw = h * 0.3 * depth, th = h * 0.5 * depth;
        const ty = h * 0.62 - th - h * 0.03 * k;
        const sway = 0.04 * Math.sin(f.t * 1.1 + k * 2);
        g.save();
        g.translate(tx, ty);
        g.rotate(sway);
        // the lamp over each target
        const lg = g.createRadialGradient(0, th * 0.4, 0, 0, th * 0.4, th);
        lg.addColorStop(0, `rgba(255,240,200,${0.18 + 0.2 * f.loud})`);
        lg.addColorStop(1, "rgba(255,240,200,0)");
        g.fillStyle = lg;
        g.fillRect(-th, -th * 0.4, th * 2, th * 2);
        g.fillStyle = "#cfc6b0";
        g.fillRect(-tw / 2, 0, tw, th);
        // a person's outline, and the rings on it
        g.fillStyle = "#16171a";
        g.beginPath();
        g.arc(0, th * 0.2, tw * 0.13, 0, TAU);
        g.moveTo(-tw * 0.36, th);
        g.quadraticCurveTo(-tw * 0.34, th * 0.38, 0, th * 0.34);
        g.quadraticCurveTo(tw * 0.34, th * 0.38, tw * 0.36, th);
        g.fill();
        g.strokeStyle = "rgba(220,210,190,0.6)";
        g.lineWidth = 1;
        for (const r of [0.08, 0.16, 0.24]) {
          g.beginPath();
          g.ellipse(0, th * 0.6, tw * r, tw * r * 1.2, 0, 0, TAU);
          g.stroke();
        }
        for (const hl of holes)
          if (hl.tg === k) {
            g.fillStyle = "#000";
            g.beginPath();
            g.arc(hl.x * tw, hl.y * th, Math.max(1.5, tw * 0.018), 0, TAU);
            g.fill();
            if (hl.a > 0) {
              g.fillStyle = `rgba(255,200,120,${hl.a})`;
              g.beginPath();
              g.arc(hl.x * tw, hl.y * th, tw * 0.05 * hl.a, 0, TAU);
              g.fill();
            }
          }
        g.restore();
        const shoot = (f.kick ? 1 : 0) + (f.snare ? 1 : 0);
        for (let s = 0; s < shoot; s++)
          if (rand() < 0.45) {
            const hx = (rand() - 0.5) * 0.5, hy = 0.3 + rand() * 0.6;
            holes.push({ tg: k, x: hx, y: hy, a: 1 });
            for (let q = 0; q < 6; q++) sparks.push({ x: tx + hx * tw, y: ty + hy * th, vx: (rand() - 0.5) * 120, vy: -rand() * 100, a: 1 });
          }
      }
      for (const hl of holes) hl.a = Math.max(0, hl.a - f.dt * 3);
      if (holes.length > 240) holes.splice(0, holes.length - 240);
      g.save();
      g.globalCompositeOperation = "lighter";
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.a -= f.dt * 2.5;
        if (s.a <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        s.vy += f.dt * 300;
        s.x += s.vx * f.dt;
        s.y += s.vy * f.dt;
        g.fillStyle = `rgba(255,190,90,${s.a})`;
        g.fillRect(s.x, s.y, 2, 2);
      }
      g.restore();
    },
  };
};

/** the bridge: two figures in the rain under one lamp, closing the distance */
const embrace: SceneMaker = (rand) => {
  const rain = Array.from({ length: 220 }, () => ({ x: rand(), y: rand(), v: 0.9 + rand() * 0.7 }));
  const splash: { x: number; a: number }[] = [];
  return {
    draw(g, w, h, f) {
      g.fillStyle = "#040507";
      g.fillRect(0, 0, w, h);
      const lx = w * 0.5, ly = h * 0.12, ground = h * 0.85;
      const glow = 0.55 + 0.35 * f.sing + 0.05 * Math.sin(f.t * 9);
      // the cone of light from the lamp
      const cone = g.createLinearGradient(0, ly, 0, ground);
      cone.addColorStop(0, `rgba(255,190,110,${0.35 * glow})`);
      cone.addColorStop(1, `rgba(255,170,90,${0.12 * glow})`);
      g.fillStyle = cone;
      g.beginPath();
      g.moveTo(lx - w * 0.02, ly);
      g.lineTo(lx + w * 0.02, ly);
      g.lineTo(lx + w * 0.28, ground);
      g.lineTo(lx - w * 0.28, ground);
      g.closePath();
      g.fill();
      const pool = g.createRadialGradient(lx, ground, 0, lx, ground, w * 0.32);
      pool.addColorStop(0, `rgba(255,180,100,${0.4 * glow})`);
      pool.addColorStop(1, "rgba(255,180,100,0)");
      g.fillStyle = pool;
      g.save();
      g.scale(1, 0.25);
      g.fillRect(0, (ground - w * 0.32) * 4, w, w * 0.64 * 4);
      g.restore();
      g.fillStyle = "#0b0b0d";
      g.fillRect(0, ground, w, h - ground);
      g.fillStyle = "#020203";
      g.fillRect(lx - 3, ly, 6, ground - ly);
      g.fillRect(lx - 14, ly - 6, 28, 8);
      g.fillStyle = `rgba(255,220,160,${glow})`;
      g.fillRect(lx - 10, ly + 2, 20, 4);
      // they come together through the bridge, and their hands meet at its end
      const gap = (1 - ease(clamp(f.sp * 1.1))) * w * 0.3 + w * 0.035;
      const s = h * 0.5;
      man(g, lx - gap, ground, s, f.sp < 0.85 && f.playing ? "walk" : "stand", f.t * 3, "#000");
      woman(g, lx + gap, ground, s * 0.94, -1, ease(clamp((f.sp - 0.6) / 0.35)), "#000");
      g.strokeStyle = "rgba(255,210,170,0.35)";
      g.lineWidth = 1;
      g.beginPath();
      for (const r of rain) {
        r.y += f.dt * r.v;
        if (r.y > 1) {
          r.y -= 1;
          if (Math.abs(r.x - 0.5) < 0.3) splash.push({ x: r.x, a: 1 });
        }
        const x = r.x * w + r.y * 20, y = r.y * ground;
        const inLight = Math.abs(x - lx) < (y / ground) * w * 0.28 + w * 0.02;
        if (inLight) {
          g.moveTo(x, y);
          g.lineTo(x + 2, y + 12);
        }
      }
      g.stroke();
      for (let i = splash.length - 1; i >= 0; i--) {
        const sp = splash[i];
        sp.a -= f.dt * 4;
        if (sp.a <= 0) {
          splash.splice(i, 1);
          continue;
        }
        g.strokeStyle = `rgba(255,200,150,${0.4 * sp.a})`;
        g.beginPath();
        g.ellipse(sp.x * w + 20, ground + 3, 6 * (1.5 - sp.a), 1.5, 0, 0, TAU);
        g.stroke();
      }
    },
  };
};

/** the last chorus: the lodge burning, and a man walking out of the fire */
const fire: SceneMaker = (rand) => {
  const puff = puffSprite();
  const tongues = Array.from({ length: 60 }, () => ({ x: rand() - 0.5, h: 0.3 + rand() * 0.7, ph: rand() * TAU, sp: 2 + rand() * 4 }));
  const embers: { x: number; y: number; vx: number; vy: number; age: number; life: number }[] = [];
  let flare = 0;
  return {
    draw(g, w, h, f) {
      if (f.kick) flare = Math.min(1, flare + 0.35 * f.kick);
      flare *= Math.exp(-f.dt * 3);
      const heat = 0.5 + 0.3 * f.loud + 0.3 * flare;
      const sky = g.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, "#090303");
      sky.addColorStop(1, `rgb(${Math.round(120 * heat)},${Math.round(36 * heat)},10)`);
      g.fillStyle = sky;
      g.fillRect(0, 0, w, h);
      g.save();
      for (let k = 0; k < 14; k++) {
        const y = ((k / 14 - f.t * 0.03) % 1 + 1) % 1;
        const s = w * (0.25 + 0.2 * (1 - y));
        g.globalAlpha = 0.12 * (1 - y);
        g.filter = "brightness(0.25)";
        g.drawImage(puff, w * 0.55 + Math.sin(k * 1.7 + f.t * 0.2) * w * 0.1 - s / 2, y * h * 0.6 - s / 2, s, s);
      }
      g.restore();
      const base = h * 0.72, lw = Math.min(w * 0.5, h * 0.85), lx = w * 0.55;
      ridge(g, w, h, base + h * 0.02, h * 0.03, 3.3, "#050202");
      // the flames behind and through the house
      g.save();
      g.globalCompositeOperation = "lighter";
      for (const tg of tongues) {
        const x = lx + tg.x * lw;
        const fh = lw * 0.55 * tg.h * heat * (0.75 + 0.25 * Math.sin(f.t * tg.sp + tg.ph));
        const sway = lw * 0.04 * Math.sin(f.t * tg.sp * 0.7 + tg.ph);
        const gr = g.createLinearGradient(0, base, 0, base - fh);
        gr.addColorStop(0, "rgba(255,190,60,0.35)");
        gr.addColorStop(0.5, "rgba(255,90,20,0.22)");
        gr.addColorStop(1, "rgba(160,20,0,0)");
        g.fillStyle = gr;
        g.beginPath();
        g.moveTo(x - lw * 0.04, base);
        g.quadraticCurveTo(x - lw * 0.03 + sway, base - fh * 0.6, x + sway * 1.5, base - fh);
        g.quadraticCurveTo(x + lw * 0.03 + sway, base - fh * 0.6, x + lw * 0.04, base);
        g.fill();
      }
      g.restore();
      lodge(g, lx, base, lw, "#020101", 0.9 + flare, f.t * 3);
      // embers
      if (f.playing) for (let k = 0; k < f.dt * (40 + 120 * heat); k++) embers.push({ x: lx + (rand() - 0.5) * lw, y: base - rand() * lw * 0.3, vx: (rand() - 0.5) * 30, vy: -(30 + rand() * 90), age: 0, life: 2 + rand() * 3 });
      if (embers.length > 500) embers.splice(0, embers.length - 500);
      g.save();
      g.globalCompositeOperation = "lighter";
      for (let i = embers.length - 1; i >= 0; i--) {
        const e = embers[i];
        e.age += f.dt;
        if (e.age > e.life) {
          embers.splice(i, 1);
          continue;
        }
        e.x += (e.vx + 15 * Math.sin(e.age * 3 + i)) * f.dt;
        e.y += e.vy * f.dt;
        const a = 1 - e.age / e.life;
        g.fillStyle = `rgba(255,${Math.round(110 + 90 * a)},40,${0.85 * a})`;
        g.fillRect(e.x, e.y, 2, 2);
      }
      g.restore();
      g.fillStyle = "#050202";
      g.fillRect(0, base + h * 0.02, w, h);
      // he walks toward us, growing out of the fire's light
      const come = ease(clamp(f.sp));
      man(g, w * (0.42 - 0.08 * come), h * (0.78 + 0.2 * come), h * (0.12 + 0.55 * come), "walk", f.t * 3.2, "#000", `rgba(255,120,40,${0.5 * heat})`);
    },
  };
};

/** the outro: embers settling, the title, and an iris closing to black at the song's end */
const endCard: SceneMaker = (rand, host) => {
  const embers = Array.from({ length: 120 }, () => ({ x: rand(), y: rand(), v: 0.01 + rand() * 0.04, b: rand() }));
  const title = (host.song.title || "Skyfall").toUpperCase();
  return {
    draw(g, w, h, f) {
      g.fillStyle = "#050303";
      g.fillRect(0, 0, w, h);
      g.save();
      g.globalCompositeOperation = "lighter";
      for (const e of embers) {
        e.y = (e.y - f.dt * e.v + 1) % 1;
        g.fillStyle = `rgba(255,120,40,${0.5 * e.b * (1 - f.sp * 0.6)})`;
        g.fillRect(e.x * w + 8 * Math.sin(f.t + e.b * 10), e.y * h, 2, 2);
      }
      g.restore();
      const a = ease(clamp(f.lt / 4));
      const size = Math.min(w * 0.08, h * 0.18);
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = `rgba(236,232,224,${a})`;
      g.font = `300 ${size}px Georgia, "Times New Roman", serif`;
      g.fillText([...title].join("\u2009"), w / 2, h / 2);
      g.fillStyle = `rgba(170,14,20,${a})`;
      g.fillRect(w * 0.3, h / 2 + size * 0.62, w * 0.4, Math.max(1.5, size * 0.03));
      g.textAlign = "start";
      g.textBaseline = "alphabetic";
      // the iris closes over the last seconds
      const left = (host.duration || 0) - f.t;
      const close = ease(clamp(1 - left / 7));
      if (close > 0) {
        const r = Math.hypot(w, h) * 0.6 * (1 - close) + 1;
        g.save();
        g.fillStyle = "#000";
        g.beginPath();
        g.rect(0, 0, w, h);
        g.arc(w / 2, h / 2, r, 0, TAU, true);
        g.fill("evenodd");
        g.strokeStyle = `rgba(150,10,16,${0.8 * close})`;
        g.lineWidth = 3;
        g.beginPath();
        g.arc(w / 2, h / 2, r, 0, TAU);
        g.stroke();
        g.restore();
      }
    },
  };
};

/** the scene for each section: by its kind, and which of its kind it is */
function sceneFor(s: Section): SceneMaker {
  switch (s.kind) {
    case "intro":
      return smokeTitle;
    case "verse":
      return [water, highlands, water][s.n % 3];
    case "pre":
      return barrel;
    case "chorus":
      if (s.of > 1 && s.n === s.of - 1) return fire;
      return [skyFalls, mirrors][s.n % 2];
    case "bridge":
      return embrace;
    case "break":
      return targets;
    case "outro":
      return endCard;
  }
}

// ---- the camera, the film, and the cuts ---------------------------------------------------

interface Cam {
  z0: number;
  z1: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
function camFor(section: number, shot: number): Cam {
  const r = rng(section * 977 + shot * 131 + 7);
  r();
  const z0 = 1 + r() * 0.12, z1 = 1 + r() * 0.22;
  const k = (z: number) => (z - 1) / 2;
  return { z0, z1, x0: (r() * 2 - 1) * k(z0), y0: (r() * 2 - 1) * k(z0), x1: (r() * 2 - 1) * k(z1), y1: (r() * 2 - 1) * k(z1) };
}

export const skyfallVideo: Visual = {
  id: "skyfall",
  name: "Skyfall: music video",
  match: (song) => /sky\s*fall/i.test(song.title),
  create(g, host) {
    let secs = sections(host.song, host.duration);
    let secsFor = host.song;
    const bufs = [document.createElement("canvas"), document.createElement("canvas")];
    const grain = document.createElement("canvas");
    grain.width = grain.height = 160;
    {
      const gg = grain.getContext("2d")!;
      const img = gg.createImageData(160, 160);
      const r = rng(7);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.floor(r() * 255);
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      gg.putImageData(img, 0, 0);
    }
    const grainRand = rng(99);
    let cur: { idx: number; scene: Scene; buf: number } | null = null;
    let prev: { idx: number; scene: Scene; buf: number; until: number } | null = null;
    let flash = 0;
    let loud = 0, sing = 0, onsetBase = 0;
    let lastT = -1;
    let lastKey = -1;
    let caption = { text: "", a: 0 };

    const start = (idx: number) => cur = { idx, scene: sceneFor(secs[idx])(rng(idx * 7919 + 13), host), buf: cur ? 1 - cur.buf : 0 };
    const sectionAt = (t: number) => {
      let i = 0;
      while (i + 1 < secs.length && secs[i + 1].t0 <= t) i++;
      return i;
    };
    const shotOf = (s: Section, t: number) => {
      // a cut every two lines; where nothing is sung, every eight seconds
      const sung = s.lines.filter((l) => l <= t).length;
      return s.lines.length ? Math.floor(Math.max(0, sung - 1) / 2) : Math.floor((t - s.t0) / 8);
    };
    const shotSpan = (s: Section, shot: number): [number, number] => {
      if (!s.lines.length) return [s.t0 + shot * 8, Math.min(s.t1, s.t0 + shot * 8 + 8)];
      const a = shot === 0 ? s.t0 : s.lines[shot * 2] ?? s.t0;
      const b = s.lines[shot * 2 + 2] ?? s.t1;
      return [a, b];
    };

    return {
      frame(dt, w, h) {
        if (host.song !== secsFor) {
          secsFor = host.song;
          secs = sections(host.song, host.duration);
          cur = prev = null;
        }
        const dpr = g.getTransform().a || 1;
        const t = host.time();
        const playing = host.playing();
        const seek = lastT >= 0 && (t < lastT - 0.05 || t - lastT > 1);
        lastT = t;

        // the letterbox: the picture at about 2.2:1, at least a strip top and bottom
        const ph = Math.min(h - Math.max(16, h * 0.08) * 2, w / 2.2);
        const bar = (h - ph) / 2;
        const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(ph * dpr));
        for (const b of bufs)
          if (b.width !== bw || b.height !== bh) {
            b.width = bw;
            b.height = bh;
          }

        // what the music does this frame
        const level = playing ? host.level() : 0;
        loud += (Math.min(1, level * 4.5) - loud) * Math.min(1, dt * 2);
        const v = host.voices()[0];
        sing += ((v ? Math.min(1, v.rms * 5) * v.voicing : 0) - sing) * Math.min(1, dt * 6);
        let kick = 0, snare = 0, crash = 0;
        const notes = playing ? host.hits() : [];
        for (const n of notes)
          if (n.ch === 9) {
            if (n.midi === 35 || n.midi === 36) kick = Math.max(kick, n.vel / 127);
            else if (n.midi === 38 || n.midi === 40) snare = Math.max(snare, n.vel / 127);
            else if (n.midi === 49 || n.midi === 57 || n.midi === 52 || n.midi === 55) crash = 1;
          }
        // without a backing, a jump in the mix stands in for the kick
        if (!host.backing && playing && level > onsetBase * 1.7 && level > 0.04) kick = 0.7;
        onsetBase += (level - onsetBase) * Math.min(1, dt * 3);
        let word = "";
        const sung = host.sung()[0];
        if (sung && sung.key !== lastKey) {
          lastKey = sung.key;
          word = sung.word.toLowerCase();
        }

        // the section, its scene, and the cross-fade from the one before
        const idx = sectionAt(t);
        if (!cur || seek) {
          prev = null;
          cur = null;
          start(idx);
        } else if (cur.idx !== idx) {
          prev = { ...cur, until: t + (secs[idx].kind === "chorus" ? 0.35 : 1.2) };
          start(idx);
          if (secs[idx].kind === "chorus") flash = 1;
        }
        if (prev && (t >= prev.until || !playing)) prev = null;
        const run = (c: { idx: number; scene: Scene; buf: number }) => {
          const s = secs[c.idx];
          const shot = shotOf(s, t);
          const bg = bufs[c.buf].getContext("2d")!;
          bg.setTransform(dpr, 0, 0, dpr, 0, 0);
          bg.globalAlpha = 1;
          bg.globalCompositeOperation = "source-over";
          bg.filter = "none";
          c.scene.draw(bg, w, ph, {
            t, dt: playing ? dt : 0, lt: t - s.t0, sp: clamp((t - s.t0) / Math.max(1, s.t1 - s.t0)), shot,
            loud, sing, playing, kick, snare, crash, notes, word, p: clamp(t / (host.duration || 240)),
          });
          return shot;
        };
        const now = cur!;
        const shot = run(now);
        if (prev) run(prev);

        // the picture through the camera: a slow push or pan across each shot
        g.fillStyle = "#000";
        g.fillRect(0, 0, w, h);
        const place = (c: { idx: number; buf: number }, shotN: number, alpha: number) => {
          const s = secs[c.idx];
          const [a, b] = shotSpan(s, shotN);
          const u = ease(clamp((t - a) / Math.max(1, b - a)));
          const cam = camFor(c.idx, shotN);
          const z = cam.z0 + (cam.z1 - cam.z0) * u;
          const cx = (cam.x0 + (cam.x1 - cam.x0) * u) * w, cy = (cam.y0 + (cam.y1 - cam.y0) * u) * ph;
          g.globalAlpha = alpha;
          g.drawImage(bufs[c.buf], w / 2 - (w * z) / 2 + cx, bar + ph / 2 - (ph * z) / 2 + cy, w * z, ph * z);
          g.globalAlpha = 1;
        };
        g.save();
        g.beginPath();
        g.rect(0, bar, w, ph);
        g.clip();
        if (prev) {
          place(prev, shotOf(secs[prev.idx], t), 1);
          const span = secs[now.idx].kind === "chorus" ? 0.35 : 1.2;
          place(now, shot, ease(clamp(1 - (prev.until - t) / span)));
        } else place(now, shot, 1);
        // a flash as a chorus comes in
        flash *= Math.exp(-dt * 6);
        if (flash > 0.01) {
          g.fillStyle = `rgba(255,248,240,${flash * 0.8})`;
          g.fillRect(0, bar, w, ph);
        }
        // the film: a vignette, a little flicker, and grain
        const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, ph) * 0.35, w / 2, h / 2, Math.hypot(w, ph) * 0.6);
        vg.addColorStop(0, "rgba(0,0,0,0)");
        vg.addColorStop(1, "rgba(0,0,0,0.6)");
        g.fillStyle = vg;
        g.fillRect(0, bar, w, ph);
        g.fillStyle = `rgba(0,0,0,${0.04 * grainRand()})`;
        g.fillRect(0, bar, w, ph);
        g.globalAlpha = 0.07;
        g.globalCompositeOperation = "overlay";
        const ox = -grainRand() * 160, oy = -grainRand() * 160;
        for (let y = bar + oy; y < bar + ph; y += 160) for (let x = ox; x < w; x += 160) g.drawImage(grain, x, y);
        g.restore();

        // the line being sung, as a caption under the picture
        const want = sung ? sung.line : "";
        if (want && want !== caption.text) caption = { text: want, a: 0 };
        caption.a = clamp(caption.a + (want ? dt * 3 : -dt * 1.5));
        if (caption.text && caption.a > 0) {
          const size = Math.round(Math.max(11, Math.min(bar * 0.5, ph * 0.07, w * 0.03)));
          const inBar = bar >= size * 1.6;
          g.font = `italic ${size}px Georgia, "Times New Roman", serif`;
          g.textAlign = "center";
          g.textBaseline = "middle";
          g.fillStyle = `rgba(236,232,224,${caption.a * (0.55 + 0.45 * sing)})`;
          if (!inBar) {
            g.shadowColor = "rgba(0,0,0,0.9)";
            g.shadowBlur = 6;
          }
          g.fillText(caption.text, w / 2, inBar ? bar + ph + bar / 2 : bar + ph - size, w * 0.92);
          g.shadowBlur = 0;
          g.textAlign = "start";
          g.textBaseline = "alphabetic";
        }
        // the section, small, in the top bar
        if (bar >= 16) {
          const s = secs[now.idx];
          const label = s.kind === "intro" || s.kind === "outro" ? "" : `${s.kind === "pre" ? "build" : s.kind}${s.of > 1 ? " " + (s.n + 1) : ""}`;
          g.font = `${Math.round(Math.min(11, bar * 0.4))}px Georgia, serif`;
          g.fillStyle = "rgba(170,14,20,0.8)";
          g.textBaseline = "middle";
          g.fillText(label.toUpperCase(), 10, bar / 2);
          g.textBaseline = "alphabetic";
        }
      },
    };
  },
};
