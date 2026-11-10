/**
 * The karaoke page (`?karaoke`): pick a song (UltraStar .txt, karaoke .kar or plain .mid, from
 * public/shows/karaoke/songs.json or dropped on the page) and CHIMERA sings it live, one voice
 * and one 3D head per part, over the song's MIDI backing through a SoundFont (or over the
 * song's audio, where you add it to an UltraStar song). Lyrics light up as they are sung; a
 * piano roll shows each part's notes.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Screen } from "../ui/components/Screen.tsx";
import { Segmented, Toggle, Slider } from "../ui/components/Controls.tsx";
import { getModel } from "../ui/useModel.ts";
import { VoiceModel } from "../ui/analysis.ts";
import { mouthWords } from "../ui/mouthWords.ts";
import { V } from "../ui/colors.ts";
import type { HeadFeed } from "../ui/components/AnatomyView3D.tsx";
import type { ViewFlags } from "../ui/render/anatomy.ts";
import { EnglishG2P, NEUTRAL } from "../wasm/engine.ts";
import type { BodyMix } from "../wasm/types.ts";
import { parseSong, autoOctave, type Song, type BodyName, type VNote } from "./song.ts";
import { planPart, type Phrase } from "./plan.ts";
import { KaraokePlayer, SOUNDFONTS } from "./player.ts";
import { parseMidi, type MidiFile, type MidiNote } from "./midifile.ts";
import { align, applyAlignment, nudgeRatio, rescore, type Alignment } from "./align.ts";
import "./karaoke.css";

const AnatomyView3D = lazy(() => import("../ui/components/AnatomyView3D.tsx").then((m) => ({ default: m.AnatomyView3D })));

const BASE = `${import.meta.env.BASE_URL}shows/karaoke/`;
const BODIES: Record<BodyName, BodyMix> = { male: { female: 0, child: 0 }, female: { female: 1, child: 0 }, child: { female: 0.5, child: 1 } };
const PART_COLORS = [V.blue, V.pink, V.green, V.amber];
const VIEW: ViewFlags = { pressure: true, particles: true, grid: false, calipers: false };
const dict = new EnglishG2P();

interface PartSettings {
  body: BodyName;
  octave: number;
  muted: boolean;
}

interface Entry {
  file: string;
  /** a MIDI from the list that songs.json puts under this song by default */
  backing?: string;
  song: Song | null;
  error?: string;
  /** a dropped file's bytes (songs from the list are fetched) */
  bytes?: Uint8Array;
}

