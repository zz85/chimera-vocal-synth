/**
 * The karaoke player: one AudioContext holding a CHIMERA voice (its own AudioWorklet node) for
 * each part, a SoundFont synth for a MIDI backing (spessasynth, loaded on first use), and an
 * audio file for an UltraStar song when the user adds one. A lookahead loop sends each phrase's
 * gestures to its voice about a second before it starts, and the backing's MIDI events a few
 * hundred milliseconds ahead, all against the context's clock.
 */
import workletUrl from "../worklet/processor.ts?worker&url";
import { chimeraModule } from "../wasm/chimera.ts";
import type { BodyMix } from "../wasm/types.ts";
import type { FromWorklet, ToWorklet, TelemetryMessage } from "../worklet/protocol.ts";
import type { MidiFile, MidiNote } from "./midifile.ts";
import { PRE, type Phrase } from "./plan.ts";

/** where the SoundFont synth and its font are served from (public/shows/karaoke/) */
const VENDOR = `${import.meta.env.BASE_URL}shows/karaoke/`;
export const SOUNDFONTS = ["FluidR3.sf3", "Creative(emu10k1)8MBGMSFX.sf2", "JClive21.sf2"];

const VOICE_AHEAD = 1.2;
const MIDI_AHEAD = 0.3;
const TICK_MS = 40;

export class Voice {
  readonly node: AudioWorkletNode;
  readonly gain: GainNode;
  latest: TelemetryMessage | null = null;
  phrases: Phrase[] = [];
  /** the next phrase to send */
  next = 0;
  muted = false;
  private id = 0;

  constructor(ctx: AudioContext, out: AudioNode, readonly body: BodyMix) {
    this.node = new AudioWorkletNode(ctx, "chimera", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { module: chimeraModule() } });
    this.gain = ctx.createGain();
    this.node.connect(this.gain).connect(out);
    this.node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
      if (e.data.type === "telemetry") this.latest = e.data;
      else if (e.data.type === "error") console.error("karaoke voice:", e.data.message);
    };
    this.send({ type: "body", body });
  }

  send(m: ToWorklet): void {
    this.node.port.postMessage(m);
  }

  /** sing a phrase whose first note is `lead` seconds from now */
  sing(p: Phrase, lead: number): void {
    this.send({ type: "schedule", gestures: p.gestures, segments: [], end: p.end - p.start + PRE, id: ++this.id, replace: false, lead: Math.max(0, lead - PRE) });
  }

  stop(): void {
    this.send({ type: "stopSpeech" });
  }

  dispose(): void {
    this.stop();
    this.node.port.onmessage = null;
    this.node.disconnect();
    this.gain.disconnect();
  }
}

interface Synth {
  sendMessage(bytes: number[], channelOffset?: number, opts?: { time: number }): void;
  stopAll(force?: boolean): void;
  connect(n: AudioNode): void;
  isReady: Promise<unknown>;
  soundBankManager: { addSoundBank(buf: ArrayBuffer, id: string, offset?: number): Promise<void> };
}

/** a backing event: raw MIDI bytes at a song time */
type MidiEvent = { t: number; bytes: number[] };

export class KaraokePlayer {
  readonly ctx: AudioContext;
  private master: GainNode;
  private voiceBus: GainNode;
  readonly backingGain: GainNode;
  /** the mix as it leaves, for level readouts */
  readonly meter: AnalyserNode;
  voices: Voice[] = [];
  private synth: Synth | null = null;
  private synthLoading: Promise<Synth> | null = null;
  private font: string | null = null;
  private events: MidiEvent[] = [];
  private nextEvent = 0;
  private audio: AudioBuffer | null = null;
  private audioSrc: AudioBufferSourceNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** song time the play started at, and the context time it maps to */
  private from = 0;
  private startCtx = 0;
  private pausedAt = 0;
  playing = false;
  duration = 0;
  /** listeners told of play/pause/end */
  onState: (() => void) | null = null;

