/**
 * The Lakh MIDI Dataset on the karaoke page: its index (tools/karaoke/lakh-index.ts writes it
 * to shows/karaoke/lakh-index.tsv, one line per file: md5, name, seconds, lyric syllables,
 * notes) and the files themselves under shows/karaoke/lakh/<first hex digit>/<md5>.mid.
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
        const [md5, name, s, l, n] = line.split("\t");
        if (!md5 || !name) continue;
        rows.push({ md5, name, seconds: Number(s), lyrics: Number(l), notes: Number(n), key: fold(name) });
      }
      return rows;
    })();
  loading.catch(() => (loading = null));
  return loading;
}

/** whether `word` starts a word of `key` */
const atWord = (key: string, word: string) => (" " + key).includes(" " + word);

/**
 * The rows holding every word of `q`, best first: more words at a word's start, then files with
 * lyrics, then named "Artist - Title", then shorter names.
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
    for (const w of words) if (atWord(r.key, w)) s += 2;
    for (const w of prefer) if (atWord(r.key, w)) s += 3;
    if (r.lyrics) s += 1.5;
    if (/ - /.test(r.name)) s += 0.5;
    s -= r.key.length / 200;
    hits.push({ r, s });
  }
  hits.sort((a, b) => b.s - a.s);
  return hits.slice(0, o.limit ?? 200).map((h) => h.r);
}

/** the words of a song's title worth searching for: no [DUET], (Live), feat. ... */
export function titleWords(title: string): string {
  return title
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\b(feat|ft)\b.*$/i, " ")
    .trim();
}
