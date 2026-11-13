/**
 * Spectrum: the visual for any song. The mix's spectrum as a ring of bars around the voices'
 * pitch, a pulse on each kick, and the word being sung at the centre.
 */
import type { Visual } from "./types.ts";

export const spectrum: Visual = {
  id: "spectrum",
  name: "Spectrum",
  create(g, host) {
    let pulse = 0;
    let spin = 0;
    const smooth = new Float32Array(96);
    return {
      frame(dt, w, h) {
        g.fillStyle = "rgba(0,0,0,0.28)";
        g.fillRect(0, 0, w, h);
        for (const n of host.hits()) if (n.ch === 9 && (n.midi === 35 || n.midi === 36)) pulse = Math.max(pulse, n.vel / 127);
        pulse *= Math.exp(-dt * 6);
        spin += dt * 0.15;
        const cx = w / 2, cy = h / 2;
        const R = Math.min(w, h) * (0.24 + 0.03 * pulse);
        const sp = host.spectrum();
        // log-spaced bands from 60 Hz to 8 kHz
        const nyq = host.sampleRate / 2;
        for (let i = 0; i < smooth.length; i++) {
          const f = 60 * Math.pow(8000 / 60, i / smooth.length);
          const bin = Math.min(sp.length - 1, Math.round((f / nyq) * sp.length));
          const v = Math.max(0, (sp[bin] + 90) / 70);
          smooth[i] += (v - smooth[i]) * Math.min(1, dt * 12);
        }
        const voices = host.voices();
        const color = host.colors[0] ?? "#4fb6f2";
        g.lineWidth = 2;
        for (let i = 0; i < smooth.length; i++) {
          const a = spin + (i / smooth.length) * Math.PI * 2;
          const len = smooth[i] * Math.min(w, h) * 0.22;
          g.strokeStyle = i % 2 ? color : "#ffb340";
          g.globalAlpha = 0.35 + 0.65 * smooth[i];
          g.beginPath();
          g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
          g.lineTo(cx + Math.cos(a) * (R + len), cy + Math.sin(a) * (R + len));
          g.stroke();
        }
        g.globalAlpha = 1;
        // each voice: a ring at its pitch, bright while it sings
        voices.forEach((v, k) => {
          if (v.voicing < 0.3) return;
          const r = R * (0.35 + 0.55 * Math.min(1, Math.max(0, Math.log2(v.f0 / 80) / 3.5)));
          g.strokeStyle = host.colors[k] ?? color;
          g.globalAlpha = Math.min(1, v.rms * 4);
          g.beginPath();
          g.arc(cx, cy, r, 0, Math.PI * 2);
          g.stroke();
        });
        g.globalAlpha = 1;
        const s = host.sung()[0];
        if (s) {
          g.fillStyle = "#eef6f8";
          g.font = `${Math.round(Math.min(w, h) * 0.07)}px system-ui`;
          g.textAlign = "center";
          g.fillText(s.word, cx, cy + Math.min(w, h) * 0.025);
          g.textAlign = "start";
        }
      },
    };
  },
};
