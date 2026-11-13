/**
 * Line a MIDI file up under an UltraStar song. The two don't share a clock: the UltraStar file
 * is timed to its recording (#GAP), the MIDI to its own bar 1, often at a slightly different
 * tempo and sometimes in another key. The mapping is
 *
 *   song time = ratio × MIDI time + offset,   MIDI pitch + transpose
 *
 * found by voting: every sung note and every note of a candidate MIDI track with the same pitch
 * class (after a transposition) votes for the offset that would put them together, at each
 * tempo ratio on a grid. The best peak is refined on a finer grid and scored by the share of
 * sung notes that land on a MIDI note of their pitch class. A live recording speeds up and slows
 * down where a MIDI file keeps strict time, so last a warp follows it: a small correction every
 * few seconds, from the median gap of the notes paired there. The track that scores best is the
 * MIDI's melody, which the backing mutes so it doesn't double the voice. Octaves are ignored on
 * purpose: UltraStar files often put a part an octave off.
 */
import { trackLabel, type MidiFile, type MidiNote } from "./midifile.ts";

export interface Alignment {
  ratio: number;
  offset: number;
  /** semitones added to the MIDI's pitched notes */
  transpose: number;
  /** the MIDI track and channel that carries the melody, "track:ch"; null: none found */
  melody: string | null;
  /** corrections on top of the straight mapping: [song time, seconds added], in time order;
   *  null: the straight mapping alone */
  warp: [number, number][] | null;
  /** share of sung notes that land on a melody note of their pitch class (0..1) */
  score: number;
  /** the score of each candidate track, best first, for the picker */
  tracks: { key: string; name: string; score: number; notes: number }[];
}

/** a sung note, in song time and MIDI pitch */
export interface SungRef {
  t0: number;
  midi: number;
}

const keyOf = (n: MidiNote) => `${n.track}:${n.ch}`;

/** the melodic tracks worth trying: pitched, in a singable register, not far busier than the song */
function candidates(m: MidiFile, nSung: number): Map<string, MidiNote[]> {
  const by = new Map<string, MidiNote[]>();
  for (const n of m.notes) {
    if (n.ch === 9) continue;
    const k = keyOf(n);
    (by.get(k) ?? by.set(k, []).get(k)!).push(n);
  }
  const out = new Map<string, MidiNote[]>();
  for (const [k, ns] of by) {
    if (ns.length < Math.min(20, nSung * 0.2)) continue;
    // one line per track: the top note of each chord
    const line: MidiNote[] = [];
    for (const n of [...ns].sort((a, b) => a.t0 - b.t0 || b.midi - a.midi)) {
      const last = line[line.length - 1];
      if (last && n.t0 - last.t0 < 0.03) continue;
      line.push(n);
    }
    out.set(k, line);
  }
  return out;
}

interface Peak {
  ratio: number;
  offset: number;
  transpose: number;
  votes: number;
}

/** vote over offsets for each transposition at one ratio; the strongest bin */
function vote(sung: SungRef[], line: MidiNote[], ratio: number, bin: number, lo: number, hi: number, hist: Int32Array): Peak {
  const nb = Math.ceil((hi - lo) / bin);
  hist.fill(0, 0, 12 * nb);
  for (const s of sung) {
    const sp = ((s.midi % 12) + 12) % 12;
    for (const n of line) {
      const a = s.t0 - ratio * n.t0;
      if (a < lo || a >= hi) continue;
      const k = (sp - (n.midi % 12) + 12) % 12;
      hist[k * nb + Math.floor((a - lo) / bin)]++;
    }
  }
  let best = 0, at = 0;
  for (let i = 0; i < 12 * nb; i++) {
    // a peak may straddle two bins
    const v = hist[i] + (i % nb < nb - 1 ? hist[i + 1] : 0);
    if (v > best) {
      best = v;
      at = i;
    }
  }
  const k = Math.floor(at / nb);
  return { ratio, offset: lo + ((at % nb) + 1) * bin, transpose: k > 6 ? k - 12 : k, votes: best };
}

type Mapping = Pick<Alignment, "ratio" | "offset" | "transpose"> & { warp?: [number, number][] | null };

/** MIDI time → song time under a mapping (the straight line, then the warp's correction there) */
export function mapper(a: Mapping): (t: number) => number {
  const w = a.warp;
  if (!w || !w.length) return (t) => a.ratio * t + a.offset;
  return (t) => {
    const g = a.ratio * t + a.offset;
    if (g <= w[0][0]) return g + w[0][1];
    if (g >= w[w.length - 1][0]) return g + w[w.length - 1][1];
    let lo = 0, hi = w.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (w[m][0] <= g) lo = m;
      else hi = m;
    }
    const u = (g - w[lo][0]) / (w[hi][0] - w[lo][0]);
    return g + w[lo][1] + u * (w[hi][1] - w[lo][1]);
  };
}

