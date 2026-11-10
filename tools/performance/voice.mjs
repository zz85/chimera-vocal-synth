// Execute with Bun, which can import the historical engine's TypeScript directly.
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasKana, japaneseSyllables } from './japanese.mjs';
import { mandarinSyllables } from './mandarin.mjs';

export const sampleRate = 48000;
export const fps = 25;

// Singing styles: a score's top-level "style" picks one. vibrato is the depth (cents) on held
// vowels, drift the slow random pitch wander (cents), roughness the cycle-to-cycle jitter (0..1).
// slide (s), where set, is how long the voice takes to move from one sung note's pitch to the
// next; without it the engine's own pitch ramps apply (about 60 ms on each side of a note).
export const STYLES = {
  steady: { vibrato: 6, drift: 0, roughness: 0.03, slide: 0.025 },
  natural: { vibrato: 22, drift: 5, roughness: 0.1 },
  ballad: { vibrato: 30, drift: 3, roughness: 0.08 },
};

export async function createVoice(engineDirectory, score) {
  const load = name => import(pathToFileURL(join(engineDirectory, name)).href);
  const { HumanVoice } = await load('src/engine/voice/humanVoice.ts');
  const { BODY_MALE } = await load('src/engine/anatomy/human.ts');
  const { EnglishG2P } = await load('src/engine/phonetics/english.ts');
  const { planUtterance, isVowel } = await load('src/engine/phonetics/planner.ts');
  const { lyricsToSyllables } = await load('src/engine/phonetics/syllables.ts');
  const { planSong } = await load('src/engine/phonetics/sing.ts');
  const { phoneme } = await load('src/engine/phonetics/inventory.ts');
  const { VoiceModel } = await load('src/ui/analysis.ts');
  const { writeWav } = await load('tools/lib/wav.ts');
  const model = new VoiceModel('male', sampleRate);
  // These two fields moved onto VoiceModel when the engine switched to WASM.
  model.bodyParams = BODY_MALE;
  model.tract = { scale: BODY_MALE.scale, P: model.airway.tract.P.bind(model.airway.tract) };
  const voice = new HumanVoice({ fsOut: sampleRate, body: BODY_MALE });
  const style = STYLES[score.style ?? 'natural'];
  if (!style) throw new Error('Unknown style ' + score.style + '; use one of ' + Object.keys(STYLES).join(', '));
  voice.setSource({ f0: 125, pressure: 9, tension: 0.55, voiced: true, drift: style.drift, roughness: style.roughness });
  const dictionary = new EnglishG2P();
  dictionary.setDictionaryText(gunzipSync(readFileSync(join(engineDirectory, 'public/data/cmudict.txt.gz'))).toString());
  const captions = [];
  let lastEnd = 0;
  const plans = [];
  for (const line of score.lines) {
    if (!line.words?.length) throw new Error('Each caption line needs at least one timed word.');
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      const start = batch[0].start;
      if (line.sung) {
        const notes = batch.flatMap(w => {
          const said = w.pronunciation ?? w.text;
          // Japanese words are kana, one mora per note; everything else goes through the English dictionary
          const known = ipa => !!phoneme(ipa);
          // Mandarin words are pinyin ("lang": "zh"), one syllable per note; the engine change that
          // adds tʂ also adds the aspiration flag Mandarin's b/p contrast needs
          const syllables = w.lang === 'zh' ? mandarinSyllables(said, known, known('tʂ'))
            : w.lang === 'ja' || hasKana(said) ? japaneseSyllables(said, w.notes.length, known) : lyricsToSyllables(said, dictionary);
          if (syllables.length !== w.notes.length) throw new Error('Syllable/note mismatch for ' + w.text);
          const beats = w.notes.reduce((sum, n) => sum + n[1], 0);
          if (!Number.isFinite(beats) || beats <= 0) throw new Error('Invalid note weights.');
          return w.notes.map(([midi, weight], i) => {
            if (!Number.isFinite(midi) || !Number.isFinite(weight) || weight <= 0) throw new Error('Invalid sung note.');
            return { midi, beats: (w.end - w.start) * weight / beats, syl: syllables[i] };
          });
        });
        const plan = planSong(notes, { body: 'male', bpm: 60, t0: start, vibrato: style.vibrato });
        if (style.slide) tightenSlides(plan, style.slide);
        plans.push(plan);
      } else {
        const segments = batch.flatMap(w => {
          if (!Number.isFinite(w.hz) || w.hz <= 0) throw new Error('Invalid pitch for ' + w.text);
          const phones = dictionary.toPhrases(w.pronunciation ?? w.text).flatMap(p => p.segments);
          if (!phones.length) throw new Error('No pronunciation for ' + w.text);
          const weights = phones.map(p => isVowel(p.ipa) ? (p.stress === 1 ? 2.5 : 1.9) : 1);
          const sum = weights.reduce((a, b) => a + b, 0);
          return phones.map((p, i) => ({ ...p, dur: (w.end - w.start) * weights[i] / sum, f0: w.hz }));
        });
        plans.push(planUtterance(segments, { body: 'male', t0: start - 0.06, f0: batch[0].hz, intonation: 'flat' }));
      }
      batch = [];
    };
    for (const w of line.words) {
      if (!w.text || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < lastEnd - 1e-6 || w.end <= w.start) throw new Error('Invalid or overlapping time for ' + w.text);
      if (w.start > lastEnd + 1e-6) flush();
      batch.push(w);
      captions.push({ ...w, key: captions.length });
      lastEnd = w.end;
    }
    flush();
  }
  if (!plans.length) throw new Error('The score is empty.');
  const duration = Math.max(lastEnd, ...plans.map(p => p.end)) + 0.35;
  return { voice, model, writeWav, captions, plans, duration };
}

/**
 * Shorten the move between a phrase's sung pitches to `slide` seconds. The engine ramps each
 * note's pitch in and out over 60 ms around its vowel, and the consonants between two vowels
 * are left with no pitch at all, where the voice drifts toward its resting pitch. Here each
 * note's pitch holds through the consonants up to the next note's vowel, and the two cross
 * over in the last `slide` seconds before it.
 */
function tightenSlides(plan, slide) {
  const pitches = plan.gestures.filter(g => g.label === 'pitch' && g.targets.f0 !== undefined).sort((a, b) => a.t0 - b.t0);
  for (let i = 0; i + 1 < pitches.length; i++) {
    const g = pitches[i], next = pitches[i + 1];
    if (next.t0 - g.t1 > 0.35) continue; // a breath between phrases
    g.t1 = Math.max(g.t0, next.t0 - slide);
    g.rampOut = slide;
    next.rampIn = slide;
  }
}
