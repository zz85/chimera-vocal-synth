import { existsSync } from 'node:fs';
import { createCanvas, GlobalFonts, Path2D } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { AnatomyRenderer } from '../../src/ui/render/anatomy.ts';
import { Glow, label } from '../../src/ui/render/vector.ts';
import { V } from '../../src/ui/colors.ts';
import { mouthWords } from '../../src/ui/mouthWords.ts';
import { fps } from './voice.mjs';

// The browser renderer creates one scratch canvas for the glow pass.
globalThis.Path2D = Path2D;
globalThis.document ??= { createElement: () => createCanvas(2, 2) };
for (const weight of ['Light', 'Medium']) {
  const file = new URL('../../public/fonts/AVHersheySimplex' + weight + '.otf', import.meta.url);
  GlobalFonts.registerFromPath(fileURLToPath(file), 'Hershey');
}
GlobalFonts.registerFromPath(fileURLToPath(new URL('../../public/fonts/archivo-latin.woff2', import.meta.url)), 'Archivo');
// The bundled fonts are Latin only. Register a CJK font so kana lyrics fall back to it:
// CJK_FONT names one, else the first system font found here.
const cjk = [process.env.CJK_FONT, '/usr/share/fonts/google-droid-sans-fonts/DroidSansJapanese.ttf',
  '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc'].find(f => f && existsSync(f));
if (cjk) GlobalFonts.registerFromPath(cjk, 'CJK');

const colors = { ink: '#e5eddd', dim: '#a2b4ab', green: '#8ce1b7', amber: '#ffc578', rule: '#3a4d48' };
function timecode(t) {
  return [Math.floor(t / 60), Math.floor(t % 60)].map(n => String(n).padStart(2, '0')).join(':');
}

