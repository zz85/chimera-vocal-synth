/**
 * Japanese lyrics for the karaoke page: kana or romaji → sung syllables, one mora per note.
 * Ported from tools/performance/japanese.mjs (the performance renderer's), for the Rust engine,
 * whose inventory has no alveolo-palatals: し ち じ are sung as ʃ tʃ dʒ.
 *   ん  holds the vowel and ends it on a nasal
 *   ー  holds the vowel (a long vowel)
 *   っ  closes the vowel with the next mora's stop, or a glottal stop at the word's end
 * Romaji is read the Hepburn way, as karaoke files write it ("shi", "tsu", "kya", "nn" or "n'",
 * a doubled consonant for っ, "ā" or "ou" for a long vowel), and turned into kana first.
 */
import type { Syllable, Segment } from "../wasm/types.ts";

const V: Record<string, string> = { a: "a", i: "i", u: "ɯ", e: "e", o: "o" };

// mora → [onset IPA, vowel letter]
const ROWS: Record<string, [string, string]> = {
  あ: ["", "a"], い: ["", "i"], う: ["", "u"], え: ["", "e"], お: ["", "o"],
  か: ["k", "a"], き: ["k", "i"], く: ["k", "u"], け: ["k", "e"], こ: ["k", "o"],
  が: ["g", "a"], ぎ: ["g", "i"], ぐ: ["g", "u"], げ: ["g", "e"], ご: ["g", "o"],
  さ: ["s", "a"], し: ["ʃ", "i"], す: ["s", "u"], せ: ["s", "e"], そ: ["s", "o"],
  ざ: ["z", "a"], じ: ["dʒ", "i"], ず: ["z", "u"], ぜ: ["z", "e"], ぞ: ["z", "o"],
  た: ["t", "a"], ち: ["tʃ", "i"], つ: ["ts", "u"], て: ["t", "e"], と: ["t", "o"],
  だ: ["d", "a"], ぢ: ["dʒ", "i"], づ: ["z", "u"], で: ["d", "e"], ど: ["d", "o"],
  な: ["n", "a"], に: ["ɲ", "i"], ぬ: ["n", "u"], ね: ["n", "e"], の: ["n", "o"],
  は: ["h", "a"], ひ: ["ç", "i"], ふ: ["ɸ", "u"], へ: ["h", "e"], ほ: ["h", "o"],
  ば: ["b", "a"], び: ["b", "i"], ぶ: ["b", "u"], べ: ["b", "e"], ぼ: ["b", "o"],
  ぱ: ["p", "a"], ぴ: ["p", "i"], ぷ: ["p", "u"], ぺ: ["p", "e"], ぽ: ["p", "o"],
  ま: ["m", "a"], み: ["m", "i"], む: ["m", "u"], め: ["m", "e"], も: ["m", "o"],
  や: ["j", "a"], ゆ: ["j", "u"], よ: ["j", "o"],
  ら: ["ɾ", "a"], り: ["ɾ", "i"], る: ["ɾ", "u"], れ: ["ɾ", "e"], ろ: ["ɾ", "o"],
  わ: ["w", "a"], を: ["", "o"], ゔ: ["v", "u"],
};
// small kana: the glide they add to the mora before, and its new vowel
const SMALL: Record<string, [string, string]> = { ゃ: ["j", "a"], ゅ: ["j", "u"], ょ: ["j", "o"], ぁ: ["", "a"], ぃ: ["", "i"], ぅ: ["", "u"], ぇ: ["", "e"], ぉ: ["", "o"] };
const PALATAL = new Set(["ʃ", "tʃ", "dʒ", "ç", "ɲ"]);
const PAL: Record<string, string> = { h: "ç", n: "ɲ", s: "ʃ", z: "dʒ", t: "tʃ", d: "dʒ" };
const STOPS = new Set(["p", "b", "t", "d", "k", "g", "tʃ", "dʒ", "ts"]);

export const hasKana = (s: string) => /[\u3040-\u30ff]/.test(s);
const toHiragana = (s: string) => s.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

type Mora = { onset: string[]; vowel: string; mark?: undefined } | { mark: "n" | "long" | "q" };

