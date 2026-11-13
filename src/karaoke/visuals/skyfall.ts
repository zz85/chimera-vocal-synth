/**
 * Skyfall: a visual for Adele's "Skyfall", after the mood of the film's title sequence, drawn
 * from scratch: a figure sinking slowly through dark water as the song goes on, red ink
 * blooming from him as the voice swells, rings spreading on each kick, the moon above the
 * surface turning red in the loud passages, shards of sky falling at each "sky" and "fall",
 * and, late in the song, embers rising as from a house on fire.
 */
import type { Visual } from "./types.ts";

interface Ink {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  age: number;
}
interface Ring {
  x: number;
  y: number;
  r: number;
  v: number;
  a: number;
  spiral: boolean;
}
interface Shard {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  s: number;
  age: number;
}
interface Ember {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
}

/** a small seeded random, so a seek replays the same water */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export const skyfall: Visual = {
  id: "skyfall-water",
  name: "Skyfall: under water",
  create(g, host) {
    const rand = rng(1962);
    const ink: Ink[] = [];
    const rings: Ring[] = [];
    const shards: Shard[] = [];
    const embers: Ember[] = [];
    let loud = 0;
    let lastKey = -1;
    let swim = 0;
    let emit = 0;
    // the rays of light from the surface, each its own sway
    const rays = Array.from({ length: 7 }, () => ({ x: rand(), w: 0.03 + rand() * 0.07, s: 0.2 + rand() * 0.5, p: rand() * 6 }));
    // motes drifting in the water
    const motes = Array.from({ length: 70 }, () => ({ x: rand(), y: rand(), z: 0.3 + rand() * 0.7 }));

    function figure(x: number, y: number, s: number, rot: number, t: number) {
      // a man in a suit, arms open, sinking: drawn as one dark shape with a faint rim of light
      g.save();
      g.translate(x, y);
      g.rotate(rot);
      g.scale(s, s);
      const arm = 0.25 * Math.sin(t * 0.7);
      g.beginPath();
      // head
      g.moveTo(0.11, -1.0);
      g.arc(0, -1.0, 0.11, 0, Math.PI * 2);
      // body: shoulders, jacket, legs
      g.moveTo(-0.22, -0.82);
      g.lineTo(0.22, -0.82);
      g.lineTo(0.17, -0.25);
      g.lineTo(0.13, 0.35);
      g.lineTo(0.06, 0.38);
      g.lineTo(0.0, -0.12);
      g.lineTo(-0.06, 0.38);
      g.lineTo(-0.13, 0.35);
      g.lineTo(-0.17, -0.25);
      g.closePath();
      // arms reaching up and out
      for (const side of [-1, 1]) {
        g.moveTo(side * 0.2, -0.8);
        g.lineTo(side * (0.62 + arm * 0.2), -1.12 - arm * side * 0.1);
        g.lineTo(side * (0.66 + arm * 0.2), -1.07 - arm * side * 0.1);
        g.lineTo(side * 0.22, -0.68);
        g.closePath();
      }
      g.fillStyle = "#010305";
      g.fill();
      g.strokeStyle = "rgba(79,182,242,0.35)";
      g.lineWidth = 1.2 / s;
      g.stroke();
      g.restore();
    }

    return {
      frame(dt, w, h) {
        const t = host.time();
        const dur = host.duration || 240;
        const p = Math.min(1, Math.max(0, t / dur));
        const level = host.playing() ? host.level() : 0;
        loud += (Math.min(1, level * 4.5) - loud) * Math.min(1, dt * 2);
        const voices = host.voices();
        const voice = voices[0];
        const sing = voice ? Math.min(1, voice.rms * 5) * voice.voicing : 0;
        const surface = h * 0.16;

        // the water: darker the deeper he sinks
        const deep = 0.25 + 0.75 * p;
        const sky = g.createLinearGradient(0, 0, 0, surface);
        sky.addColorStop(0, `rgb(${Math.round(8 + 40 * loud)},${Math.round(10 - 6 * loud)},${Math.round(18 - 10 * loud)})`);
        sky.addColorStop(1, "#0b1a22");
        g.fillStyle = sky;
        g.fillRect(0, 0, w, surface);
        const water = g.createLinearGradient(0, surface, 0, h);
        water.addColorStop(0, `rgb(${Math.round(10 - 6 * deep)},${Math.round(44 - 30 * deep)},${Math.round(56 - 36 * deep)})`);
        water.addColorStop(1, "#000203");
        g.fillStyle = water;
        g.fillRect(0, surface, w, h - surface);

        // the moon over the surface, eclipsed, red when the song is loud
        const mx = w * 0.72, my = surface * 0.55, mr = Math.min(w, h) * 0.07;
        g.fillStyle = `rgb(${Math.round(200 + 55 * loud)},${Math.round(210 - 170 * loud)},${Math.round(215 - 180 * loud)})`;
        g.beginPath();
        g.arc(mx, my, mr, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#06080b";
        g.beginPath();
        g.arc(mx - mr * (0.25 + 0.5 * p), my - mr * 0.1, mr * 0.95, 0, Math.PI * 2);
        g.fill();
        // the surface line, wavering
        g.strokeStyle = "rgba(160,210,230,0.35)";
        g.beginPath();
        for (let x = 0; x <= w; x += 8) {
          const y = surface + 2 * Math.sin(x * 0.03 + t * 1.3) + 1.5 * Math.sin(x * 0.011 - t * 0.7);
          if (x === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();

        // light falling through the water, fading with depth
        g.save();
        g.globalCompositeOperation = "lighter";
        for (const r of rays) {
          const x = (r.x + 0.04 * Math.sin(t * r.s + r.p)) * w;
          const grad = g.createLinearGradient(0, surface, 0, h * (0.8 - 0.4 * p));
          grad.addColorStop(0, `rgba(120,190,210,${0.09 * (1 - 0.7 * p)})`);
          grad.addColorStop(1, "rgba(120,190,210,0)");
          g.fillStyle = grad;
          g.beginPath();
          g.moveTo(x - r.w * w * 0.3, surface);
          g.lineTo(x + r.w * w * 0.3, surface);
          g.lineTo(x + r.w * w * 2, h);
          g.lineTo(x - r.w * w, h);
          g.closePath();
          g.fill();
        }
        g.restore();
        for (const m of motes) {
          m.y -= dt * 0.006 * m.z;
          if (m.y < 0) m.y += 1;
          g.fillStyle = `rgba(170,210,220,${0.15 * m.z})`;
          g.fillRect(m.x * w + 6 * Math.sin(t * 0.3 + m.y * 9), surface + m.y * (h - surface), 1.5 * m.z, 1.5 * m.z);
        }

        // the figure, sinking from near the surface to the depths over the song
        swim += dt;
        const fs = Math.min(w, h) * 0.17;
        const fx = w * 0.42 + w * 0.05 * Math.sin(swim * 0.21);
        const fy = surface + fs * 1.3 + (h - surface - fs * 1.9) * (0.08 + 0.85 * p);
        const rot = 0.25 * Math.sin(swim * 0.13) + (p - 0.5) * 0.5;

        // ink from him as she sings: more and faster the louder she is
        emit += dt * (2 + 40 * sing + 25 * loud);
        while (emit >= 1 && host.playing()) {
          emit -= 1;
          const a = rand() * Math.PI * 2;
          const sp = 8 + 40 * rand() * (0.4 + sing);
          ink.push({ x: fx + Math.cos(a) * fs * 0.15, y: fy - fs * 0.6 + Math.sin(a) * fs * 0.2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 6, r: 4 + rand() * 8, life: 3 + rand() * 4, age: 0 });
        }
        if (ink.length > 500) ink.splice(0, ink.length - 500);
        for (let i = ink.length - 1; i >= 0; i--) {
          const k = ink[i];
          k.age += dt;
          if (k.age > k.life) {
            ink.splice(i, 1);
            continue;
          }
          k.vx *= Math.exp(-dt * 0.9);
          k.vy = k.vy * Math.exp(-dt * 0.9) - dt * 3;
          k.x += k.vx * dt;
          k.y += k.vy * dt;
          k.r += dt * 9;
          const a = 0.22 * Math.sin((k.age / k.life) * Math.PI);
          const grad = g.createRadialGradient(k.x, k.y, 0, k.x, k.y, k.r);
          grad.addColorStop(0, `rgba(170,8,18,${a})`);
          grad.addColorStop(1, "rgba(90,0,8,0)");
          g.fillStyle = grad;
          g.beginPath();
          g.arc(k.x, k.y, k.r, 0, Math.PI * 2);
          g.fill();
        }

        // rings on the kicks, and a slow spiral on each "skyfall"
        for (const n of host.hits()) {
          if (n.ch === 9 && (n.midi === 35 || n.midi === 36)) rings.push({ x: fx, y: fy - fs * 0.4, r: fs * 0.2, v: fs * 2.2, a: 0.35 * (n.vel / 127), spiral: false });
          if (n.ch === 9 && (n.midi === 49 || n.midi === 57))
            for (let k = 0; k < 6; k++) shards.push({ x: rand() * w, y: surface - 4, vx: (rand() - 0.5) * 30, vy: 20 + rand() * 40, rot: rand() * 6, vr: (rand() - 0.5) * 3, s: 4 + rand() * 8, age: 0 });
        }
        const sung = host.sung()[0];
        if (sung && sung.key !== lastKey) {
          lastKey = sung.key;
          const word = sung.word.toLowerCase();
          if (/sky|fall/.test(word)) {
            // the sky breaks: shards fall through the surface
            for (let k = 0; k < (word.includes("skyfall") ? 40 : 18); k++) shards.push({ x: rand() * w, y: rand() * surface, vx: (rand() - 0.5) * 40, vy: 10 + rand() * 50, rot: rand() * 6, vr: (rand() - 0.5) * 4, s: 5 + rand() * 14, age: 0 });
            if (word.includes("fall") || word.includes("skyfall")) rings.push({ x: w / 2, y: h * 0.55, r: 10, v: Math.max(w, h) * 0.35, a: 0.5, spiral: true });
          }
        }
        g.lineWidth = 1.5;
        for (let i = rings.length - 1; i >= 0; i--) {
          const r = rings[i];
          r.r += r.v * dt;
          r.a -= dt * (r.spiral ? 0.12 : 0.45);
          if (r.a <= 0) {
            rings.splice(i, 1);
            continue;
          }
          g.strokeStyle = `rgba(238,246,248,${r.a})`;
          if (r.spiral) {
            // a spiral turning in on itself, like the inside of a barrel
            g.beginPath();
            for (let k = 0; k <= 220; k++) {
              const u = k / 220;
              const ang = u * Math.PI * 9 + t * 0.6;
              const rr = r.r * u;
              const x = r.x + Math.cos(ang) * rr, y = r.y + Math.sin(ang) * rr;
              if (k === 0) g.moveTo(x, y);
              else g.lineTo(x, y);
            }
            g.stroke();
          } else {
            g.beginPath();
            g.ellipse(r.x, r.y, r.r, r.r * 0.8, 0, 0, Math.PI * 2);
            g.stroke();
          }
        }

        figure(fx, fy, fs, rot, swim);

        // shards of sky, falling and slowing in the water
        for (let i = shards.length - 1; i >= 0; i--) {
          const s = shards[i];
          s.age += dt;
          const inWater = s.y > surface;
          s.vy += dt * (inWater ? 6 : 140);
          s.vy *= inWater ? Math.exp(-dt * 1.2) : 1;
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          s.rot += s.vr * dt;
          const a = Math.max(0, 1 - s.age / 6);
          if (a <= 0 || s.y > h + 20) {
            shards.splice(i, 1);
            continue;
          }
          g.save();
          g.translate(s.x, s.y);
          g.rotate(s.rot);
          g.fillStyle = `rgba(150,200,230,${0.55 * a})`;
          g.strokeStyle = `rgba(238,246,248,${0.8 * a})`;
          g.beginPath();
          g.moveTo(0, -s.s);
          g.lineTo(s.s * 0.6, s.s * 0.5);
          g.lineTo(-s.s * 0.4, s.s * 0.7);
          g.closePath();
          g.fill();
          g.stroke();
          g.restore();
        }

        // the last part of the song: embers rising, as from a burning house
        if (p > 0.72 && host.playing()) {
          const n = dt * (8 + 80 * loud) * Math.min(1, (p - 0.72) * 8);
          for (let k = 0; k < n; k++) embers.push({ x: rand() * w, y: h + 4, vx: (rand() - 0.5) * 20, vy: -(30 + rand() * 70), age: 0, life: 2 + rand() * 3 });
        }
        if (embers.length > 400) embers.splice(0, embers.length - 400);
        g.save();
        g.globalCompositeOperation = "lighter";
        for (let i = embers.length - 1; i >= 0; i--) {
          const e = embers[i];
          e.age += dt;
          if (e.age > e.life) {
            embers.splice(i, 1);
            continue;
          }
          e.x += (e.vx + 12 * Math.sin(e.age * 3 + i)) * dt;
          e.y += e.vy * dt;
          const a = 1 - e.age / e.life;
          g.fillStyle = `rgba(255,${Math.round(120 + 80 * a)},40,${0.8 * a})`;
          g.fillRect(e.x, e.y, 2, 2);
        }
        g.restore();

        // the line being sung, faint, under the water
        if (sung) {
          g.fillStyle = `rgba(238,246,248,${0.25 + 0.5 * sing})`;
          g.font = `italic ${Math.round(Math.min(w, h) * 0.045)}px Georgia, "Times New Roman", serif`;
          g.textAlign = "center";
          g.fillText(sung.line, w / 2, h - Math.min(w, h) * 0.06, w * 0.92);
          g.textAlign = "start";
        }
      },
    };
  },
};
