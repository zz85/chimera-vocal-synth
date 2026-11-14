/**
 * Chinese characters → toneless pinyin, for singing Chinese lyrics: public/data/hanzi-pinyin.txt.gz
 * (tools/karaoke/hanzi-pinyin.ts builds it from CC-CEDICT) holds each character's reading on its
 * own and each word whose context changes a character's reading (銀行 yin hang beside 行 xing).
 * A run of characters is split into those words by dynamic programming, longest words first, and
 * a character outside any of them takes its own reading. Traditional and simplified both read.
 */

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3007\u{20000}-\u{3134f}]/u;
export const isHan = (ch: string) => HAN.test(ch);
/** whether text holds Chinese characters */
export const hasHan = (s: string) => HAN.test(s);

let table: Map<string, string> | null = null;
let maxLen = 1;
let loading: Promise<void> | null = null;

/** Read the table from its text ("hanzi \t pinyin" lines; "#" lines are its header). */
export function setHanziTable(text: string): void {
  const map = new Map<string, string>();
  let longest = 1;
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const key = line.slice(0, tab);
    map.set(key, line.slice(tab + 1).trim());
    longest = Math.max(longest, [...key].length);
  }
  table = map;
  maxLen = Math.min(longest, 8);
}

export const hanziLoaded = () => table !== null;

/** Load the table once (gzipped). */
export function loadHanzi(url = `${import.meta.env.BASE_URL}data/hanzi-pinyin.txt.gz`): Promise<void> {
  if (table) return Promise.resolve();
  if (!loading)
    loading = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`hanzi table ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // servers differ: some send Content-Encoding: gzip (already inflated by the browser)
      const text =
        bytes[0] === 0x1f && bytes[1] === 0x8b ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text() : new TextDecoder().decode(bytes);
      setHanziTable(text);
    })().catch((e) => {
      loading = null; // allow a retry
      throw e;
    });
  return loading;
}

/**
 * The reading of each character of `text`, one entry per code point: its toneless pinyin
 * syllable, or null for a character that isn't Chinese or that the table lacks.
 */
export function hanziReadings(text: string): (string | null)[] {
  const chars = [...text];
  const out: (string | null)[] = chars.map(() => null);
  if (!table) return out;
  let i = 0;
  while (i < chars.length) {
    if (!isHan(chars[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < chars.length && isHan(chars[j])) j++;
    readRun(chars.slice(i, j), i, out);
    i = j;
  }
  return out;
}

/** a run of characters split into the table's words, preferring fewer, longer words (score: length²) */
function readRun(run: string[], at: number, out: (string | null)[]): void {
  const n = run.length;
  const score = new Float64Array(n + 1).fill(-Infinity);
  const from = new Int32Array(n + 1);
  score[0] = 0;
  for (let i = 0; i < n; i++) {
    if (score[i] === -Infinity) continue;
    let w = "";
    for (let len = 1; len <= maxLen && i + len <= n; len++) {
      w += run[i + len - 1];
      if (len > 1 && !table!.has(w)) continue;
      const s = score[i] + len * len;
      if (s > score[i + len]) {
        score[i + len] = s;
        from[i + len] = i;
      }
    }
  }
  for (let k = n; k > 0; k = from[k]) {
    const a = from[k];
    const word = run.slice(a, k).join("");
    const py = table!.get(word)?.split(" ");
    if (py && py.length === k - a) py.forEach((s, x) => (out[at + a + x] = s));
    else for (let x = a; x < k; x++) out[at + x] = table!.get(run[x]) ?? null;
  }
}
