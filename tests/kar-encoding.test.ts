/**
 * The encoding of a karaoke file's lyric events: one per file, from the bytes of every event,
 * as old .kar files carry Big5, GBK, Shift_JIS or Windows-1252 text with no label.
 */
import { describe, expect, test } from "bun:test";
import { textEncoding } from "../src/karaoke/midifile.ts";

// one event per character, as karaoke files store CJK lyrics
const events = (text: string, encoding: string) => {
  const enc = (s: string) => {
    // Bun has no encoder for these: map each character through a decoder's table of pairs
    const dec = new TextDecoder(encoding);
    const out: number[] = [];
    for (const ch of s) {
      if (ch.charCodeAt(0) < 0x80) {
        out.push(ch.charCodeAt(0));
        continue;
      }
      let found = false;
      for (let a = 0x81; a <= 0xfe && !found; a++)
        for (let b = 0x40; b <= 0xfe && !found; b++)
          if (dec.decode(new Uint8Array([a, b])) === ch) {
            out.push(a, b);
            found = true;
          }
      if (!found) throw new Error(`${ch} isn't in ${encoding}`);
    }
    return new Uint8Array(out);
  };
  return [...text].map(enc);
};
// Windows-1252 bytes, a word per event: Latin-1 letters keep their code, curly quotes and dashes
// take the 0x80-0x9F bytes
const CP1252: Record<string, number> = { "\u2019": 0x92, "\u2014": 0x97 };
const latin = (text: string) => text.split(/(?<= )/).map((w) => new Uint8Array([...w].map((c) => CP1252[c] ?? c.charCodeAt(0))));

describe("karaoke text encoding", () => {
  test("traditional Chinese is Big5", () => {
    expect(textEncoding(events("雙手輕輕捧著你的臉讓我的淚落在你掌心纏綿", "big5"))).toBe("big5");
  });
  test("simplified Chinese is GBK", () => {
    expect(textEncoding(events("这一生也在进取这分钟却挂念谁我会说是唯独你", "gbk"))).toBe("gbk");
  });
  test("Japanese is Shift_JIS", () => {
    expect(textEncoding(events("もうどれくらい歩いてきたのか街角に夏を飾る向日葵", "shift_jis"))).toBe("shift_jis");
  });
  test("accented and curly-quoted Latin text stays Windows-1252", () => {
    expect(textEncoding(latin("Träume für mich, Nächte voller Glück, schön und süß"))).toBe("windows-1252");
    expect(textEncoding(latin("Deus do meu coração, emoção e paixão sem razão"))).toBe("windows-1252");
    expect(textEncoding(latin("I can\u2019t say no, I don\u2019t want it, you\u2019re mine \u2014 it\u2019s so, we\u2019ll go, they\u2019re here, she\u2019s gone, I\u2019m done"))).toBe("windows-1252");
  });
  test("UTF-8 is UTF-8", () => {
    expect(textEncoding([...("纏綿 für dich")].map((c) => new TextEncoder().encode(c)))).toBe("utf-8");
  });
});
