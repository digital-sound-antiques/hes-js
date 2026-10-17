// Every track of every HES file in a directory, briefly. Catches what only some
// tracks trigger: a driver that never starts, a track that renders silence, an
// entry routine that does not return.
//
//   node test/batch.mjs <dir> [seconds]

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HESPlayer, parseHES, isHESFile } from "../dist/index.js";

const [, , dir, secondsArg] = process.argv;
const seconds = secondsArg != null ? Number(secondsArg) : 3;
const SR = 44100;

function collect(path, out = []) {
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.hes$/i.test(name)) out.push(full);
  }
  return out;
}

/** Track numbers a companion .m3u names, so the scan covers what is playable. */
function tracksFrom(hesPath) {
  const m3u = hesPath.replace(/\.hes$/i, ".m3u");
  try {
    const lines = readFileSync(m3u, "utf8").split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      const m = line.match(/::HES,\s*\$?([0-9a-f]+)/i);
      if (m) out.push(parseInt(m[1], 16));
    }
    if (out.length) return out;
  } catch {
    /* no playlist beside it */
  }
  return [...Array(16).keys()];
}

let problems = 0;
let total = 0;
for (const path of collect(dir)) {
  const data = new Uint8Array(readFileSync(path));
  if (!isHESFile(data)) {
    console.log(`${path}: not recognised`);
    problems++;
    continue;
  }
  const file = parseHES(data);
  const tracks = tracksFrom(path);
  const silent = [];
  for (const t of tracks) {
    total++;
    try {
      const p = new HESPlayer({ sampleRate: SR, defaultPlaySeconds: seconds, defaultFadeSeconds: 0 });
      p.load(file, t);
      const n = seconds * SR;
      const l = new Int16Array(n);
      const r = new Int16Array(n);
      for (let at = 0; at < n; at += 4096) p.renderInto(l, r, at, Math.min(4096, n - at));
      let peak = 0;
      for (let i = 0; i < n; i++) {
        const v = Math.abs(l[i]) > Math.abs(r[i]) ? Math.abs(l[i]) : Math.abs(r[i]);
        if (v > peak) peak = v;
      }
      if (peak < 32) silent.push(t);
    } catch (e) {
      console.log(`${path} track ${t}: ${e.message}`);
      problems++;
    }
  }
  problems += silent.length;
  console.log(
    `${path.split("/").pop().padEnd(20)} ${String(tracks.length).padStart(3)} tracks  ` +
      (silent.length ? `silent=[${silent.map((t) => "$" + t.toString(16)).join(",")}]` : "ok")
  );
}
console.log(`\n${total} tracks, ${problems} problems`);
