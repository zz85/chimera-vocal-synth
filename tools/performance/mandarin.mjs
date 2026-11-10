// Mandarin lyrics (pinyin) -> sung syllables, one syllable per note, for the TS engine's planSong.
// A word's pronunciation is pinyin, its syllables separated by spaces or apostrophes, with tone
// marks or tone numbers, which are dropped: in singing the melody sets the pitch. "ü" may be
// written "v" or "u:". A standalone "~" or "-" holds the previous vowel onto another note.
//
// Initials keep Mandarin's contrast of aspiration, not voicing: b d g z zh j are unaspirated
// voiceless stops and affricates, p t k c ch q aspirated ones (the engine's `aspirated` flag).
// On an engine without that flag or the sounds tʂ and ɥ (the `known` check), b d g z zh j are
// sung as the voiced b d g dz dʒ dʒ, tʂ and tɕ as tʃ, ɕ as ʃ and ɥ as j, as an English voice would.

// initial -> [IPA, aspirated]
const INITIALS = {
  b: ['p', false], p: ['p', true], m: ['m'], f: ['f'],
  d: ['t', false], t: ['t', true], n: ['n'], l: ['l'],
  g: ['k', false], k: ['k', true], h: ['x'],
  j: ['tɕ', false], q: ['tɕ', true], x: ['ɕ'],
  zh: ['tʂ', false], ch: ['tʂ', true], sh: ['ʂ'], r: ['ɻ'],
  z: ['ts', false], c: ['ts', true], s: ['s'],
};
// final -> [glide, nucleus, coda]; diphthongs are one nucleus, which the engine glides
const FINALS = {
  a: ['', 'a'], o: ['', 'o'], e: ['', 'ɤ'], er: ['', 'ɚ'],
  ai: ['', 'aɪ'], ei: ['', 'eɪ'], ao: ['', 'aʊ'], ou: ['', 'oʊ'],
  an: ['', 'a', 'n'], en: ['', 'ə', 'n'], ang: ['', 'ɑ', 'ŋ'], eng: ['', 'ə', 'ŋ'], ong: ['', 'ʊ', 'ŋ'],
  i: ['', 'i'], ia: ['j', 'a'], ie: ['j', 'e'], iao: ['j', 'aʊ'], iou: ['j', 'oʊ'],
  ian: ['j', 'ɛ', 'n'], in: ['', 'i', 'n'], iang: ['j', 'ɑ', 'ŋ'], ing: ['', 'i', 'ŋ'], iong: ['j', 'ʊ', 'ŋ'],
  u: ['', 'u'], ua: ['w', 'a'], uo: ['w', 'o'], uai: ['w', 'aɪ'], uei: ['w', 'eɪ'],
  uan: ['w', 'a', 'n'], uen: ['w', 'ə', 'n'], uang: ['w', 'ɑ', 'ŋ'], ueng: ['w', 'ə', 'ŋ'],
  v: ['', 'y'], ve: ['ɥ', 'e'], van: ['ɥ', 'ɛ', 'n'], vn: ['', 'y', 'n'],
};
// y- and w- spellings of finals with no initial
const ZERO = {
  yi: 'i', ya: 'ia', ye: 'ie', yao: 'iao', you: 'iou', yan: 'ian', yin: 'in', yang: 'iang', ying: 'ing', yong: 'iong',
  yu: 'v', yue: 've', yuan: 'van', yun: 'vn',
  wu: 'u', wa: 'ua', wo: 'uo', wai: 'uai', wei: 'uei', wan: 'uan', wen: 'uen', wang: 'uang', weng: 'ueng',
};
// spellings that shorten a final after an initial
const SHORT = { iu: 'iou', ui: 'uei', un: 'uen' };
const ASPIRATION = 0.12;
const FALLBACK = { tʂ: 'tʃ', tɕ: 'tʃ', ɕ: 'ʃ', ɥ: 'j' };
const VOICED = { p: 'b', t: 'd', k: 'g', ts: 'dz', tɕ: 'dʒ', tʂ: 'dʒ' };