  private constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(ctx.destination);
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 2048;
    comp.connect(this.meter);
    // the voices go through a small hall so they sit in the same room as the band
    this.voiceBus = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    const verb = ctx.createConvolver();
    verb.buffer = hall(ctx, 1.9);
    this.voiceBus.connect(dry).connect(this.master);
    this.voiceBus.connect(verb).connect(wet).connect(this.master);
    this.backingGain = ctx.createGain();
    this.backingGain.gain.value = 0.7;
    this.backingGain.connect(this.master);
  }

  static async create(): Promise<KaraokePlayer> {
    const ctx = new AudioContext({ latencyHint: "playback" });
    await ctx.audioWorklet.addModule(workletUrl);
    return new KaraokePlayer(ctx);
  }

  setVoiceLevel(v: number): void {
    this.voiceBus.gain.value = v;
  }

  setBackingLevel(v: number): void {
    this.backingGain.gain.value = v;
  }

  /** Replace the voices: one per body, each with its phrases. */
  setParts(parts: { body: BodyMix; phrases: Phrase[]; muted: boolean }[]): void {
    const t = this.time();
    const was = this.playing;
    if (was) this.halt();
    // keep a voice whose body is unchanged (its node and telemetry stay)
    const old = this.voices;
    this.voices = parts.map((p, i) => {
      const keep = old[i] && old[i].body.female === p.body.female && old[i].body.child === p.body.child ? old[i] : null;
      const v = keep ?? new Voice(this.ctx, this.voiceBus, p.body);
      v.phrases = p.phrases;
      v.muted = p.muted;
      v.gain.gain.value = p.muted ? 0 : 1;
      return v;
    });
    for (const v of old) if (!this.voices.includes(v)) v.dispose();
    if (was) void this.play(t);
    else this.pausedAt = t;
  }

  /** The backing as MIDI, and the melody guide played quietly where `guide` is given. */
  setBacking(midi: MidiFile | null, guide: MidiNote[] | null, guideVelocity = 0.55): void {
    const ev: MidiEvent[] = [];
    if (midi) {
      for (const c of midi.controls) ev.push({ t: c.t, bytes: c.bytes });
      for (const n of midi.notes) {
        ev.push({ t: n.t0, bytes: [0x90 | n.ch, n.midi, n.vel] });
        ev.push({ t: n.t1, bytes: [0x80 | n.ch, n.midi, 0] });
      }
    }
    if (guide) {
      for (const n of guide) {
        const v = Math.max(1, Math.round(n.vel * guideVelocity));
        ev.push({ t: n.t0, bytes: [0x90 | n.ch, n.midi, v] });
        ev.push({ t: n.t1, bytes: [0x80 | n.ch, n.midi, 0] });
      }
    }
    // note-offs first at equal times, so a repeated note isn't cut by its own end
    ev.sort((a, b) => a.t - b.t || (a.bytes[0] & 0xf0) - (b.bytes[0] & 0xf0));
    const t = this.time();
    const was = this.playing;
    if (was) this.halt();
    this.events = ev;
    if (ev.length) void this.ensureSynth().catch((e) => console.error("karaoke: soundfont synth:", e));
    if (was) void this.play(t);
  }

  setAudio(buf: AudioBuffer | null): void {
    const t = this.time();
    const was = this.playing;
    if (was) this.halt();
    this.audio = buf;
    if (was) void this.play(t);
  }

  get hasMidi(): boolean {
    return this.events.length > 0;
  }

  async setFont(name: string): Promise<void> {
    if (this.font === name) return;
    const synth = await this.ensureSynth();
    await this.loadFont(synth, name);
  }

  private async loadFont(synth: Synth, name: string): Promise<void> {
    const res = await fetch(VENDOR + "soundfonts/" + encodeURI(name));
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    await synth.soundBankManager.addSoundBank(await res.arrayBuffer(), "main");
    this.font = name;
  }

  ensureSynth(): Promise<Synth> {
    if (this.synth) return Promise.resolve(this.synth);
    if (!this.synthLoading)
      this.synthLoading = (async () => {
        const lib = (await import(/* @vite-ignore */ new URL(`${VENDOR}spessasynth/spessasynth_lib.bundle.js`, location.href).href)) as { WorkletSynthesizer: new (ctx: AudioContext) => Synth };
        await this.ctx.audioWorklet.addModule(new URL(`${VENDOR}spessasynth/spessasynth_processor.min.js`, location.href).href);
        const s = new lib.WorkletSynthesizer(this.ctx);
        s.connect(this.backingGain);
        await s.isReady;
        await this.loadFont(s, SOUNDFONTS[0]);
        this.synth = s;
        return s;
      })();
    return this.synthLoading;
  }

  /** the song time now (s) */
  time(): number {
    if (!this.playing) return this.pausedAt;
    return this.from + Math.max(0, this.ctx.currentTime - this.startCtx);
  }

  async play(from = this.pausedAt): Promise<void> {
    if (this.playing) this.halt();
    await this.ctx.resume();
    if (this.events.length) await this.ensureSynth();
    this.from = Math.max(0, Math.min(from, this.duration));
    this.startCtx = this.ctx.currentTime + 0.15;
    // each voice starts at the first phrase that begins after the playhead
    for (const v of this.voices) {
      v.next = v.phrases.findIndex((p) => p.start >= this.from - 0.01);
      if (v.next < 0) v.next = v.phrases.length;
    }
    // the backing: the state before the playhead (programs, controllers), then from the playhead
    this.nextEvent = 0;
    if (this.synth) {
      const s = this.synth;
      s.stopAll(true);
      for (let ch = 0; ch < 16; ch++) s.sendMessage([0xb0 | ch, 121, 0]); // reset controllers
      while (this.nextEvent < this.events.length && this.events[this.nextEvent].t < this.from) {
        const e = this.events[this.nextEvent++];
        const hi = e.bytes[0] & 0xf0;
        if (hi !== 0x90 && hi !== 0x80) s.sendMessage(e.bytes);
      }
    }
    if (this.audio) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.audio;
      src.connect(this.backingGain);
      if (this.from < this.audio.duration) src.start(this.startCtx, this.from);
      this.audioSrc = src;
    }
    this.playing = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.onState?.();
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.time();
    this.halt();
    this.onState?.();
  }

  seek(t: number): void {
    if (this.playing) void this.play(t);
    else {
      this.pausedAt = Math.max(0, Math.min(t, this.duration));
      this.onState?.();
    }
  }

  /** stop every sound now, without moving the playhead */
  private halt(): void {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const v of this.voices) v.stop();
    const s = this.synth;
    if (s) {
      s.stopAll(true);
      // events already sent for the next few hundred milliseconds may still sound: stop again
      setTimeout(() => !this.playing && s.stopAll(true), (MIDI_AHEAD + 0.1) * 1000);
    }
    this.audioSrc?.stop();
    this.audioSrc?.disconnect();
    this.audioSrc = null;
  }

  private tick(): void {
    if (!this.playing) return;
    const now = this.time();
    const ctxNow = this.ctx.currentTime;
    const at = (t: number) => this.startCtx + (t - this.from);
    for (const v of this.voices) {
      while (v.next < v.phrases.length && v.phrases[v.next].start < now + VOICE_AHEAD) {
        const p = v.phrases[v.next++];
        if (v.muted) continue;
        const lead = at(p.start) - ctxNow;
        if (lead >= PRE) v.sing(p, lead);
      }
    }
    if (this.synth) {
      const s = this.synth;
      while (this.nextEvent < this.events.length && this.events[this.nextEvent].t < now + MIDI_AHEAD) {
        const e = this.events[this.nextEvent++];
        s.sendMessage(e.bytes, 0, { time: Math.max(ctxNow, at(e.t)) });
      }
    }
    if (now > this.duration) {
      this.pausedAt = 0;
      this.halt();
      this.onState?.();
    }
  }

  dispose(): void {
    this.halt();
    for (const v of this.voices) v.dispose();
    void this.ctx.close();
  }
}

/** a stereo hall impulse: decaying noise, darker as it fades */
function hall(ctx: AudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const k = 0.15 + 0.8 * Math.exp(-t * 2.5); // brightness falls with time
      lp += k * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp((-6.9 * t) / seconds) * (t < 0.012 ? t / 0.012 : 1);
    }
  }
  return b;
}
