# Render a Chimera performance

This offline exporter makes a 1280×720 MP4 at 25 fps. It draws the fork's full vocal tract from the same voice simulation that produces the audio, alongside word highlights and live pitch. It uses the original TypeScript voice from Chimera's history and the current anatomy renderer. Bun runs both without a browser or a Rust build.

## Run the example

From the repository root, install FFmpeg with the H.264 and AAC encoders, then run the following commands. The second checkout supplies the matching TypeScript voice, acoustic analysis model, and dictionary.

```sh
git worktree add --detach ../chimera-performance-engine 574d56c6964ba8855366c02f7e263fa22555118c
export CHIMERA_TS_ENGINE="$(cd ../chimera-performance-engine && pwd)"
(cd tools/performance && bun install)
bun tools/performance/render.mjs tools/performance/example.json out/example.mp4
```

Set `FFMPEG` to the executable's path when it is outside your shell's search path. To mix in a backing track aligned to time zero, append its path, e.g. `bun tools/performance/render.mjs score.json out/take.mp4 backing.wav`. The exporter mixes it beneath the synthesized voice: `BACKING_GAIN` sets the track's level (0.27 by default), and `VOICE_ROOM=1` adds a short echo to the voice so it sits in the same room as the track. Each render uses its own temporary directory and replaces the output once both encoding steps succeed.

## Score a passage

The score contains a title, credit, tempo in BPM, and caption lines. Each line has a section label and an array of words. All word times are seconds from the start of the video. Words must be ordered and have positive, nonoverlapping durations. Silence between words creates a phrase break.

For speech or rap, give each word its display `text`, `start`, `end`, and pitch in `hz`. A `pronunciation` override accepts a respelling or multiple words for the dictionary. Each caption line is a breath group. Use short lines for readability.

For singing, set `sung` to true on the line. Supply `notes` for each word, with one `[MIDI pitch, relative duration]` pair per syllable. Their durations divide the word's time span. A standalone `~` in the pronunciation carries a vowel to an additional note. The example includes both modes. Keep any personal scores and cover media under the gitignored `public/shows/` directory.