/** share of sung notes with a MIDI note of their pitch class starting within `tol` s */
export function matchScore(sung: SungRef[], line: MidiNote[], a: Mapping, tol = 0.12): number {
  if (!sung.length) return 0;
  const map = mapper(a);
  const starts = line.map((n) => ({ t: map(n.t0), pc: (((n.midi + a.transpose) % 12) + 12) % 12 })).sort((x, y) => x.t - y.t);
  let hit = 0, j = 0;
  for (const s of [...sung].sort((x, y) => x.t0 - y.t0)) {
    while (j < starts.length && starts[j].t < s.t0 - tol) j++;
    const pc = ((s.midi % 12) + 12) % 12;
    for (let k = j; k < starts.length && starts[k].t <= s.t0 + tol; k++)
      if (starts[k].pc === pc) {
        hit++;
        break;
      }
  }
  return hit / sung.length;
}

function alignLine(sung: SungRef[], line: MidiNote[], range: number): Peak & { score: number } {
  const hist = new Int32Array(12 * Math.ceil((2 * range) / 0.04) + 24);
  // coarse: 1% tempo steps, 150 ms bins over the whole offset range
  let best: Peak = { ratio: 1, offset: 0, transpose: 0, votes: -1 };
  for (let r = 0.8; r <= 1.25 + 1e-9; r += 0.01) {
    const p = vote(sung, line, r, 0.15, -range, range, hist);
    if (p.votes > best.votes) best = p;
  }
  // fine: 0.1% steps and 40 ms bins around the coarse peak
  let fine = best;
  for (let r = best.ratio - 0.012; r <= best.ratio + 0.012 + 1e-9; r += 0.001) {
    const p = vote(sung, line, r, 0.04, best.offset - 2, best.offset + 2, hist);
    if (p.votes > fine.votes) fine = p;
  }
  // last: move the offset by the median gap between the notes it pairs (the bins are 40 ms wide)
  const gaps: number[] = [];
  const mapped = line.map((n) => ({ t: fine.ratio * n.t0 + fine.offset, pc: (((n.midi + fine.transpose) % 12) + 12) % 12 }));
  for (const s of sung) {
    const pc = ((s.midi % 12) + 12) % 12;
    let g = Infinity;
    for (const x of mapped) if (x.pc === pc && Math.abs(s.t0 - x.t) < Math.abs(g) && Math.abs(s.t0 - x.t) < 0.15) g = s.t0 - x.t;
    if (g !== Infinity) gaps.push(g);
  }
  if (gaps.length > 5) fine = { ...fine, offset: fine.offset + gaps.sort((x, y) => x - y)[gaps.length >> 1] };
  return { ...fine, score: matchScore(sung, line, fine) };
}

/** the warp for a straight mapping: per-window corrections, coarse first, then finer */
function warpOf(sung: SungRef[], line: MidiNote[], a: Mapping): [number, number][] | null {
  if (sung.length < 40) return null;
  const sorted = [...sung].sort((x, y) => x.t0 - y.t0);
  const first = sorted[0].t0, last = sorted[sorted.length - 1].t0;
  const STEP = 6, HALF = 9;
  let warp: [number, number][] = [];
  for (let t = first; t <= last + STEP; t += STEP) warp.push([t, 0]);
  for (const reach of [0.8, 0.35, 0.18]) {
    const map = mapper({ ...a, warp });
    const mapped = line.map((n) => ({ t: map(n.t0), pc: (((n.midi + a.transpose) % 12) + 12) % 12 })).sort((x, y) => x.t - y.t);
    // each sung note's gap to the nearest MIDI note of its pitch class, within reach
    const gaps: [number, number][] = [];
    let j = 0;
    for (const s of sorted) {
      while (j < mapped.length && mapped[j].t < s.t0 - reach) j++;
      const pc = ((s.midi % 12) + 12) % 12;
      let g = Infinity;
      for (let k = j; k < mapped.length && mapped[k].t <= s.t0 + reach; k++) if (mapped[k].pc === pc && Math.abs(s.t0 - mapped[k].t) < Math.abs(g)) g = s.t0 - mapped[k].t;
      if (g !== Infinity) gaps.push([s.t0, g]);
    }
    const next: [number, number][] = warp.map(([t, c]) => {
      const near = gaps.filter(([x]) => Math.abs(x - t) <= HALF).map(([, g]) => g).sort((x, y) => x - y);
      return [t, near.length >= 6 ? c + near[near.length >> 1] : NaN];
    });
    // windows without enough pairs take their neighbours' correction
    for (let i = 0; i < next.length; i++)
      if (Number.isNaN(next[i][1])) {
        let l = i - 1, r = i + 1;
        while (l >= 0 && Number.isNaN(next[l][1])) l--;
        while (r < next.length && Number.isNaN(next[r][1])) r++;
        next[i][1] = l >= 0 && r < next.length ? next[l][1] + ((next[r][1] - next[l][1]) * (i - l)) / (r - l) : l >= 0 ? next[l][1] : r < next.length ? next[r][1] : warp[i][1];
      }
    // a 3-point median keeps one bad window from bending the rest
    warp = next.map(([t], i) => {
      const v = [next[Math.max(0, i - 1)][1], next[i][1], next[Math.min(next.length - 1, i + 1)][1]].sort((x, y) => x - y);
      return [t, v[1]];
    });
  }
  // the music never runs backwards: each correction at most 80% of a window's time behind the last
  for (let i = 1; i < warp.length; i++) warp[i][1] = Math.max(warp[i][1], warp[i - 1][1] - 0.8 * (warp[i][0] - warp[i - 1][0]));
  return warp;
}

