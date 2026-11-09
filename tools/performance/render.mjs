import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createVoice, fps, sampleRate } from './voice.mjs';
import { createPicture } from './picture.mjs';

const [scorePath, outputPath, backingPath] = process.argv.slice(2);
if (!scorePath || !outputPath || !process.env.CHIMERA_TS_ENGINE) {
  throw new Error('Set CHIMERA_TS_ENGINE, then run: bun render.mjs score.json output.mp4 [aligned-backing.wav]');
}
const score = JSON.parse(readFileSync(scorePath, 'utf8'));
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const state = await createVoice(resolve(process.env.CHIMERA_TS_ENGINE), score);
// a score's "duration" (s) keeps the video going past the last word, for an instrumental ending
const count = Math.ceil(Math.max(state.duration, score.duration ?? 0) * fps), samplesPerFrame = sampleRate / fps;
const samples = new Float32Array(count * samplesPerFrame);
const picture = createPicture(state.model, score, state.captions, count / fps);
const parent = dirname(resolve(outputPath)); mkdirSync(parent, { recursive: true });
const tmp = mkdtempSync(join(parent, '.chimera-render-'));
let encoder;
try {
  encoder = spawn(ffmpeg, ['-nostdin','-v','error','-f','rawvideo','-pix_fmt','rgba','-s','1280x720','-r',String(fps),'-i','pipe:0','-an','-c:v','libx264','-preset','veryfast','-crf','17','-pix_fmt','yuv420p', join(tmp,'silent.mp4')], { stdio: ['pipe','ignore','inherit'] });
  const closed = once(encoder, 'close');
  // Keep exit errors observable even if FFmpeg stops while a frame is being produced.
  closed.catch(() => {});
  let plan = 0, writeError;
  encoder.stdin.on('error', e => { writeError = e; });
  for (let i = 0; i < count; i++) {
    while (plan < state.plans.length && state.plans[plan].segments[0].t0 < i / fps + .4) state.voice.schedule(state.plans[plan++].gestures);
    const pixels = picture(i, state.voice.telemetry(), state.voice.artic.x);
    if (writeError || encoder.stdin.destroyed) throw writeError ?? new Error('Video encoder stopped.');
    await new Promise((done, fail) => {
      encoder.stdin.write(pixels, error => error ? fail(error) : done());
    });
    const end = (i + 1) * samplesPerFrame;
    for (let k = i * samplesPerFrame; k < end; k += 128) state.voice.render(samples, k, Math.min(128, end - k));
  }
  encoder.stdin.end();
  if ((await closed)[0] !== 0) throw new Error('Video encoding failed.');
  let peak = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error('Non-finite voice sample.');
    peak = Math.max(peak, Math.abs(sample));
  }
  if (peak < 1e-4) throw new Error('The voice rendered silent.');
  for (let i = 0; i < samples.length; i++) samples[i] *= .86 / peak;
  const wav = join(tmp,'voice.wav'), movie = join(tmp,'final.mp4');
  state.writeWav(wav, [samples], sampleRate);
  const args = ['-nostdin','-v','error','-i',join(tmp,'silent.mp4'),'-i',wav];
  if (backingPath) args.push('-i',resolve(backingPath),'-filter_complex',`[2:a]volume=${process.env.BACKING_GAIN ?? 0.27}[bed];[1:a]${process.env.VOICE_ROOM ? 'aecho=1:0.85:43|71|97:0.22|0.16|0.11,' : ''}anull[v];[v][bed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false[a]`,'-map','[a]');
  else args.push('-map','1:a:0');
  args.push('-map','0:v:0','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart',movie);
  const mux = spawnSync(ffmpeg,args,{stdio:'inherit'});
  if (mux.error || mux.status !== 0) throw mux.error ?? new Error('Audio mux failed.');
  renameSync(movie, resolve(outputPath));
  console.log('Rendered', count, 'frames to', resolve(outputPath));
} finally {
  if (encoder && encoder.exitCode === null) encoder.kill();
  rmSync(tmp, { recursive: true, force: true });
}
