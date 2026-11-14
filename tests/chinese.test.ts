/**
 * Chinese lyrics on the karaoke page: characters read by their pinyin, a word picking each
 * character's reading in context, pinyin turned into sung syllables, and a Chinese .kar's
 * phrases planned one syllable to a note.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initEngine } from "./harness.ts";

await initEngine();
const { setHanziTable, hanziReadings } = await import("../src/karaoke/hanzi.ts");
const { mandarinSyllable, parsePinyin } = await import("../src/karaoke/mandarin.ts");
const { lyricsLang } = await import("../src/karaoke/song.ts");
const { planPart } = await import("../src/karaoke/plan.ts");
const { unitsOf } = await import("../src/karaoke/words.ts");
setHanziTable(gunzipSync(readFileSync(new URL("../public/data/hanzi-pinyin.txt.gz", import.meta.url))).toString());

const ipa = (py: string) => {
  const s = mandarinSyllable(py)!;
  return [...s.onset.map((x) => x.ipa), s.nucleus.ipa, ...s.coda.map((x) => x.ipa)].join("");
};

describe("hanzi readings", () => {
  test("traditional and simplified characters read alike", () => {
    expect(hanziReadings("雙手輕輕捧著你")).toEqual(["shuang", "shou", "qing", "qing", "peng", "zhe", "ni"]);
    expect(hanziReadings("双手轻轻捧着你")).toEqual(["shuang", "shou", "qing", "qing", "peng", "zhe", "ni"]);
  });
  test("a word picks a character's reading in context", () => {
    expect(hanziReadings("行走")[0]).toBe("xing");
    expect(hanziReadings("銀行")).toEqual(["yin", "hang"]);
    expect(hanziReadings("長大")).toEqual(["zhang", "da"]);
    expect(hanziReadings("很長")).toEqual(["hen", "chang"]);
  });
  test("other characters read as nothing", () => {
    expect(hanziReadings("你 a，好")).toEqual(["ni", null, null, null, "hao"]);
  });
});

describe("pinyin to syllables", () => {
  test("initials, medials, finals and the apical vowel", () => {
    expect(ipa("shuang")).toBe("ʂwɑŋ");
    expect(ipa("qing")).toBe("tʃiŋ");
    expect(ipa("xue")).toBe("ʃje");
    expect(ipa("lv")).toBe("ly");
    expect(ipa("ju")).toBe("dʒy");
    expect(ipa("zhi")).toBe("dʒɨ");
    expect(ipa("si")).toBe("sɨ");
    expect(ipa("bo")).toBe("bwo");
    expect(ipa("liu")).toBe("ljoʊ");
    expect(ipa("dui")).toBe("dweɪ");
    expect(ipa("er")).toBe("ɚ");
    expect(ipa("ai")).toBe("aɪ");
  });
  test("tone marks and numbers are dropped, and English isn't pinyin", () => {
    expect(parsePinyin("nǚ")).toEqual({ initial: "n", final: "v" });
    expect(parsePinyin("zhong1")).toEqual({ initial: "zh", final: "ong" });
    expect(parsePinyin("baby")).toBeNull();
    expect(parsePinyin("love")).toBeNull();
  });
});

describe("Chinese songs", () => {
  test("a song is Chinese by its characters, whatever its tag says", () => {
    expect(lyricsLang(["雙", "手", "輕", "輕"], "ENGL")).toBe("zh");
    expect(lyricsLang(["もう", "一度"])).toBe("ja");
    expect(lyricsLang(["One", "more", "time"])).toBe("en");
  });
  test("a .kar line sings a syllable on each character's note", () => {
    const line = "雙手輕輕捧著你";
    const notes = [...line].map((text, i) => ({ t0: i * 0.4, t1: i * 0.4 + 0.35, midi: 60 + i, text, cont: false, wordStart: i === 0, lineStart: i === 0 }));
    const phrases = planPart(notes, { body: { female: 0, child: 0 }, octave: 0, vibrato: 10, lang: "zh" });
    expect(phrases.length).toBe(1);
    expect(phrases[0].sung.map((x) => x[1]).join("")).toBe(line);
    // the voice says ʂ for 雙, and the vowels of each syllable
    const vowels = phrases[0].gestures.filter((g) => g.label && /^[aeiouyɑɨɤəɛɚʊ]/.test(g.label)).map((g) => g.label);
    expect(phrases[0].gestures.some((g) => g.label === "ʂ")).toBe(true);
    expect(vowels.length).toBeGreaterThanOrEqual(line.length);
  });
  test("typed Chinese lyrics take a character to a note, and English words beside them", () => {
    expect(unitsOf("雙手 baby 捧著你", "zh")).toEqual([[["雙", "手"], ["ba", "by"], ["捧", "著", "你"]]]);
  });
});
