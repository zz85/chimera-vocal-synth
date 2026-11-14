/**
 * Build public/data/hanzi-pinyin.txt.gz, the readings the karaoke page sings Chinese lyrics by,
 * from CC-CEDICT (CC BY-SA 4.0, MDBG).
 *   bun tools/karaoke/hanzi-pinyin.ts [cedict.txt.gz]
 * The input is either the MDBG release (cedict_1_0_ts_utf-8_mdbg.txt.gz) or a file in the
 * reformatted "traditional \t simplified \t pinyin \t definitions" form; without one, the
 * current release is downloaded from mdbg.net.
 *
 * The output holds, after its header, one line per key, "hanzi \t pinyin": each character
 * (traditional and simplified) with its most likely reading on its own, and each word of two to
 * four characters whose reading differs from its characters' own readings read one by one, so
 * a word only adds a line where its context changes a character's reading (银行 yinhang beside
 * 行 xing). Readings are toneless, as a melody sets the pitch: "lv" is lü, syllables are joined
 * by spaces. A character or word is left out where its reading isn't pinyin (a letter, "xx").
 *
 * A lone character's reading follows the Hanzi Lens rule (random-sketches/vibes/hanzi-lens,
 * text.js): a short table for the frequent polyphones, then the entry with the most senses that
 * isn't a surname, a variant or a "used in" pointer.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dir, "../../public/data/hanzi-pinyin.txt.gz");
const URL_ = "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz";

interface Entry {
  trad: string;
  simp: string;
  pinyin: string;
  defs: string[];
}

const src = process.argv[2] ? readFileSync(process.argv[2]) : Buffer.from(await (await fetch(URL_)).arrayBuffer());
const text = gunzipSync(src).toString("utf8");
let date = "";
const entries: Entry[] = [];
for (const line of text.split("\n")) {
  if (line.startsWith("#")) {
    const m = /^#!? ?date=(.*)|Release (\S+)\./.exec(line);
    if (m) date = (m[1] ?? m[2]).trim();
    continue;
  }
  let m = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/.exec(line);
  if (m) entries.push({ trad: m[1], simp: m[2], pinyin: m[3], defs: m[4].split("/") });
  else if ((m = /^([^\t]+)\t([^\t]*)\t([^\t]+)\t(.*)$/.exec(line))) entries.push({ trad: m[1], simp: m[2] || m[1], pinyin: m[3], defs: m[4].split("/") });
}

const byKey = new Map<string, Entry[]>();
for (const e of entries)
  for (const k of new Set([e.trad, e.simp])) {
    const list = byKey.get(k);
    if (list) list.push(e);
    else byKey.set(k, [e]);
  }

// ---- the Hanzi Lens rule for a lone character's reading
// prettier-ignore
const SOLO: Record<string, string> = {
  的: "de5", 了: "le5", 着: "zhe5", 得: "de5", 地: "di4", 和: "he2", 为: "wei4", 爲: "wei4", 為: "wei4", 都: "dou1",
  还: "hai2", 還: "hai2", 长: "chang2", 長: "chang2", 行: "xing2", 重: "zhong4", 好: "hao3", 乐: "le4", 樂: "le4",
  要: "yao4", 只: "zhi3", 种: "zhong3", 種: "zhong3", 大: "da4", 中: "zhong1", 一: "yi1", 不: "bu4", 会: "hui4",
  會: "hui4", 少: "shao3", 分: "fen1", 便: "bian4", 看: "kan4", 数: "shu4", 數: "shu4", 当: "dang1", 當: "dang1",
  没: "mei2", 沒: "mei2", 发: "fa1", 發: "fa1", 干: "gan1", 乾: "gan1", 幹: "gan4", 觉: "jue2", 覺: "jue2",
  相: "xiang1", 应: "ying1", 應: "ying1", 说: "shuo1", 說: "shuo1", 将: "jiang1", 將: "jiang1", 空: "kong1",
  差: "cha4", 正: "zheng4", 处: "chu4", 處: "chu4", 传: "chuan2", 傳: "chuan2", 调: "diao4", 調: "diao4",
  量: "liang4", 角: "jiao3", 似: "si4", 系: "xi4", 給: "gei3", 给: "gei3", 朝: "chao2", 率: "lu:4", 参: "can1",
  參: "can1", 薄: "bao2", 卷: "juan3", 假: "jia3", 盛: "sheng4", 转: "zhuan3", 轉: "zhuan3", 载: "zai4", 載: "zai4",
  散: "san4", 藏: "cang2", 难: "nan2", 難: "nan2", 结: "jie2", 結: "jie2", 间: "jian1", 間: "jian1", 兴: "xing1",
  興: "xing1", 强: "qiang2", 強: "qiang2", 作: "zuo4", 背: "bei4", 露: "lu4", 曲: "qu3", 几: "ji3", 幾: "ji3",
  奇: "qi2", 炸: "zha2", 片: "pian4", 叶: "ye4", 葉: "ye4", 尽: "jin3", 盡: "jin4", 份: "fen4",
  吗: "ma5", 嗎: "ma5", 呢: "ne5", 吧: "ba5", 啊: "a5", 么: "me5", 麼: "me5", 过: "guo4", 過: "guo4",
  // beside Hanzi Lens's: lyrics' own frequent polyphones
  著: "zhe5", 落: "luo4", 血: "xue4", 更: "geng4", 恶: "e4", 惡: "e4",
};
const WEAK = /^(surname |(old |archaic |ancient |erroneous )?variant of |used in |see |(Japanese|Korean) variant|abbr\. for |\(archaic\)|\(old\))/;

function bestEntry(word: string, list: Entry[] | undefined): Entry | null {
  if (!list?.length) return null;
  const solo = SOLO[word];
  if (solo) {
    const e = list.find((x) => x.pinyin === solo);
    if (e) return e;
  }
  let best: Entry | null = null;
  let bestScore = -Infinity;
  for (const e of list) {
    const strong = e.defs.filter((d) => !WEAK.test(d)).length;
    let score = strong * 2 + e.defs.length * 0.1;
    if (/[A-Z]/.test(e.pinyin[0])) score -= 5; // a proper noun's reading
    if (strong === 0) score -= 10;
    if (e.simp !== word && e.trad !== word) score -= 1;
    if (score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}

/** CEDICT pinyin ("lu:4 Zhong1 r5") → toneless syllables ("lv", "zhong", "r"), or null where one isn't pinyin */
function toneless(p: string): string[] | null {
  const out: string[] = [];
  for (const s of p.trim().split(/\s+/)) {
    const t = s.toLowerCase().replace(/u:/g, "v").replace(/[1-5]$/, "");
    if (!/^[a-zv]+$/.test(t) || t === "xx") return null;
    out.push(t);
  }
  return out;
}

