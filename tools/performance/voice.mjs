// Execute with Bun, which can import the historical engine's TypeScript directly.
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasKana, japaneseSyllables } from './japanese.mjs';

export const sampleRate = 48000;
export const fps = 25;

export async function createVoice(engineDirectory, score) {
  const load = name => import(pathToFileURL(join(engineDirectory, name)).href);
  const { HumanVoice } = await load('src/engine/voice/humanVoice.ts');
  const { BODY_MALE } = await load('src/engine/anatomy/human.ts');
  const { EnglishG2P } = await load('src/engine/phonetics/english.ts');
  const { planUtterance, isVowel } = await load('src/engine/phonetics/planner.ts');
  const { lyricsToSyllables } = await load('src/engine/phonetics/syllables.ts');
  const { planSong } = await load('src/engine/phonetics/sing.ts');
  const { VoiceModel } = await load('src/ui/analysis.ts');
  const { writeWav } = await load('tools/lib/wav.ts');
  const model = new VoiceModel('male', sampleRate);
  // These two fields moved onto VoiceModel when the engine switched to WASM.
  model.bodyParams = BODY_MALE;
  model.tract = { scale: BODY_MALE.scale, P: model.airway.tract.P.bind(model.airway.tract) };
  const voice = new HumanVoice({ fsOut: sampleRate, body: BODY_MALE });
  voice.setSource({ f0: 125, pressure: 9, tension: 0.55, voiced: true });
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
          const syllables = w.lang === 'ja' || hasKana(said) ? japaneseSyllables(said, w.notes.length) : lyricsToSyllables(said, dictionary);
          if (syllables.length !== w.notes.length) throw new Error('Syllable/note mismatch for ' + w.text);
          const beats = w.notes.reduce((sum, n) => sum + n[1], 0);
          if (!Number.isFinite(beats) || beats <= 0) throw new Error('Invalid note weights.');
          return w.notes.map(([midi, weight], i) => {
            if (!Number.isFinite(midi) || !Number.isFinite(weight) || weight <= 0) throw new Error('Invalid sung note.');
            return { midi, beats: (w.end - w.start) * weight / beats, syl: syllables[i] };
          });
        });
        plans.push(planSong(notes, { body: 'male', bpm: 60, t0: start, vibrato: 22 }));
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
