// Japanese lyrics (kana) -> sung syllables, one mora per note, for the TS engine's planSong.
// A word's text is kana; it gets one note per mora, where these marks hold the vowel on:
//   ん  holds the vowel and ends it on a nasal (the engine can't sustain a nasal as a nucleus)
//   ー  holds the vowel (long vowel)
//   っ  closes the vowel with the next mora's stop (or a glottal stop at the word's end)
// Small ゃゅょぁぃぅぇぉ join the mora before (きゃ, しょ, ふぁ). Katakana is read as hiragana.
// し ち じ are the alveolo-palatal ɕ tɕ dʑ. On an engine whose inventory lacks them (the
// `known` check), they are sung as the nearest postalveolars ʃ tʃ dʒ.
// Vowels: a i ɯ e o.

const V = { a: 'a', i: 'i', u: 'ɯ', e: 'e', o: 'o' };

// mora -> [onset IPA (space-separated), vowel letter]
const ROWS = {
  あ: ['', 'a'], い: ['', 'i'], う: ['', 'u'], え: ['', 'e'], お: ['', 'o'],
  か: ['k', 'a'], き: ['k', 'i'], く: ['k', 'u'], け: ['k', 'e'], こ: ['k', 'o'],
  が: ['g', 'a'], ぎ: ['g', 'i'], ぐ: ['g', 'u'], げ: ['g', 'e'], ご: ['g', 'o'],
  さ: ['s', 'a'], し: ['ɕ', 'i'], す: ['s', 'u'], せ: ['s', 'e'], そ: ['s', 'o'],
  ざ: ['z', 'a'], じ: ['dʑ', 'i'], ず: ['z', 'u'], ぜ: ['z', 'e'], ぞ: ['z', 'o'],
  た: ['t', 'a'], ち: ['tɕ', 'i'], つ: ['ts', 'u'], て: ['t', 'e'], と: ['t', 'o'],
  だ: ['d', 'a'], ぢ: ['dʑ', 'i'], づ: ['z', 'u'], で: ['d', 'e'], ど: ['d', 'o'],
  な: ['n', 'a'], に: ['ɲ', 'i'], ぬ: ['n', 'u'], ね: ['n', 'e'], の: ['n', 'o'],
  は: ['h', 'a'], ひ: ['ç', 'i'], ふ: ['ɸ', 'u'], へ: ['h', 'e'], ほ: ['h', 'o'],
  ば: ['b', 'a'], び: ['b', 'i'], ぶ: ['b', 'u'], べ: ['b', 'e'], ぼ: ['b', 'o'],
  ぱ: ['p', 'a'], ぴ: ['p', 'i'], ぷ: ['p', 'u'], ぺ: ['p', 'e'], ぽ: ['p', 'o'],
  ま: ['m', 'a'], み: ['m', 'i'], む: ['m', 'u'], め: ['m', 'e'], も: ['m', 'o'],
  や: ['j', 'a'], ゆ: ['j', 'u'], よ: ['j', 'o'],
  ら: ['ɾ', 'a'], り: ['ɾ', 'i'], る: ['ɾ', 'u'], れ: ['ɾ', 'e'], ろ: ['ɾ', 'o'],
  わ: ['w', 'a'], を: ['', 'o'], ゔ: ['v', 'u'],
};
// small kana: the vowel they give the mora before, and the glide they add after its consonant
const SMALL = { ゃ: ['j', 'a'], ゅ: ['j', 'u'], ょ: ['j', 'o'], ぁ: ['', 'a'], ぃ: ['', 'i'], ぅ: ['', 'u'], ぇ: ['', 'e'], ぉ: ['', 'o'] };
// consonants whose own articulation is palatal already: a small ゃゅょ adds no j
const PALATAL = new Set(['ɕ', 'tɕ', 'dʑ', 'ç', 'ɲ']);
// palatal forms for き+ゃ etc.
const PAL = { h: 'ç', n: 'ɲ', s: 'ɕ', z: 'dʑ', t: 'tɕ', d: 'dʑ' };
const STOPS = new Set(['p', 'b', 't', 'd', 'k', 'g', 'tɕ', 'dʑ', 'ts']);

