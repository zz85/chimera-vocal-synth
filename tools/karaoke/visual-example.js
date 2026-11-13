// A visual of your own for the karaoke page: copy this file, change it, and either pick it
// with "Load a visual..." on the page, or put it under public/shows/karaoke/visuals/ and name
// it in songs.json for its song: { "file": "...", "visual": "visuals/my-song.js" }.
//
// The default export is a visual: `create(g, host)` gets a 2D canvas context and the host
// (src/karaoke/visuals/types.ts), and returns `frame(dt, w, h)`, called each frame.
// host: time(), playing(), duration, song, backing, level(), spectrum(), sampleRate,
//       voices() [{ f0, voicing, rms }], sung() [{ part, syllable, word, line, key }],
//       hits() (the backing's notes that started since the last frame), colors.

export default {
  id: "example",
  name: "Example: pitch trail",
  create(g, host) {
    const trail = [];
    return {
      frame(dt, w, h) {
        // fade the last frame
        g.fillStyle = "rgba(0,0,0,0.15)";
        g.fillRect(0, 0, w, h);
        // each voice's pitch as a dot, its trail scrolling left
        const v = host.voices()[0];
        if (v && v.voicing > 0.5) trail.push({ x: w, y: h - (Math.log2(v.f0 / 60) / 4) * h, r: 2 + v.rms * 30 });
        for (const p of trail) p.x -= dt * 120;
        while (trail.length && trail[0].x < 0) trail.shift();
        g.fillStyle = host.colors[0];
        for (const p of trail) {
          g.beginPath();
          g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          g.fill();
        }
        // a flash on each drum hit
        if (host.hits().some((n) => n.ch === 9)) {
          g.fillStyle = "rgba(255,179,64,0.25)";
          g.fillRect(0, 0, w, h);
        }
        const s = host.sung()[0];
        if (s) {
          g.fillStyle = "#eef6f8";
          g.font = "20px system-ui";
          g.fillText(s.word, 12, 30);
        }
      },
    };
  },
};