/** a file name as a URL path (Vite's file server doesn't decode %26 or %5B, so those stay as they are) */
const fileUrl = (name: string) => encodeURI(name).replace(/#/g, "%23").replace(/\?/g, "%3F");

/** a MIDI file lined up under an UltraStar song */
interface Overlay {
  file: string;
  midi: MidiFile;
  /** what auto-align found (Auto-align goes back to it) */
  auto: Alignment;
  align: Alignment;
  muteMelody: boolean;
}

/** what's kept per song: the MIDI's name and how it lines up */
interface SavedOverlay {
  file: string;
  ratio: number;
  offset: number;
  transpose: number;
  melody: string | null;
  muteMelody: boolean;
  /** follow the recording's tempo changes (the auto warp) */
  warp: boolean;
}
const savedKey = (song: Song) => `chimera-karaoke:overlay:${song.id}`;

function loadSaved(song: Song): SavedOverlay | null {
  try {
    return JSON.parse(localStorage.getItem(savedKey(song)) ?? "null");
  } catch {
    return null;
  }
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export function KaraokePage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [player, setPlayer] = useState<KaraokePlayer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dictReady, setDictReady] = useState(false);
  const [settings, setSettings] = useState<PartSettings[]>([]);
  const [backingOn, setBackingOn] = useState(true);
  const [guide, setGuide] = useState(false);
  const [heads, setHeads] = useState(true);
  const [vibrato, setVibrato] = useState(35);
  const [voiceLevel, setVoiceLevel] = useState(1);
  const [backingLevel, setBackingLevel] = useState(0.7);
  const [font, setFont] = useState(SOUNDFONTS[0]);
  const [audioName, setAudioName] = useState<string | null>(null);
  const [synthState, setSynthState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [, setTick] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const phrasesRef = useRef<Phrase[][]>([]);
  const [dragging, setDragging] = useState(false);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [aligning, setAligning] = useState<string | null>(null);
  const shiftRef = useRef(false);

  // the player, the dictionary and the song list
  useEffect(() => {
    let p: KaraokePlayer | null = null;
    let live = true;
    KaraokePlayer.create()
      .then((x) => {
        if (!live) return x.dispose();
        p = x;
        (window as unknown as { __karaoke: KaraokePlayer }).__karaoke = x;
        x.onState = () => setTick((n) => n + 1);
        setPlayer(x);
      })
      .catch((e) => setError(`Audio could not start: ${e instanceof Error ? e.message : e}`));
    dict
      .load(`${import.meta.env.BASE_URL}data/cmudict.txt.gz`)
      .catch(() => console.warn("karaoke: no pronouncing dictionary; using letter-to-sound rules"))
      .finally(() => live && setDictReady(true));
    fetch(BASE + "songs.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((files: (string | { file: string; backing?: string })[]) => live && setEntries((e) => [...files.map((f) => (typeof f === "string" ? { file: f, song: null } : { file: f.file, backing: f.backing, song: null })), ...e]))
      .catch(() => {});
    return () => {
      live = false;
      p?.dispose();
    };
  }, []);

  // readouts follow the playhead
  useEffect(() => {
    const id = setInterval(() => player?.playing && setTick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [player]);

  const entry = entries.find((e) => e.file === current) ?? null;
  const song = entry?.song ?? null;

  // read a song when it's picked
  const open = useCallback(
    async (file: string) => {
      player?.pause();
      setCurrent(file);
      setAudioName(null);
      player?.setAudio(null);
      const e = entries.find((x) => x.file === file);
      if (!e || e.song) return;
      try {
        let bytes = e.bytes;
        if (!bytes) {
          const res = await fetch(BASE + fileUrl(file));
          // the dev server answers a missing file with the app's page
          if (!res.ok || /text\/html/.test(res.headers.get("content-type") ?? "")) throw new Error(`${file}: not found in public/shows/karaoke/`);
          bytes = new Uint8Array(await res.arrayBuffer());
        }
        const s = parseSong(file, bytes);
        setEntries((list) => list.map((x) => (x.file === file ? { ...x, song: s } : x)));
      } catch (err) {
        setEntries((list) => list.map((x) => (x.file === file ? { ...x, error: err instanceof Error ? err.message : String(err) } : x)));
      }
    },
    [entries, player],
  );

  // a MIDI under an UltraStar song: line it up (or take the saved lining up), then use it
  const attach = useCallback((s: Song, file: string, bytes: Uint8Array, saved: SavedOverlay | null) => {
    setAligning(file);
    // let the page show "Lining up..." before the vote runs
    setTimeout(() => {
      try {
        const midi = parseMidi(bytes);
        const sung = s.parts.flatMap((p) => p.notes.map((n) => ({ t0: n.t0, midi: n.midi })));
        const auto = align(sung, midi);
        let a = auto;
        if (saved && saved.file === file) {
          a = { ...auto, ratio: saved.ratio, offset: saved.offset, transpose: saved.transpose, melody: saved.melody, warp: saved.warp === false ? null : auto.warp };
          a = { ...a, score: rescore(sung, midi, a) };
        }
        setOverlay({ file, midi, auto, align: a, muteMelody: saved?.file === file ? saved.muteMelody : true });
      } catch (e) {
        setError(`${file}: ${e instanceof Error ? e.message : e}`);
      } finally {
        setAligning(null);
      }
    }, 30);
  }, []);

  const fetchBytes = async (file: string): Promise<Uint8Array> => {
    const res = await fetch(BASE + fileUrl(file));
    if (!res.ok || /text\/html/.test(res.headers.get("content-type") ?? "")) throw new Error(`${file}: not found in public/shows/karaoke/`);
    return new Uint8Array(await res.arrayBuffer());
  };

  // a new song drops the overlay, then brings back the one saved for it (a file from the list)
  useEffect(() => {
    setOverlay(null);
    if (!song || song.kind !== "ultrastar") return;
    const saved = loadSaved(song);
    // what this browser kept, else the backing songs.json gives the song
    const file = saved?.file ?? entries.find((x) => x.song === song)?.backing;
    if (!file) return;
    const e = entries.find((x) => x.file === file);
    (e?.bytes ? Promise.resolve(e.bytes) : fetchBytes(file)).then((b) => attach(song, file, b, saved)).catch(() => {});
    // entries change as songs are read; only a new song restores
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, attach]);

  // keep the lining up for next time
  useEffect(() => {
    if (!song || !overlay) return;
    const a = overlay.align;
    const v: SavedOverlay = { file: overlay.file, ratio: a.ratio, offset: a.offset, transpose: a.transpose, melody: a.melody, muteMelody: overlay.muteMelody, warp: !!a.warp };
    localStorage.setItem(savedKey(song), JSON.stringify(v));
  }, [song, overlay]);

  const placed = useMemo(() => (overlay ? applyAlignment(overlay.midi, overlay.align, overlay.muteMelody) : null), [overlay]);
  const backing = song?.backing ?? placed?.backing ?? null;
  const sungRefs = useMemo(() => (song ? song.parts.flatMap((p) => p.notes.map((n) => ({ t0: n.t0, midi: n.midi }))) : []), [song]);
  const setAlign = (patch: Partial<Alignment>) =>
    setOverlay((o) => {
      if (!o) return o;
      const a = { ...o.align, ...patch };
      return { ...o, align: { ...a, score: rescore(sungRefs, o.midi, a) } };
    });
  const firstSung = song ? Math.min(...song.parts.map((p) => p.notes[0]?.t0 ?? Infinity)) : 0;

  // each part's body and octave, from the song's own guess
  useEffect(() => {
    if (!song) return;
    setSettings(song.parts.map((p) => ({ body: p.body, octave: autoOctave(p.notes, p.body), muted: false })));
  }, [song]);

  // plan the parts and hand them to the player
  useEffect(() => {
    if (!song || !player || !dictReady || settings.length !== song.parts.length) return;
    player.duration = Math.max(song.duration, (backing?.duration ?? 0) + 1);
    const phrases = song.parts.map((p, i) => planPart(p.notes, { body: BODIES[settings[i].body], octave: settings[i].octave, vibrato }));
    phrasesRef.current = phrases;
    player.setParts(song.parts.map((_, i) => ({ body: BODIES[settings[i].body], phrases: phrases[i], muted: settings[i].muted })));
    setTick((n) => n + 1);
  }, [song, player, dictReady, settings, vibrato, backing]);

  // the backing (and the melody guide)
  useEffect(() => {
    if (!song || !player || settings.length !== song.parts.length) return;
    let guideNotes: MidiNote[] | null = null;
    if (guide) {
      if (song.guide.length) guideNotes = song.guide;
      else if (placed?.melody.length) guideNotes = placed.melody;
      else
        guideNotes = song.parts.flatMap((p, i) => (settings[i].muted ? [] : p.notes.map((n) => ({ t0: n.t0, t1: n.t1, track: 0, ch: 15, midi: n.midi + 12 * settings[i].octave, vel: 80 }))));
    }
    const midi = backingOn ? backing : null;
    if (midi || guideNotes) {
      setSynthState((s) => (s === "ready" ? s : "loading"));
      player
        .ensureSynth()
        .then(() => setSynthState("ready"))
        .catch(() => setSynthState("failed"));
    }
    player.setBacking(midi, guideNotes);
  }, [song, player, backingOn, guide, settings, backing, placed]);

  useEffect(() => player?.setVoiceLevel(voiceLevel), [player, voiceLevel]);
  useEffect(() => player?.setBackingLevel(backingLevel), [player, backingLevel]);
  useEffect(() => {
    if (!player || synthState !== "ready") return;
    player.setFont(font).catch((e) => setError(`Soundfont ${font}: ${e instanceof Error ? e.message : e}`));
  }, [player, font, synthState]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const added: Entry[] = [];
    for (const f of Array.from(files)) {
      if (/\.(mp3|ogg|m4a|wav|flac|opus|webm)$/i.test(f.name)) {
        // an audio file: the backing for the open UltraStar song
        if (!player) continue;
        try {
          const buf = await player.ctx.decodeAudioData(await f.arrayBuffer());
          player.setAudio(buf);
          setAudioName(f.name);
        } catch {
          setError(`${f.name}: not an audio file the browser can read`);
        }
        continue;
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      // a MIDI dropped on an open UltraStar song goes under it (shift-drop opens it as a song)
      if (/\.(mid|midi|kar|rmi)$/i.test(f.name) && song?.kind === "ultrastar" && !shiftRef.current) {
        attach(song, f.name, bytes, null);
        continue;
      }
      try {
        added.push({ file: f.name, song: parseSong(f.name, bytes), bytes });
      } catch (e) {
        added.push({ file: f.name, song: null, bytes, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (added.length) {
      setEntries((list) => [...list.filter((x) => !added.some((a) => a.file === x.file)), ...added]);
      setCurrent(added[0].file);
    }
  }, [player, song, attach]);

  const t = player?.time() ?? 0;
  const duration = song?.duration ?? 0;
  const playing = !!player?.playing;
  const toggle = () => {
    if (!player || !song) return;
    if (playing) player.pause();
    else {
      setEpoch((e) => e + 1);
      void player.play(t >= duration - 0.1 ? 0 : t);
    }
  };

  // space plays and pauses
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || (e.target as HTMLElement).closest("input, textarea, select")) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const setPart = (i: number, patch: Partial<PartSettings>) => setSettings((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));

  return (
    <div
      className={`karaoke${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        shiftRef.current = e.shiftKey;
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      <header className="duet-top">
        <span className="wordmark">Chimera</span>
        <span className="duet-title">Karaoke{song ? ` · ${song.title}${song.artist ? " · " + song.artist : ""}` : ""}</span>
      </header>
      <aside className="k-songs">
        <Screen title="Songs" sub={`${entries.length}`}>
          <ul className="k-list">
            {entries.map((e) => (
              <li key={e.file}>
                <button className={e.file === current ? "on" : ""} onClick={() => void open(e.file)} title={e.error ?? e.file}>
                  <span className="k-kind">{/\.txt$/i.test(e.file) ? "US" : /\.kar$/i.test(e.file) ? "KAR" : "MIDI"}</span>
                  <span className="k-name">{e.file.replace(/\.[^.]+$/, "")}</span>
                  {e.error && <span className="k-err">!</span>}
                </button>
              </li>
            ))}
          </ul>
          <label className="k-add">
            <input type="file" multiple accept=".txt,.kar,.mid,.midi,.mp3,.ogg,.m4a,.wav" onChange={(e) => e.target.files && void addFiles(e.target.files)} />
            Add files…
          </label>
          <p className="k-hint">Drop UltraStar .txt, .kar or .mid files anywhere. Drop an audio file to play it under the open UltraStar song.</p>
        </Screen>
      </aside>
      <main className="k-main">
        {error && <p className="duet-msg error" onClick={() => setError(null)}>{error}</p>}
        {!song && !entry?.error && <p className="duet-msg">{entry ? "Reading the song…" : "Pick a song."}</p>}
        {entry?.error && <p className="duet-msg error">{entry.error}</p>}
        {song && player && (
          <>
            {heads && (
              <div className="duet-heads k-heads" style={{ "--voices": song.parts.length } as React.CSSProperties}>
                {song.parts.map((p, i) =>
                  settings[i] ? (
                    <Head
                      key={`${song.id}:${i}:${settings[i].body}`}
                      player={player}
                      index={i}
                      name={p.name}
                      body={settings[i].body}
                      notes={p.notes}
                      color={PART_COLORS[i % PART_COLORS.length]}
                      facing={i > 0 && i === song.parts.length - 1 ? -1 : 1}
                      epoch={epoch}
                    />
                  ) : null,
                )}
              </div>
            )}
            <Lyrics song={song} time={t} settings={settings} />
            <Roll song={song} player={player} settings={settings} backing={backing} />
          </>
        )}
      </main>
      <aside className="k-side">
        {song && (
          <Screen title="Voices" sub={song.kind === "ultrastar" ? "UltraStar" : song.kind === "kar" ? "Karaoke MIDI" : "MIDI, scat"}>
            {song.parts.map((p, i) =>
              settings[i] ? (
                <div key={i} className="k-part" style={{ "--part": PART_COLORS[i % PART_COLORS.length] } as React.CSSProperties}>
                  <div className="k-part-name">{p.name}</div>
                  <Segmented<BodyName>
                    label={`${p.name} body`}
                    value={settings[i].body}
                    onChange={(b) => setPart(i, { body: b, octave: autoOctave(p.notes, b) })}
                    options={[
                      { value: "male", label: "Male" },
                      { value: "female", label: "Female" },
                      { value: "child", label: "Child" },
                    ]}
                  />
                  <div className="k-octave">
                    <span>Octave</span>
                    <button onClick={() => setPart(i, { octave: settings[i].octave - 1 })}>−</button>
                    <output>{settings[i].octave > 0 ? `+${settings[i].octave}` : settings[i].octave}</output>
                    <button onClick={() => setPart(i, { octave: settings[i].octave + 1 })}>+</button>
                    <Toggle label="Mute" checked={settings[i].muted} onChange={(m) => setPart(i, { muted: m })} />
                  </div>
                </div>
              ) : null,
            )}
            <Slider label="Vibrato" value={vibrato} min={0} max={80} step={5} onChange={(v) => setVibrato(Math.round(v / 5) * 5)} format={(v) => `${Math.round(v)} ct`} />
            <Slider label="Voices" value={voiceLevel} min={0} max={1.5} onChange={setVoiceLevel} format={(v) => `${Math.round(v * 100)}%`} />
            <div className="k-sep" />
            {song.kind === "ultrastar" && (
              <OverlayPanel
                overlay={overlay}
                aligning={aligning}
                midiFiles={entries.filter((e) => /\.(mid|midi|kar|rmi)$/i.test(e.file)).map((e) => e.file)}
                onPick={(file) => {
                  if (!file) {
                    setOverlay(null);
                    localStorage.removeItem(savedKey(song));
                    return;
                  }
                  const e = entries.find((x) => x.file === file);
                  (e?.bytes ? Promise.resolve(e.bytes) : fetchBytes(file)).then((b) => attach(song, file, b, null)).catch((err) => setError(String(err)));
                }}
                onFile={(f) => void f.arrayBuffer().then((b) => attach(song, f.name, new Uint8Array(b), null))}
                onAlign={setAlign}
                onRatio={(r) => overlay && setAlign(nudgeRatio(overlay.align, r, firstSung))}
                onAuto={() => setOverlay((o) => (o ? { ...o, align: o.auto } : o))}
                onMute={(m) => setOverlay((o) => (o ? { ...o, muteMelody: m } : o))}
                onWarp={(w) => overlay && setAlign({ warp: w ? overlay.auto.warp : null })}
              />
            )}
            {backing ? (
              <>
                <Toggle label={`Backing (${synthState === "loading" ? "loading soundfont…" : synthState === "failed" ? "soundfont failed" : "MIDI"})`} checked={backingOn} onChange={setBackingOn} />
                <label className="k-select">
                  <span>Soundfont</span>
                  <select value={font} onChange={(e) => setFont(e.target.value)}>
                    {SOUNDFONTS.map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <p className="k-hint">
                {audioName ? `Backing: ${audioName}` : song.audioName ? `No backing in this file. Drop "${song.audioName}" (or any audio) here to sing over it.` : "No backing in this file."}
              </p>
            )}
            <Toggle label="Melody guide (piano)" checked={guide} onChange={setGuide} />
            <Slider label="Backing" value={backingLevel} min={0} max={1.5} onChange={setBackingLevel} format={(v) => `${Math.round(v * 100)}%`} />
            <Toggle label="3D heads" checked={heads} onChange={setHeads} />
          </Screen>
        )}
      </aside>
      <footer className="duet-bar k-bar">
        <button className="primary large" disabled={!song || !player} onClick={toggle}>
          {playing ? "Pause" : "Play"}
        </button>
        <span className="duet-time">
          {clock(t)} / {clock(duration)}
        </span>
        <input
          type="range"
          aria-label="Position in the song"
          min={0}
          max={duration || 1}
          step={0.1}
          value={t}
          disabled={!song}
          onChange={(e) => {
            setEpoch((x) => x + 1);
            player?.seek(Number(e.target.value));
            setTick((n) => n + 1);
          }}
          style={{ "--pos": `${duration ? (100 * t) / duration : 0}%` } as React.CSSProperties}
        />
      </footer>
    </div>
  );
}

/** one part's head, moving from its voice's live telemetry */
function Head(props: { player: KaraokePlayer; index: number; name: string; body: BodyName; notes: VNote[]; color: string; facing: 1 | -1; epoch: number }) {
  const { player, index, notes } = props;
  const epochRef = useRef(props.epoch);
  epochRef.current = props.epoch;
  const feed = useMemo<HeadFeed>(() => {
    const model = getModel(BODIES[props.body], player.ctx.sampleRate);
    return {
      model,
      view: VIEW,
      maxDpr: 1.5,
      facing: props.facing,
      frame: () => {
        const v = player.voices[index];
        const tele = v?.latest ?? null;
        const artic = tele ? VoiceModel.articFromArray(tele.t.artic) : { ...NEUTRAL };
        return { tele: player.playing ? tele : null, artic, epoch: epochRef.current };
      },
    };
    // a new body is a new head (the key changes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const overlay = useMemo(
    () =>
      mouthWords(
        () => {
          if (!player.playing) return null;
          const t = player.time();
          let k = -1;
          let lo = 0, hi = notes.length - 1;
          while (lo <= hi) {
            const m = (lo + hi) >> 1;
            if (notes[m].t0 <= t) {
              k = m;
              lo = m + 1;
            } else hi = m - 1;
          }
          if (k < 0 || t > notes[k].t1 + 0.08) return null;
          // a held vowel shows the syllable it holds
          let b = k;
          while (b > 0 && notes[b].cont) b--;
          return notes[b].text ? { key: notes[b], text: notes[b].text } : null;
        },
        props.color,
        props.facing,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return (
    <Screen className="duet-head" focus title={props.name} sub={props.body} label={`${props.name}, ${props.body} voice, in 3D`}>
      <Suspense fallback={null}>
        <AnatomyView3D feed={feed} readouts={false} overlay={overlay} />
      </Suspense>
    </Screen>
  );
}

interface Line {
  part: number;
  t0: number;
  t1: number;
  frags: { t0: number; t1: number; text: string; space: boolean }[];
}

function linesOf(song: Song): Line[] {
  const out: Line[] = [];
  song.parts.forEach((p, part) => {
    let cur: Line | null = null;
    for (const n of p.notes) {
      if (!cur || n.lineStart) {
        if (cur) out.push(cur);
        cur = { part, t0: n.t0, t1: n.t1, frags: [] };
      }
      cur.t1 = Math.max(cur.t1, n.t1);
      if (n.text || !n.cont) cur.frags.push({ t0: n.t0, t1: n.t1, text: n.text, space: n.wordStart && cur.frags.length > 0 });
      else if (cur.frags.length) cur.frags[cur.frags.length - 1].t1 = n.t1;
    }
    if (cur) out.push(cur);
  });
  out.sort((a, b) => a.t0 - b.t0 || a.part - b.part);
  // a line both singers sing (the same words at the same time) shows once, as both
  const merged: (Line & { both?: boolean })[] = [];
  for (const l of out) {
    const text = l.frags.map((f) => f.text).join("");
    const twin = merged.find((m) => m.part !== l.part && Math.abs(m.t0 - l.t0) < 0.25 && m.frags.map((f) => f.text).join("") === text);
    if (twin) twin.both = true;
    else merged.push(l);
  }
  return merged;
}

function Lyrics(props: { song: Song; time: number; settings: PartSettings[] }) {
  const lines = useMemo(() => linesOf(props.song), [props.song]);
  const t = props.time;
  // the line being sung (or the next one), the one before it, and two after
  let k = lines.findIndex((l) => l.t1 + 0.3 > t);
  if (k < 0) k = lines.length;
  const shown = lines.slice(Math.max(0, k - 1), k + 3);
  const multi = props.song.parts.length > 1;
  const next = lines[k];
  const countIn = next && next.t0 - t > 3 && next.t0 - t < 30 ? Math.ceil(next.t0 - t) : null;
  return (
    <div className="k-lyrics">
      {countIn !== null && <div className="k-countin">{countIn}</div>}
      {shown.map((l) => {
        const active = l.t0 - 0.6 <= t && t <= l.t1 + 0.3;
        const color = (l as { both?: boolean }).both ? V.green : PART_COLORS[l.part % PART_COLORS.length];
        return (
          <p key={`${l.part}:${l.t0}`} className={`k-line${active ? " active" : ""}${l.t1 < t ? " done" : ""}`} style={{ "--part": color } as React.CSSProperties}>
            {multi && <span className="k-who">{(l as { both?: boolean }).both ? "Both" : props.song.parts[l.part].name}</span>}
            {l.frags.map((f, i) => {
              const fill = t <= f.t0 ? 0 : t >= f.t1 ? 1 : (t - f.t0) / (f.t1 - f.t0);
              return (
                <span key={i} className="k-frag" style={{ "--fill": `${Math.round(fill * 100)}%` } as React.CSSProperties}>
                  {f.space ? " " : ""}
                  {f.text}
                </span>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}

/** a scrolling piano roll: each part's notes as sung (with its octave), the backing faintly */
function Roll(props: { song: Song; player: KaraokePlayer; settings: PartSettings[]; backing: MidiFile | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  useEffect(() => {
    const c = ref.current!;
    const g = c.getContext("2d")!;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { song, player, settings, backing } = propsRef.current;
      const dpr = Math.min(2, devicePixelRatio);
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const t = player.time();
      const before = 2.5, after = 7.5;
      const x = (s: number) => ((s - (t - before)) / (before + after)) * w;
      const parts = song.parts.map((p, i) => ({ notes: p.notes, shift: 12 * (settings[i]?.octave ?? 0), color: PART_COLORS[i % PART_COLORS.length], muted: settings[i]?.muted }));
      let lo = 127, hi = 0;
      for (const p of parts) for (const n of p.notes) if (n.t1 > t - before && n.t0 < t + after) {
        lo = Math.min(lo, n.midi + p.shift);
        hi = Math.max(hi, n.midi + p.shift);
      }
      if (lo > hi) {
        lo = 48;
        hi = 72;
      }
      lo -= 3;
      hi += 3;
      if (hi - lo < 18) {
        const m = (hi + lo) / 2;
        lo = m - 9;
        hi = m + 9;
      }
      const y = (m: number) => h - 6 - ((m - lo) / (hi - lo)) * (h - 12);
      const row = Math.max(3, (h - 12) / (hi - lo));
      // C lines
      g.strokeStyle = V.frame;
      g.lineWidth = 1;
      for (let m = Math.ceil(lo); m <= hi; m++)
        if (m % 12 === 0) {
          g.beginPath();
          g.moveTo(0, y(m));
          g.lineTo(w, y(m));
          g.stroke();
          g.fillStyle = V.blueDim;
          g.font = "10px system-ui";
          g.fillText(`C${m / 12 - 1}`, 4, y(m) - 2);
        }
      // the backing, faint
      const b = backing;
      if (b) {
        g.fillStyle = "rgba(52, 135, 196, 0.18)";
        for (const n of b.notes) {
          if (n.ch === 9 || n.t1 < t - before || n.t0 > t + after || n.midi < lo || n.midi > hi) continue;
          g.fillRect(x(n.t0), y(n.midi) - 1, Math.max(1, x(n.t1) - x(n.t0)), 2);
        }
      }
      for (const p of parts) {
        for (const n of p.notes) {
          if (n.t1 < t - before || n.t0 > t + after) continue;
          const m = n.midi + p.shift;
          const on = n.t0 <= t && t < n.t1;
          g.fillStyle = p.muted ? V.blueDim : p.color;
          g.globalAlpha = on ? 1 : n.t1 < t ? 0.45 : 0.75;
          g.fillRect(x(n.t0), y(m) - row / 2, Math.max(2, x(n.t1) - x(n.t0) - 1), row);
          if (n.text && !n.cont && x(n.t1) - x(n.t0) > 4) {
            g.globalAlpha = on ? 1 : 0.7;
            g.fillStyle = V.white;
            g.font = "11px system-ui";
            g.fillText(n.text, x(n.t0), y(m) - row / 2 - 3);
          }
        }
      }
      g.globalAlpha = 1;
      g.strokeStyle = V.amber;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x(t), 0);
      g.lineTo(x(t), h);
      g.stroke();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="k-roll" />;
}

/** the MIDI under an UltraStar song: which file, how well it lines up, and the hand controls */
function OverlayPanel(props: {
  overlay: Overlay | null;
  aligning: string | null;
  midiFiles: string[];
  onPick: (file: string | null) => void;
  onFile: (f: File) => void;
  onAlign: (patch: Partial<Alignment>) => void;
  onRatio: (r: number) => void;
  onAuto: () => void;
  onMute: (m: boolean) => void;
  onWarp: (on: boolean) => void;
}) {
  const { overlay: o, aligning } = props;
  const a = o?.align;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <div className="k-overlay">
      <label className="k-select">
        <span>MIDI backing</span>
        <select value={aligning ?? o?.file ?? ""} onChange={(e) => props.onPick(e.target.value || null)}>
          <option value="">None</option>
          {aligning && !props.midiFiles.includes(aligning) && <option value={aligning}>{aligning}</option>}
          {o && o.file !== aligning && !props.midiFiles.includes(o.file) && <option value={o.file}>{o.file}</option>}
          {props.midiFiles.map((f) => (
            <option key={f} value={f}>
              {f.replace(/\.[^.]+$/, "")}
            </option>
          ))}
        </select>
      </label>
      <label className="k-add small">
        <input type="file" accept=".mid,.midi,.kar,.rmi" onChange={(e) => e.target.files?.[0] && props.onFile(e.target.files[0])} />
        Load a MIDI…
      </label>
      {aligning && <p className="k-hint">Lining up {aligning}…</p>}
      {!o && !aligning && <p className="k-hint">Drop a .mid or .kar here to play it under this song, lined up to the singing. Shift-drop opens it as a song of its own.</p>}
      {o && a && !aligning && (
        <>
          <p className={`k-hint${a.score < 0.35 ? " warn" : ""}`}>
            {a.melody ? `Melody: ${a.tracks.find((t) => t.key === a.melody)?.name ?? a.melody}, ${pct(a.score)} of sung notes land on it.` : "No track follows the singing: line it up by ear."}
            {a.melody && a.score < 0.35 ? " A weak match: check it by ear." : ""}
          </p>
          <label className="k-select">
            <span>Melody track</span>
            <select value={a.melody ?? ""} onChange={(e) => props.onAlign({ melody: e.target.value || null })}>
              <option value="">None</option>
              {a.tracks.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name} ({pct(t.score)})
                </option>
              ))}
            </select>
          </label>
          <Toggle label="Mute the MIDI melody" checked={o.muteMelody} onChange={props.onMute} />
          {o.auto.warp && <Toggle label="Follow the recording's tempo changes" checked={!!a.warp} onChange={props.onWarp} />}
          <Slider label="Offset" value={a.offset} min={o.auto.offset - 10} max={o.auto.offset + 10} onChange={(v) => props.onAlign({ offset: Math.round(v * 100) / 100 })} format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)} s`} />
          <div className="k-octave">
            <span>Nudge</span>
            <button aria-label="50 ms earlier" onClick={() => props.onAlign({ offset: a.offset - 0.05 })}>−</button>
            <output>50 ms</output>
            <button aria-label="50 ms later" onClick={() => props.onAlign({ offset: a.offset + 0.05 })}>+</button>
          </div>
          <Slider label="Tempo" value={a.ratio} min={o.auto.ratio * 0.95} max={o.auto.ratio * 1.05} onChange={(v) => props.onRatio(Math.round(v * 2000) / 2000)} format={(v) => `${v >= 1 ? "+" : ""}${((v - 1) * 100).toFixed(1)}%`} />
          <div className="k-octave">
            <span>Transpose</span>
            <button aria-label="Transpose down" onClick={() => props.onAlign({ transpose: a.transpose - 1 })}>−</button>
            <output>{a.transpose > 0 ? `+${a.transpose}` : a.transpose}</output>
            <button aria-label="Transpose up" onClick={() => props.onAlign({ transpose: a.transpose + 1 })}>+</button>
            <button className="k-auto" onClick={props.onAuto}>
              Auto-align
            </button>
          </div>
        </>
      )}
    </div>
  );
}