export function createPicture(model, score, captions, duration) {
  const width = 530, height = 632;
  const tract = createCanvas(width, height), ctx = tract.getContext('2d');
  const screen = createCanvas(1280, 720), out = screen.getContext('2d');
  const renderer = new AnatomyRenderer(), glow = new Glow();
  renderer.resize(width, height);
  let currentWord = null, wordIndex = 0, lineIndex = 0, formants = [];
  const overlay = mouthWords(() => currentWord, '#ffffff');
  const pitches = [];
  const text = (str, x, y, size, color = colors.ink, family = 'Archivo, CJK, sans-serif') => {
    out.font = size + 'px ' + family;
    out.fillStyle = color;
    out.fillText(str, x, y);
  };
  return (frame, telemetry, articulation) => {
    const time = frame / fps;
    while (wordIndex + 1 < captions.length && captions[wordIndex + 1].start <= time) wordIndex++;
    while (lineIndex + 1 < score.lines.length && score.lines[lineIndex + 1].words[0].start <= time) lineIndex++;
    const w = captions[wordIndex];
    currentWord = w.start <= time && w.end > time ? w : null;
    const f = model.frame(articulation), t = telemetry;
    const message = { t, nPh: t.phAreas.length, nOr: t.orAreas.length };
    if (frame % 4 === 0) formants = model.transfer(articulation).formants;
    const nearest = model.vowels.reduce((best, v) => {
      const error = Math.hypot(2.2 * Math.log(formants[0] / v.F1), Math.log(formants[1] / v.F2));
      return error < best.error ? { error, ipa: v.ipa } : best;
    }, { error: Infinity, ipa: '−' });
    const slots = [
      { label: 'Tongue', value: nearest.ipa, color: V.green, ipa: true },
      { label: 'Jaw', value: articulation.jaw.toFixed(1), unit: 'cm', color: V.red },
      { label: 'Lips', value: articulation.lipAp.toFixed(1), unit: 'cm', color: V.pink },
      { label: 'Soft palate', value: f.velumPort > .02 ? f.velumPort.toFixed(2) : 'Shut', unit: f.velumPort > .02 ? 'cm²' : '', color: V.white },
    ];
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    renderer.face.update(message, 1 / fps);
    renderer.draw(ctx, model, f, articulation, message, { pressure: true, particles: true, calipers: true, grid: false }, {
      dt: 1 / fps, hover: null, drag: null, slots, formants,
      info: ['TRACT ' + f.length.toFixed(1) + ' CM', 'MOUTH ' + f.lipArea.toFixed(1) + ' CM²', 'F0 ' + t.f0.toFixed(1) + ' HZ', 'LUNGS ' + t.pLung.toFixed(1) + ' CMH₂O'],
    });
    overlay(ctx, renderer, model, f, articulation, { w: width, h: height, dt: 1 / fps });
    glow.apply(tract, ctx, 1);
    out.fillStyle = '#101d1d'; out.fillRect(0, 0, 1280, 720);
    out.fillStyle = '#000'; out.fillRect(0, 0, 552, 714);
    out.strokeStyle = '#45657d'; out.strokeRect(8.5, 8.5, 535, 697);
    label(out, 'VOCAL TRACT', 19, 30, { size: 15, color: V.blue, ls: .15, weight: 'm' });
    label(out, 'ADULT MALE / MIDSAGITTAL', 170, 30, { size: 11, color: V.blueMid, ls: .11 });
    let chipX = 19;
    for (const [name, cw] of [['SOUND PRESSURE', 145], ['AIRFLOW', 89], ['MEASUREMENTS', 134]]) {
      out.strokeStyle = '#55758e'; out.strokeRect(chipX + .5, 40.5, cw, 23);
      label(out, name, chipX + cw / 2, 56, { size: 11, color: V.blue, align: 'center' });
      chipX += cw + 6;
    }
    out.drawImage(tract, 11, 68);
    text('CHIMERA   /   VOCAL SYNTHESIZER', 585, 44, 16, colors.green, 'monospace');
    // shrink a long title to fit the panel (583 to 1235 px)
    out.font = '82px serif';
    const titleSize = Math.min(82, Math.floor(82 * 652 / out.measureText(score.title).width));
    text(score.title, 583, 140, titleSize, colors.ink, 'serif');
    text(score.credit ?? '', 587, 174, 17, colors.dim);
    out.fillStyle = colors.rule; out.fillRect(585, 199, 650, 1);
    const line = score.lines[lineIndex];
    text((line.section ?? 'Voice').toUpperCase(), 585, 235, 17, colors.amber, 'monospace');
    // Find the largest type size that fits this line in the caption region.
    let size = 44, rows;
    for (; size >= 12; size -= 2) {
      out.font = 'bold ' + size + 'px Archivo, CJK, sans-serif';
      let x = 585, y = 295;
      rows = [];
      for (const word of line.words) {
        const length = out.measureText(word.text).width;
        if (x > 585 && x + length > 1236) { x = 585; y += size * 1.2; }
        rows.push({ word, x, y });
        x += length + out.measureText(' ').width;
      }
      if (rows.at(-1).y < 422) break;
    }
    for (const { word, x, y } of rows) {
      out.fillStyle = currentWord?.start === word.start ? colors.amber : colors.ink;
      out.fillText(word.text, x, y);
    }
    text('VOICE PITCH', 585, 465, 15, colors.dim, 'monospace');
    const audible = t.outRms > .005 && t.voicing > .25;
    text(audible ? Math.round(t.f0) + ' Hz' : '—', 1140, 465, 17, colors.green, 'monospace');
    pitches.push(audible ? t.f0 : null);
    if (pitches.length > 151) pitches.shift();
    out.fillStyle = '#273c37';
    for (let y = 492; y <= 624; y += 33) out.fillRect(585, y, 650, 1);
    out.strokeStyle = colors.green; out.lineWidth = 3; out.beginPath();
    let down = false;
    pitches.forEach((p, i) => {
      if (p === null) { down = false; return; }
      const x = 1234 - (pitches.length - 1 - i) * 4.3;
      const y = 620 - Math.max(0, Math.min(1, Math.log2(p / 70) / 2.5)) * 130;
      if (down) out.lineTo(x, y); else out.moveTo(x, y);
      down = true;
    });
    out.stroke(); out.lineWidth = 1;
    text(score.bpm + ' BPM', 585, 680, 16, colors.dim, 'monospace');
    text(timecode(time) + ' / ' + timecode(duration), 1060, 680, 20, colors.ink, 'monospace');
    out.fillStyle = colors.green; out.fillRect(0, 715, 1280 * (time + 1 / fps) / duration, 5);
    return screen.data();
  };
}