export const hasKana = s => /[\u3040-\u30ff]/.test(s);
const toHiragana = s => s.replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

const FALLBACK = { ɕ: 'ʃ', tɕ: 'tʃ', dʑ: 'dʒ' };

/** Kana -> morae: { onset: string[], vowel, mark? } with mark 'n' | 'long' | 'q'. */
export function kanaMorae(text) {
  const s = toHiragana(text.normalize('NFC')).replace(/[\s~\-。、,.!?！？]/g, '');
  const out = [];
  for (const ch of s) {
    if (ch === 'ん') out.push({ mark: 'n' });
    else if (ch === 'ー') out.push({ mark: 'long' });
    else if (ch === 'っ') out.push({ mark: 'q' });
    else if (SMALL[ch]) {
      const prev = out[out.length - 1];
      if (!prev || prev.mark) throw new Error('Small kana with nothing before it: ' + text);
      const [glide, v] = SMALL[ch];
      let onset = prev.onset;
      if (glide === 'j') {
        const c = onset[0];
        if (c && PAL[c]) onset = [PAL[c]];
        else if (!c || !PALATAL.has(c)) onset = [...onset, 'j'];
      } else if (onset[0] === 'ɸ' || onset[0] === 'v') onset = [onset[0]]; // ふぁ: fa
      prev.onset = onset;
      prev.vowel = v;
    } else if (ROWS[ch]) {
      const [c, v] = ROWS[ch];
      out.push({ onset: c ? c.split(' ') : [], vowel: v });
    } else throw new Error('Unknown kana ' + JSON.stringify(ch) + ' in ' + text);
  }
  return out;
}

/**
 * Kana -> engine syllables, one per mora. With `notes`, a text with more morae than notes is
 * fitted to them: held vowels (ー, ん) fold into the mora before first, then vowel-only morae
 * (the う of じょう), so a long syllable sung on one note keeps one vowel. `known` says whether
 * the engine has a consonant.
 */
export function japaneseSyllables(text, notes, known = () => true) {
  const fallback = ipa => (FALLBACK[ipa] && !known(ipa) ? FALLBACK[ipa] : ipa);
  const morae = kanaMorae(text);
  const syls = [];
  let base = null; // the syllable whose vowel a mark holds on
  morae.forEach((m, i) => {
    if (m.mark) {
      if (!base) throw new Error('Text starts with ' + m.mark + ': ' + text);
      if (m.mark === 'q') {
        // っ: close on the next mora's stop; where none follows, a glottal stop
        const next = morae[i + 1];
        const c = next?.onset?.[0];
        base.coda = [{ ipa: c && STOPS.has(c) ? (c === 'ts' || c === 'tɕ' || c === 'dʑ' ? 't' : c) : 'ʔ' }];
        return; // っ takes no note of its own when it shares a note with its mora
      }
      if (m.mark === 'n') base.coda = [{ ipa: 'n' }];
      syls.push({ text: '~', onset: [], nucleus: base.nucleus, coda: [], melisma: true, wordEnd: false, phraseEnd: false });
      return;
    }
    base = { text: '', onset: m.onset.map(ipa => ({ ipa: fallback(ipa) })), nucleus: { ipa: V[m.vowel], stress: 1 }, coda: [], wordEnd: false, phraseEnd: false };
    syls.push(base);
  });
  if (notes !== undefined) {
    for (const drop of [s => s.melisma, s => !s.onset.length && !s.coda.length]) {
      for (let i = syls.length - 1; i > 0 && syls.length > notes; i--) if (drop(syls[i])) syls.splice(i, 1);
    }
  }
  if (syls.length) syls[syls.length - 1].wordEnd = true;
  return syls;
}

/** How many notes a kana text takes: its morae, less っ (which closes the mora before). */
export const moraCount = text => kanaMorae(text).filter(m => m.mark !== 'q').length;