function kanaMorae(text: string): Mora[] {
  const s = toHiragana(text.normalize("NFC")).replace(/[\s~\-。、,.!?！？「」『』…・'"]/g, "");
  const out: Mora[] = [];
  for (const ch of s) {
    if (ch === "ん") out.push({ mark: "n" });
    else if (ch === "ー") out.push({ mark: "long" });
    else if (ch === "っ") out.push({ mark: "q" });
    else if (SMALL[ch]) {
      const prev = out[out.length - 1];
      const [glide, v] = SMALL[ch];
      if (!prev || prev.mark) {
        out.push({ onset: [], vowel: v });
        continue;
      }
      let onset = prev.onset;
      if (glide === "j") {
        const c = onset[0];
        if (c && PAL[c]) onset = [PAL[c]];
        else if (!c || !PALATAL.has(c)) onset = [...onset, "j"];
      } else if (onset[0] === "ɸ" || onset[0] === "v") onset = [onset[0]];
      prev.onset = onset;
      prev.vowel = v;
    } else if (ROWS[ch]) {
      const [c, v] = ROWS[ch];
      out.push({ onset: c ? [c] : [], vowel: v });
    }
    // anything else (kanji, punctuation) has no reading here: skipped
  }
  return out;
}

/** how many notes a kana text takes: its morae, less っ, which closes the mora before */
export const moraCount = (text: string) => kanaMorae(text).filter((m) => m.mark !== "q").length;

/**
 * Kana → engine syllables, one per mora (ん and ー as held vowels). With `notes`, a text with
 * more morae than notes is fitted to them: held vowels fold into the mora before first, then
 * vowel-only morae (the う of じょう).
 */
export function japaneseSyllables(text: string, notes?: number): Syllable[] {
  const morae = kanaMorae(text);
  const syls: Syllable[] = [];
  let base: Syllable | null = null;
  morae.forEach((m, i) => {
    if (m.mark) {
      if (!base) {
        // a held mark with nothing before it: an "n" sung on its own
        if (m.mark === "n") {
          base = { text: "n", onset: [{ ipa: "n" }], nucleus: { ipa: "ɯ", stress: 1 }, coda: [], wordEnd: false, phraseEnd: false };
          syls.push(base);
        }
        return;
      }
      if (m.mark === "q") {
        const next = morae[i + 1];
        const c = next && !next.mark ? next.onset[0] : undefined;
        base.coda = [{ ipa: c && STOPS.has(c) ? (c === "ts" || c === "tʃ" ? "t" : c === "dʒ" ? "d" : c) : "ʔ" }];
        return;
      }
      if (m.mark === "n") base.coda = [{ ipa: "n" }];
      syls.push({ text: "~", onset: [], nucleus: base.nucleus, coda: [], melisma: true, wordEnd: false, phraseEnd: false });
      return;
    }
    base = { text: "", onset: m.onset.map((ipa): Segment => ({ ipa })), nucleus: { ipa: V[m.vowel], stress: 1 }, coda: [], wordEnd: false, phraseEnd: false };
    syls.push(base);
  });
  if (notes !== undefined) {
    for (const drop of [(s: Syllable) => !!s.melisma, (s: Syllable) => !s.onset.length && !s.coda.length]) {
      for (let i = syls.length - 1; i > 0 && syls.length > notes; i--) if (drop(syls[i])) syls.splice(i, 1);
    }
  }
  if (syls.length) syls[syls.length - 1].wordEnd = true;
  return syls;
}

// ---------------------------------------------------------------- romaji

const ROMAJI: Record<string, string> = {
  a: "あ", i: "い", u: "う", e: "え", o: "お",
  ka: "か", ki: "き", ku: "く", ke: "け", ko: "こ", ga: "が", gi: "ぎ", gu: "ぐ", ge: "げ", go: "ご",
  sa: "さ", shi: "し", si: "し", su: "す", se: "せ", so: "そ", za: "ざ", ji: "じ", zi: "じ", zu: "ず", ze: "ぜ", zo: "ぞ",
  ta: "た", chi: "ち", ti: "ち", tsu: "つ", tu: "つ", te: "て", to: "と", da: "だ", di: "ぢ", du: "づ", de: "で", do: "ど",
  na: "な", ni: "に", nu: "ぬ", ne: "ね", no: "の", ha: "は", hi: "ひ", fu: "ふ", hu: "ふ", he: "へ", ho: "ほ",
  ba: "ば", bi: "び", bu: "ぶ", be: "べ", bo: "ぼ", pa: "ぱ", pi: "ぴ", pu: "ぷ", pe: "ぺ", po: "ぽ",
  ma: "ま", mi: "み", mu: "む", me: "め", mo: "も", ya: "や", yu: "ゆ", yo: "よ",
  ra: "ら", ri: "り", ru: "る", re: "れ", ro: "ろ", la: "ら", li: "り", lu: "る", le: "れ", lo: "ろ",
  wa: "わ", wo: "を", vu: "ゔ",
  sha: "しゃ", shu: "しゅ", sho: "しょ", she: "しぇ", cha: "ちゃ", chu: "ちゅ", cho: "ちょ", che: "ちぇ",
  ja: "じゃ", ju: "じゅ", jo: "じょ", je: "じぇ", jya: "じゃ", jyu: "じゅ", jyo: "じょ",
  fa: "ふぁ", fi: "ふぃ", fe: "ふぇ", fo: "ふぉ", tsa: "つぁ", va: "ゔぁ", vi: "ゔぃ", ve: "ゔぇ", vo: "ゔぉ",
};
for (const [c, k] of Object.entries({ k: "き", g: "ぎ", n: "に", h: "ひ", b: "び", p: "ぴ", m: "み", r: "り", s: "し", z: "じ", t: "ち", d: "ぢ" }))
  for (const [v, sm] of Object.entries({ a: "ゃ", u: "ゅ", o: "ょ" })) ROMAJI[`${c}y${v}`] ??= k + sm;
const LONG: Record<string, string> = { ā: "aー", ī: "iー", ū: "uー", ē: "eー", ō: "oー", â: "aー", î: "iー", û: "uー", ê: "eー", ô: "oー" };

/** whether text reads as romaji: Latin letters that all split into Japanese morae */
export function isRomaji(text: string): boolean {
  const w = text.toLowerCase().replace(/[^a-zāīūēōâîûêô' ]/g, "").trim();
  return !!w && romajiToKana(w) !== null;
}

/** Romaji → hiragana, or null where a letter run isn't Japanese (an English word) */
export function romajiToKana(text: string): string | null {
  let s = text.toLowerCase().normalize("NFC");
  s = s.replace(/[āīūēōâîûêô]/g, (c) => LONG[c]);
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "ー") {
      out += "ー";
      i++;
      continue;
    }
    if (!/[a-z]/.test(c)) {
      if (c === "'" && out.endsWith("ん")) {
        i++;
        continue;
      }
      out += /\s/.test(c) ? " " : "";
      i++;
      continue;
    }
    // a doubled consonant: っ (but "nn" is ん)
    if (c !== "n" && c === s[i + 1] && /[bcdfghjkmprstvwz]/.test(c)) {
      out += "っ";
      i++;
      continue;
    }
    if (c === "t" && s.startsWith("tch", i)) {
      out += "っ";
      i++;
      continue;
    }
    let hit = false;
    for (const len of [3, 2, 1]) {
      const k = ROMAJI[s.slice(i, i + len)];
      if (k) {
        out += k;
        i += len;
        hit = true;
        break;
      }
    }
    if (hit) continue;
    if (c === "n" || c === "m") {
      // ん before a consonant, an apostrophe, the end of a word, or doubled ("nn")
      const nx = s[i + 1];
      if (c === "n" && nx === "n" && !/[aiueoy]/.test(s[i + 2] ?? "")) {
        out += "ん";
        i += 2;
        continue;
      }
      if (!nx || !/[aiueoy]/.test(nx) || (c === "m" && /[bmp]/.test(nx))) {
        out += "ん";
        i++;
        continue;
      }
    }
    return null;
  }
  return out;
}

/** Japanese lyrics in kana or romaji → syllables; null where the text isn't read as Japanese */
export function japaneseText(text: string, notes?: number): Syllable[] | null {
  if (hasKana(text)) return japaneseSyllables(text, notes);
  const k = romajiToKana(text.replace(/[-~]/g, ""));
  return k === null ? null : japaneseSyllables(k, notes);
}

/** split lyrics into morae for one note each: "konna koto" → ["ko", "n", "na", "ko", "to"] */
export function moraeOf(word: string): string[] {
  const out: string[] = [];
  const kana = hasKana(word) ? toHiragana(word) : romajiToKana(word);
  if (kana === null) return [word];
  if (hasKana(word)) {
    for (const ch of kana.replace(/\s/g, "")) {
      if (SMALL[ch] && out.length) out[out.length - 1] += ch;
      else if (ch === "っ" && out.length) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out;
  }
  // romaji: walk the word mora by mora as romajiToKana does, keeping the letters
  const s = word.toLowerCase();
  let i = 0;
  let cur = "";
  while (i < s.length) {
    const c = s[i];
    if (!/[a-zāīūēōâîûêô]/.test(c)) {
      cur += c;
      i++;
      continue;
    }
    if (c !== "n" && c === s[i + 1] && /[bcdfghjkmprstvwz]/.test(c)) {
      // っ closes the mora before: its letter stays with it
      if (out.length) out[out.length - 1] += c;
      else cur += c;
      i++;
      continue;
    }
    if (/[āīūēōâîûêô]/.test(c)) {
      out.push(cur + c, "~");
      cur = "";
      i++;
      continue;
    }
    let hit = 0;
    for (const len of [3, 2, 1]) if (ROMAJI[s.slice(i, i + len)]) {
      hit = len;
      break;
    }
    if (hit) {
      out.push(cur + word.slice(i, i + hit));
      cur = "";
      i += hit;
      continue;
    }
    if (c === "n" || c === "m") {
      const n2 = c === "n" && s[i + 1] === "n" && !/[aiueoy]/.test(s[i + 2] ?? "") ? 2 : 1;
      out.push(cur + word.slice(i, i + n2));
      cur = "";
      i += n2;
      continue;
    }
    out.push(cur + c);
    cur = "";
    i++;
  }
  if (cur && out.length) out[out.length - 1] += cur;
  else if (cur) out.push(cur);
  return out.filter((m) => m.replace(/['’]/g, "").length > 0);
}