const HAN = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3007\u{20000}-\u{3134f}]+$/u;
const chars = new Map<string, string>();
for (const [k, list] of byKey) {
  if ([...k].length !== 1 || !HAN.test(k)) continue;
  const e = bestEntry(k, list);
  const py = e && toneless(e.pinyin);
  if (py && py.length === 1) chars.set(k, py[0]);
}
const words = new Map<string, string>();
for (const [k, list] of byKey) {
  const cs = [...k];
  if (cs.length < 2 || cs.length > 4 || !HAN.test(k)) continue;
  const e = bestEntry(k, list);
  const py = e && toneless(e.pinyin);
  if (!py || py.length !== cs.length) continue;
  if (py.some((s, i) => chars.get(cs[i]) !== s)) words.set(k, py.join(" "));
}

const header = [
  "# Toneless pinyin of Chinese characters and of the words whose reading their characters alone don't give.",
  "# From CC-CEDICT, https://cc-cedict.org/ , published by MDBG" + (date ? `, release ${date}` : "") + ".",
  "# License: Creative Commons Attribution-ShareAlike 4.0, https://creativecommons.org/licenses/by-sa/4.0/",
  "# Modified (readings chosen and reformatted) by tools/karaoke/hanzi-pinyin.ts; distributed under the same license.",
];
const lines = [...[...chars].map(([k, v]) => `${k}\t${v}`), ...[...words].map(([k, v]) => `${k}\t${v}`)];
const gz = gzipSync(header.join("\n") + "\n" + lines.join("\n") + "\n", { level: 9 });
writeFileSync(OUT, gz);
console.log(`${chars.size} characters, ${words.size} words, ${(gz.length / 1024).toFixed(0)} KB -> ${OUT}`);