const TONE_MARKS = { ā: 'a', á: 'a', ǎ: 'a', à: 'a', ē: 'e', é: 'e', ě: 'e', è: 'e', ī: 'i', í: 'i', ǐ: 'i', ì: 'i', ō: 'o', ó: 'o', ǒ: 'o', ò: 'o', ū: 'u', ú: 'u', ǔ: 'u', ù: 'u', ǖ: 'v', ǘ: 'v', ǚ: 'v', ǜ: 'v', ü: 'v' };

/** One pinyin syllable -> { initial, final } as table keys. */
export function parsePinyin(syllable) {
  let s = syllable.normalize('NFC').toLowerCase().replace(/u:/g, 'v');
  s = [...s].map(c => TONE_MARKS[c] ?? c).join('').replace(/[1-5]$/, '');
  if (ZERO[s]) return { initial: '', final: ZERO[s] };
  if (s === 'ng' || s === 'm' || s === 'n') throw new Error('Syllabic nasal ' + syllable + ' is not supported');
  const initial = ['zh', 'ch', 'sh'].find(i => s.startsWith(i)) ?? (INITIALS[s[0]] ? s[0] : '');
  let final = s.slice(initial.length);
  if (SHORT[final] && initial) final = SHORT[final];
  // after j q x the written u is ü
  if ('jqx'.includes(initial) && initial && final.startsWith('u')) final = 'v' + final.slice(1);
  if (!FINALS[final]) throw new Error('Unknown pinyin syllable ' + syllable);
  return { initial, final };
}

/**
 * Pinyin text -> engine syllables, one per note. `known` says whether the engine has a sound;
 * `aspiration` whether it reads the `aspirated` flag.
 */
export function mandarinSyllables(text, known = () => true, aspiration = true) {
  const sound = ipa => (FALLBACK[ipa] && !known(ipa) ? FALLBACK[ipa] : ipa);
  const out = [];
  for (const tok of text.trim().split(/[\s']+/).filter(Boolean)) {
    if (tok === '~' || tok === '-') {
      const prev = out[out.length - 1];
      if (!prev) throw new Error('Text starts with a held note: ' + text);
      out.push({ text: '~', onset: [], nucleus: prev.nucleus, coda: [], melisma: true, wordEnd: false, phraseEnd: false });
      continue;
    }
    const { initial, final } = parsePinyin(tok);
    let [glide, nucleus, coda] = FINALS[final];
    // the apical vowel of zi ci si and zhi chi shi ri: a close central vowel
    if (final === 'i' && ['z', 'c', 's', 'zh', 'ch', 'sh', 'r'].includes(initial)) nucleus = 'ɨ';
    // bo po mo fo are buo puo muo fuo
    if (final === 'o' && 'bpmf'.includes(initial) && initial) glide = 'w';
    const onset = [];
    if (initial) {
      const [ipa, aspirated] = INITIALS[initial];
      const c = sound(ipa);
      if (aspirated === undefined) onset.push({ ipa: c });
      // Mandarin's aspirated stops hold the glottis open about 90 ms past the release (vot 0.12
      // in the engine's terms), longer than English's 60 ms
      else if (aspiration) onset.push(aspirated ? { ipa: c, aspirated, vot: ASPIRATION } : { ipa: c, aspirated });
      else onset.push({ ipa: aspirated ? c : VOICED[ipa] ?? c });
    }
    if (glide) onset.push({ ipa: sound(glide) });
    out.push({ text: tok, onset, nucleus: { ipa: nucleus, stress: 1 }, coda: coda ? [{ ipa: coda }] : [], wordEnd: false, phraseEnd: false });
  }
  if (out.length) out[out.length - 1].wordEnd = true;
  return out;
}
