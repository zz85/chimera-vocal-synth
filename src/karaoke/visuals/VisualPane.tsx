/**
 * The visual pane: picks the visual for the song (the one songs.json names, else the built-in
 * that matches it, else Spectrum), or the one chosen, and runs it on a canvas each frame with a
 * host that reads the performance from the player.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { KaraokePlayer } from "../player.ts";
import type { MidiFile, MidiNote } from "../midifile.ts";
import type { Song } from "../song.ts";
import type { Visual, VisualHost, SungNow } from "./types.ts";
import { skyfall } from "./skyfall.ts";
import { skyfallVideo } from "./skyfall-video.ts";
import { spectrum } from "./spectrum.ts";

export const BUILT_IN: Visual[] = [skyfallVideo, skyfall, spectrum];

/** a visual module of its own, from a URL: its default export (or its `visual`) */
export async function loadVisual(url: string): Promise<Visual> {
  const mod = (await import(/* @vite-ignore */ url)) as { default?: Visual; visual?: Visual };
  const v = mod.default ?? mod.visual;
  if (!v || typeof v.create !== "function") throw new Error(`${url}: its default export isn't a visual (an object with create())`);
  return v;
}

/** the visual to show for a choice: "auto", "off", a built-in's id, or a module's URL */
export function builtInFor(song: Song, choice: string): Visual | null {
  if (choice === "off") return null;
  const b = BUILT_IN.find((v) => v.id === choice);
  if (b) return b;
  return BUILT_IN.find((v) => v.match?.(song)) ?? spectrum;
}

/** what each note of a part reads as: its syllable, its word and its line */
function readings(song: Song) {
  return song.parts.map((p) => {
    // the first note of each note's word and of its line
    const wordOf: number[] = [];
    const lineOf: number[] = [];
    let w = 0, l = 0;
    p.notes.forEach((n, i) => {
      if (n.lineStart || i === 0) l = i;
      if (n.wordStart || i === 0) w = i;
      wordOf[i] = w;
      lineOf[i] = l;
    });
    const wordText = new Map<number, string>();
    const lineText = new Map<number, string>();
    p.notes.forEach((n, i) => {
      wordText.set(wordOf[i], (wordText.get(wordOf[i]) ?? "") + n.text);
      lineText.set(lineOf[i], (lineText.get(lineOf[i]) ?? "") + (n.wordStart && i !== lineOf[i] ? " " : "") + n.text);
    });
    return p.notes.map((n, i) => {
      // a held vowel reads as the syllable it holds
      let b = i;
      while (b > 0 && p.notes[b].cont) b--;
      return { t0: n.t0, t1: n.t1, syllable: p.notes[b].text, word: wordText.get(wordOf[i]) ?? "", line: lineText.get(lineOf[i]) ?? "" };
    });
  });
}

export function VisualPane(props: { player: KaraokePlayer; song: Song; backing: MidiFile | null; visual: Visual | null; colors: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const reads = useMemo(() => readings(props.song), [props.song]);
  const live = useRef({ backing: props.backing, reads, song: props.song });
  live.current = { backing: props.backing, reads, song: props.song };

  useEffect(() => {
    const v = props.visual;
    const c = ref.current;
    if (!v || !c) return;
    setFailed(null);
    const g = c.getContext("2d")!;
    const player = props.player;
    const spec = new Float32Array(player.meter.frequencyBinCount);
    const td = new Float32Array(player.meter.fftSize);
    let lastT = player.time();
    let hits: MidiNote[] = [];
    const host: VisualHost = {
      time: () => player.time(),
      playing: () => player.playing,
      get duration() {
        return player.duration;
      },
      get song() {
        return live.current.song;
      },
      get backing() {
        return live.current.backing;
      },
      sampleRate: player.ctx.sampleRate,
      level: () => {
        player.meter.getFloatTimeDomainData(td);
        let r = 0;
        for (const x of td) r += x * x;
        return Math.sqrt(r / td.length);
      },
      spectrum: () => {
        player.meter.getFloatFrequencyData(spec);
        return spec;
      },
      voices: () => player.voices.map((x) => (x.latest ? { f0: x.latest.t.f0, voicing: x.latest.t.voicing, rms: x.latest.t.outRms } : { f0: 0, voicing: 0, rms: 0 })),
      sung: () => {
        const t = player.time();
        const out: SungNow[] = [];
        live.current.reads.forEach((r, part) => {
          let lo = 0, hi = r.length - 1, k = -1;
          while (lo <= hi) {
            const m = (lo + hi) >> 1;
            if (r[m].t0 <= t) {
              k = m;
              lo = m + 1;
            } else hi = m - 1;
          }
          if (k >= 0 && t <= r[k].t1 + 0.1) out.push({ part, syllable: r[k].syllable, word: r[k].word, line: r[k].line, key: k });
        });
        return out;
      },
      hits: () => hits,
      colors: props.colors,
    };
    let inst: ReturnType<Visual["create"]> | null = null;
    try {
      inst = v.create(g, host);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      return;
    }
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
      // the backing's notes that started since the last frame; none across a seek or a pause
      const t = player.time();
      hits = [];
      const b = live.current.backing;
      if (b && player.playing && t >= lastT && t - lastT < 0.5) {
        const ns = b.notes;
        let lo = 0, hi = ns.length;
        while (lo < hi) {
          const m = (lo + hi) >> 1;
          if (ns[m].t0 <= lastT) lo = m + 1;
          else hi = m;
        }
        for (let i = lo; i < ns.length && ns[i].t0 <= t; i++) hits.push(ns[i]);
      }
      lastT = t;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      try {
        inst!.frame(dt, w, h);
      } catch (e) {
        cancelAnimationFrame(raf);
        setFailed(e instanceof Error ? e.message : String(e));
      }
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      try {
        inst?.dispose?.();
      } catch {
        // a visual's own clean-up failing doesn't stop the page
      }
    };
    // a new visual or player starts the visual again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visual, props.player]);

  return (
    <div className="k-visual">
      <canvas ref={ref} />
      {failed && <p className="duet-msg error">The visual stopped: {failed}</p>}
    </div>
  );
}
