/**
 * The Lakh MIDI Dataset on the karaoke page: its index (tools/karaoke/lakh-index.ts writes it
 * to shows/karaoke/lakh-index.tsv, one line per file: md5, name, seconds, lyric syllables,
 * notes, quality and what it's made of) and the files themselves under shows/karaoke/lakh/<first hex digit>/<md5>.mid.
 * The index is fetched once, the first time it's searched.
 */

export const LAKH_INDEX = "lakh-index.tsv";

export interface LakhRow {
  md5: string;
  name: string;
  seconds: number;
  /** karaoke lyric syllables in the file; 0: none */
  lyrics: number;
  notes: number;
  /** how good the file is to sing along with, 0..100 (tools/karaoke/lakh-index.ts quality) */
  quality: number;
  /** share of its lyrics a melody note sounds under, in percent */
  melodyHit: number;
  /** pitched instruments, and whether it has drums */
  instruments: number;
  drums: boolean;
  /** the name folded for search: lower case, no accents, words split by single spaces */
  key: string;
}

/** the file's path under shows/karaoke/ */
export const lakhPath = (md5: string) => `lakh/${md5[0]}/${md5}.mid`;

export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

let loading: Promise<LakhRow[]> | null = null;

export function loadLakh(base: string): Promise<LakhRow[]> {
  if (!loading)
    loading = (async () => {
      const res = await fetch(base + LAKH_INDEX);
      if (!res.ok || /text\/html/.test(res.headers.get("content-type") ?? "")) throw new Error(`${LAKH_INDEX} not found next to the songs (see tools/karaoke/lakh-index.ts)`);
      const text = await res.text();
      const rows: LakhRow[] = [];
      for (const line of text.split("\n")) {
        const [md5, name, s, l, n, q, h, i, d] = line.split("\t");
        if (!md5 || !name) continue;
        // an index from before the quality columns: lyrics alone stand for quality
        const quality = q === undefined ? (Number(l) ? 60 : 30) : Number(q);
        rows.push({ md5, name, seconds: Number(s), lyrics: Number(l), notes: Number(n), quality, melodyHit: Number(h ?? 0), instruments: Number(i ?? 0), drums: d === "1", key: fold(name) });
      }
      return rows;
    })();
  loading.catch(() => (loading = null));
  return loading;
}

/** whether `word` starts a word of `key` */
const atWord = (key: string, word: string) => (" " + key).includes(" " + word);

/**
 * The rows holding every word of `q`, best first: by how well the name matches (each word at a
 * word's start, more for a whole word, more again for the words together in order), then by the
 * file's quality, which counts for up to as much as a matched word or two, so a clean karaoke file beats a slightly better-named rough one.
 */
export function searchLakh(rows: LakhRow[], q: string, o: { lyricsOnly?: boolean; limit?: number; prefer?: string[] } = {}): LakhRow[] {
  const words = fold(q).split(" ").filter((w) => w.length > 0);
  if (!words.length) return [];
  const prefer = (o.prefer ?? []).map(fold).flatMap((p) => p.split(" ")).filter((w) => w.length > 2);
  const hits: { r: LakhRow; s: number }[] = [];
  for (const r of rows) {
    if (o.lyricsOnly && !r.lyrics) continue;
    let ok = true;
    for (const w of words)
      if (!r.key.includes(w)) {
        ok = false;
        break;
      }
    if (!ok) continue;
    let s = 0;
    const padded = ` ${r.key} `;
    for (const w of words) if (atWord(r.key, w)) s += padded.includes(` ${w} `) ? 3 : 2;
    // the words together, in order, as the name has them
    if (words.length > 1 && padded.includes(` ${words.join(" ")} `)) s += 3;
    for (const w of prefer) if (atWord(r.key, w)) s += 3;
    s += r.quality / 25;
    // the name holds little but the words asked for: the song itself, not a medley or a remix
    s -= Math.max(0, r.key.length - words.join(" ").length - 25) / 60;
    hits.push({ r, s });
  }
  hits.sort((a, b) => b.s - a.s);
  return hits.slice(0, o.limit ?? 200).map((h) => h.r);
}

/** what the quality is made of, for a tooltip */
export function qualityNote(r: LakhRow): string {
  const parts = [`quality ${r.quality}`];
  if (r.lyrics) parts.push(`melody under ${r.melodyHit}% of the lyrics`);
  else parts.push("no lyrics");
  if (r.instruments) parts.push(`${r.instruments} instrument${r.instruments === 1 ? "" : "s"}${r.drums ? " and drums" : ""}`);
  parts.push(`${Math.floor(r.seconds / 60)}:${String(r.seconds % 60).padStart(2, "0")}`);
  return parts.join(", ");
}

/** the words of a song's title worth searching for: no [DUET], (Live), feat. ... */
export function titleWords(title: string): string {
  return title
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\b(feat|ft)\b.*$/i, " ")
    .trim();
}
