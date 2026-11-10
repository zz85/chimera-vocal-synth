/**
 * Index the Lakh MIDI Dataset (lmd_full) for the karaoke page: one line per file, with a name
 * taken from the file's original paths (md5_to_paths.json) or its own tags, its length, and
 * whether it carries karaoke lyrics.
 *
 *   bun tools/karaoke/lakh-index.ts <lmd_full dir> <md5_to_paths.json> <out.tsv> [workers]
 *
 * Output lines: md5 \t name \t seconds \t lyric syllables \t notes. A worker mode (an extra
 * "--shard i/n" argument) indexes every n-th file and prints its lines; the main run starts the
 * workers and joins their output.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMidi } from "../../src/karaoke/midifile.ts";

const [dir, pathsFile, out, workersArg, shardArg, shard] = process.argv.slice(2);

const GENERIC = /^(.|\d+|midi?s?|.*midi.*|various( artists)?|misc.*|unsorted|new|songs?|music|mid|gold~?\d*|1tot100|sure\..*|bliss|[a-z]{1,3}\d*)$/i;

function clean(s: string): string {
  return s
    .replace(/\.(mid|midi|kar|rmi)$/i, "")
    .replace(/_/g, " ")
    .replace(/\s*\(\d+\)$/, "")
    .replace(/\s+\d{14}$/, "") // a download stamp
    .replace(/\s*[-_ ]+(kar|karaoke)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** the best name among a file's original paths */
function nameOf(paths: string[]): string {
  let best = "", score = -1;
  for (const p of paths) {
    const parts = p.split("/");
    const base = clean(parts[parts.length - 1]);
    const parent = parts.length > 1 ? clean(parts[parts.length - 2]) : "";
    let n = base, s = 1;
    if (/ - /.test(base)) s = 3;
    else if (parent && !GENERIC.test(parent)) {
      n = `${parent} - ${base}`;
      s = 2;
    }
    if (/[a-z]/.test(n) && /[A-Z]/.test(n)) s += 0.5; // mixed case reads better than SHOUTING
    if (/\d{3,}/.test(base)) s -= 1; // catalogue numbers
    if (s > score) {
      score = s;
      best = n;
    }
  }
  return best;
}

function indexOne(path: string, md5: string, paths: string[] | undefined): string | null {
  let m;
  try {
    m = parseMidi(readFileSync(path));
  } catch {
    return null;
  }
  // karaoke lyrics: the track with the most lyric or text events, as the page reads them
  const counts = new Map<string, number>();
  for (const t of m.texts) if (!t.text.startsWith("@")) counts.set(`${t.track}:${t.kind}`, (counts.get(`${t.track}:${t.kind}`) ?? 0) + 1);
  const lyrics = Math.max(0, ...counts.values());
  const tags = m.texts.filter((t) => t.text.startsWith("@T")).map((t) => clean(t.text.slice(2))).filter(Boolean);
  let name = paths ? nameOf(paths) : "";
  if (tags.length >= 2 && !/ - /.test(name)) name = `${tags[1]} - ${tags[0]}`;
  if (!name) name = m.trackNames.find((x) => x && / - /.test(x)) ?? m.trackNames.find(Boolean) ?? md5;
  name = name.replace(/[\u0000-\u001f\u007f\ufffd]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || md5;
  return [md5, name, Math.round(m.duration), lyrics >= 30 ? lyrics : 0, m.notes.length].join("\t");
}

function files(): { path: string; md5: string }[] {
  const out: { path: string; md5: string }[] = [];
  for (const d of readdirSync(dir).sort()) for (const f of readdirSync(join(dir, d)).sort()) out.push({ path: join(dir, d, f), md5: f.replace(/\.[^.]+$/, "") });
  return out;
}

if (shardArg === "--shard") {
  const [i, n] = shard.split("/").map(Number);
  const paths = JSON.parse(readFileSync(pathsFile, "utf8")) as Record<string, string[]>;
  const lines: string[] = [];
  files().forEach((f, k) => {
    if (k % n !== i) return;
    const l = indexOne(f.path, f.md5, paths[f.md5]);
    if (l) lines.push(l);
  });
  process.stdout.write(lines.join("\n") + "\n");
} else {
  const n = Number(workersArg ?? 16);
  const procs = Array.from({ length: n }, (_, i) => Bun.spawn(["bun", import.meta.path, dir, pathsFile, out, String(n), "--shard", `${i}/${n}`], { stdout: "pipe", stderr: "inherit" }));
  const texts = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
  const lines = texts.flatMap((t) => t.split("\n").filter(Boolean));
  // sorted by name, so the page can show a search's results in order without sorting them
  lines.sort((a, b) => a.split("\t")[1].localeCompare(b.split("\t")[1]));
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`${out}: ${lines.length} files, ${lines.filter((l) => l.split("\t")[3] !== "0").length} with lyrics`);
}