/** Align `m` under the sung notes. `range`: the largest offset tried, either way (s). */
export function align(sung: SungRef[], m: MidiFile, range = 90): Alignment {
  // a dense song votes slowly: 300 of its notes are plenty
  const step = Math.max(1, Math.ceil(sung.length / 300));
  const pick = sung.filter((_, i) => i % step === 0);
  const lines = candidates(m, sung.length);
  const tracks: Alignment["tracks"] = [];
  let best: (Peak & { score: number; key: string; warp: [number, number][] | null }) | null = null;
  for (const [key, line] of lines) {
    // a track much busier than the song (a rhythm part) can't be its melody; skip the slow vote
    if (line.length > 3 * sung.length + 150) continue;
    const mid = [...line].sort((x, y) => x.midi - y.midi)[line.length >> 1].midi;
    if (mid < 48 || mid > 88) continue;
    const r = alignLine(pick, line, range);
    const score = matchScore(sung, line, r);
    let warp: [number, number][] | null = null;
    let warped = score;
    if (score > 0.15) {
      warp = warpOf(sung, line, r);
      warped = warp ? matchScore(sung, line, { ...r, warp }) : score;
      // keep the warp only where it helps
      if (warped < score + 0.03) {
        warp = null;
        warped = score;
      }
    }
    tracks.push({ key, name: m.trackNames[Number(key.split(":")[0])] || `Track ${key.split(":")[0]}`, score: warped, notes: line.length });
    if (!best || warped > best.score) best = { ...r, score: warped, key, warp };
  }
  // tracks of one name (a format 0 file names them all after the song): by their instrument
  const keys = tracks.map((t) => t.key);
  for (const t of tracks) t.name = trackLabel(m, t.key, keys);
  for (const t of tracks) if (tracks.filter((x) => x.name === t.name).length > 1) t.name = `${t.name} · ch ${Number(t.key.split(":")[1]) + 1}`;
  tracks.sort((a, b) => b.score - a.score);
  if (!best) return { ratio: 1, offset: 0, transpose: 0, melody: null, warp: null, score: 0, tracks };
  return { ratio: best.ratio, offset: best.offset, transpose: best.transpose, melody: best.score > 0.25 ? best.key : null, warp: best.warp, score: best.score, tracks };
}

/** re-score an alignment changed by hand (the melody track's match at the new mapping) */
export function rescore(sung: SungRef[], m: MidiFile, a: Alignment): number {
  if (!a.melody) return 0;
  const line = candidates(m, sung.length).get(a.melody);
  return line ? matchScore(sung, line, a) : 0;
}

/** The MIDI on the song's clock: retimed, transposed, the melody track left out where `muteMelody`. */
export function applyAlignment(m: MidiFile, a: Mapping & Pick<Alignment, "melody">, muteMelody: boolean): { backing: MidiFile; melody: MidiNote[] } {
  const map = mapper(a);
  const notes: MidiNote[] = [];
  const melody: MidiNote[] = [];
  for (const n of m.notes) {
    const t0 = map(n.t0), t1 = map(n.t1);
    if (t1 <= 0) continue;
    const midi = n.ch === 9 ? n.midi : n.midi + a.transpose;
    if (midi < 0 || midi > 127) continue;
    const x = { ...n, t0: Math.max(0, t0), t1, midi };
    if (a.melody && keyOf(n) === a.melody) {
      melody.push(x);
      if (muteMelody) continue;
    }
    notes.push(x);
  }
  // controllers before the song starts still set up their channels: at time 0
  const controls = m.controls.map((c) => ({ ...c, t: Math.max(0, map(c.t)) }));
  const texts = m.texts.map((x) => ({ ...x, t: map(x.t) }));
  return { backing: { ...m, notes, controls, texts, duration: map(m.duration) }, melody };
}

/** Change the tempo ratio keeping song time `anchor` where it is (so a nudge doesn't move the start). */
export function nudgeRatio(a: Alignment, ratio: number, anchor: number): Alignment {
  const m = (anchor - a.offset) / a.ratio;
  return { ...a, ratio, offset: anchor - ratio * m };
}
