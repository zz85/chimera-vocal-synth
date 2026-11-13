/**
 * How each part of a karaoke song is sung: its body (a blend of the three calibrated ones), its
 * pitch, and its voice, the source settings the sung gestures leave alone (how pressed, bright,
 * breathy, rough the voice is, its creak, its glide between notes, its vibrato's rate and its
 * pitch wander), with its level and place in the mix. A few presets set the voice at once.
 */
import type { BodyMix, VoiceSource } from "../wasm/types.ts";
import { DEFAULT_SOURCE } from "../wasm/engine.ts";
import type { BodyName } from "./song.ts";

export interface PartSettings {
  /** the preset body nearest the blend, for the buttons (null: a blend of its own) */
  body: BodyName | null;
  /** 0 adult male … 1 adult female */
  female: number;
  /** 0 adult … 1 child */
  child: number;
  octave: number;
  /** semitones on top of the octave */
  transpose: number;
  muted: boolean;
  /** the part's level (1: as planned) and its place left to right (-1 … 1) */
  level: number;
  pan: number;
  /** vibrato depth on held vowels (cents), planned with the notes */
  vibrato: number;
  vibratoRate: number;
  tension: number;
  brightness: number;
  breathiness: number;
  roughness: number;
  fry: number;
  glide: number;
  drift: number;
}

export const BODY_PRESETS: Record<BodyName, { female: number; child: number }> = { male: { female: 0, child: 0 }, female: { female: 1, child: 0 }, child: { female: 0.5, child: 1 } };

export type VoiceStyle = Pick<PartSettings, "vibrato" | "vibratoRate" | "tension" | "brightness" | "breathiness" | "roughness" | "fry" | "glide" | "drift">;

const D = DEFAULT_SOURCE;
export const STYLES: Record<string, VoiceStyle> = {
  Natural: { vibrato: 35, vibratoRate: D.vibratoRate, tension: D.tension, brightness: D.brightness, breathiness: D.breathiness, roughness: D.roughness, fry: D.fry, glide: D.glide, drift: D.drift },
  Soft: { vibrato: 25, vibratoRate: 5.2, tension: 0.3, brightness: 0.12, breathiness: 0.5, roughness: 0.05, fry: 0, glide: 0.09, drift: 4 },
  Belt: { vibrato: 45, vibratoRate: 5.8, tension: 0.78, brightness: 0.6, breathiness: 0.05, roughness: 0.12, fry: 0, glide: 0.05, drift: 5 },
  Rock: { vibrato: 20, vibratoRate: 6, tension: 0.7, brightness: 0.5, breathiness: 0.12, roughness: 0.55, fry: 0.15, glide: 0.04, drift: 8 },
  Crooner: { vibrato: 50, vibratoRate: 5, tension: 0.4, brightness: 0.18, breathiness: 0.25, roughness: 0.08, fry: 0.2, glide: 0.14, drift: 6 },
  Robot: { vibrato: 0, vibratoRate: 6, tension: 0.5, brightness: 0.4, breathiness: 0.05, roughness: 0, fry: 0, glide: 0.006, drift: 0 },
};

export function defaultSettings(body: BodyName, octave: number): PartSettings {
  return { body, ...BODY_PRESETS[body], octave, transpose: 0, muted: false, level: 1, pan: 0, ...STYLES.Natural };
}

export const bodyMix = (s: PartSettings): BodyMix => ({ female: s.female, child: s.child });

/** semitones the part's notes move by */
export const shiftOf = (s: PartSettings) => 12 * s.octave + s.transpose;

/** the preset a blend is, or null */
export function presetOf(female: number, child: number): BodyName | null {
  for (const [k, v] of Object.entries(BODY_PRESETS)) if (Math.abs(v.female - female) < 0.01 && Math.abs(v.child - child) < 0.01) return k as BodyName;
  return null;
}

/** the nearest preset body, for the octave guess */
export function nearestPreset(s: Pick<PartSettings, "female" | "child">): BodyName {
  if (s.child >= 0.5) return "child";
  return s.female >= 0.5 ? "female" : "male";
}

/** the source settings the voice holds, as the worklet takes them */
export function sourcePatch(s: PartSettings): Partial<VoiceSource> {
  return { tension: s.tension, brightness: s.brightness, breathiness: s.breathiness, roughness: s.roughness, fry: s.fry, glide: s.glide, drift: s.drift, vibratoRate: s.vibratoRate };
}

/** the style a part's voice matches, or null where it has been tweaked */
export function styleOf(s: PartSettings): string | null {
  for (const [name, st] of Object.entries(STYLES)) if ((Object.keys(st) as (keyof VoiceStyle)[]).every((k) => Math.abs(st[k] - s[k]) < 1e-6)) return name;
  return null;
}
