/**
 * The page's settings in its address: `#song=<file>&s=<settings>`, where the settings are a
 * base64url JSON of each part's voice, the mix, the MIDI lined up under an UltraStar song, the
 * words put to a MIDI's tune, the band's muted instruments and the visual. A bookmark or a
 * shared link opens the song as it was set; the page rewrites the address as you change things
 * (without adding to the history).
 */
import type { PartSettings } from "./voices.ts";

export interface Shared {
  /** the song's file, as the song list (or the Lakh index) names it */
  song: string;
  /** each part's voice */
  p?: Partial<PartSettings>[];
  room?: number;
  /** the voices' and the backing's levels */
  vl?: number;
  bl?: number;
  font?: string;
  /** backing on, melody guide on, heads shown, band shown */
  bk?: boolean;
  guide?: boolean;
  heads?: boolean;
  band?: boolean;
  /** the MIDI under an UltraStar song (the page's SavedOverlay), null for none */
  o?: unknown;
  /** the words put to a MIDI's tune (the page's Words), null for none */
  w?: unknown;
  /** the backing's muted instruments, "track:ch" */
  mute?: string[];
  /** the visual: a built-in's id, a module's URL, "auto" or "off" */
  viz?: string;
}

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** numbers to 3 decimals, so the address stays short */
function round<T>(v: T): T {
  if (typeof v === "number") return (Math.round(v * 1000) / 1000) as T;
  if (Array.isArray(v)) return v.map(round) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) as T;
  return v;
}

export function encodeShared(s: Shared): string {
  const { song, ...rest } = s;
  const params = new URLSearchParams({ song });
  if (Object.keys(rest).length) params.set("s", b64url(JSON.stringify(round(rest))));
  return params.toString();
}

/** the settings in a hash (with or without its "#"), or null where it holds none */
export function decodeShared(hash: string): Shared | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const song = params.get("song");
  if (!song) return null;
  let rest: Omit<Shared, "song"> = {};
  const s = params.get("s");
  if (s)
    try {
      rest = JSON.parse(unb64url(s));
    } catch {
      rest = {};
    }
  return { ...rest, song };
}

/** put the settings in the address, in place of the history entry; returns the hash written */
export function writeHash(s: Shared): string {
  const h = "#" + encodeShared(s);
  if (location.hash !== h) history.replaceState(history.state, "", location.pathname + location.search + h);
  return h;
}
