// Fingerprint the player's output across a matrix of files, tracks, rates and
// code paths.
//
//   node test/hash.mjs [fingerprints.json]
//
// With no argument it prints the fingerprints; with one it compares against that
// file (writing it if absent) and exits non-zero on any difference. Optimisation
// work is expected to change nothing that comes out, so a difference here is a
// bug until shown otherwise.
//
// The cycle counts are compared loosely: a render may run the machine a little
// past the samples asked for and keep the surplus for the next call, so the
// count at any given moment is not fixed - only its rate is.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { HESPlayer, parseHES } from "../dist/index.js";

const T = "/Users/okazaki/dev/dsa/testdata/hes";

// The three drivers are built differently - one runs off the display, one off
// the timer at 7 kHz, one off the display with long stretches of interrupts
// masked - so between them they cover the paths that matter.
const cases = [
  { name: "bomberman-t0", path: `${T}/Bomberman/HC90036.hes`, track: 0x00, seconds: 6, rate: 44100 },
  { name: "bomberman-t5", path: `${T}/Bomberman/HC90036.hes`, track: 0x05, seconds: 4, rate: 44100 },
  { name: "bomberman-48k", path: `${T}/Bomberman/HC90036.hes`, track: 0x00, seconds: 3, rate: 48000 },
  { name: "sss-t26", path: `${T}/Super Star Soldier/HE-1097.hes`, track: 0x26, seconds: 6, rate: 44100 },
  { name: "sss-t01", path: `${T}/Super Star Soldier/HE-1097.hes`, track: 0x01, seconds: 4, rate: 44100 },
  { name: "blade-t3d", path: `${T}/Soldier Blade/HC92056.hes`, track: 0x3d, seconds: 6, rate: 44100 },
  { name: "blade-t56", path: `${T}/Soldier Blade/HC92056.hes`, track: 0x56, seconds: 5, rate: 44100 },
  { name: "tgx-t26", path: `${T}/Super Star Soldier/TGX040052.hes`, track: 0x26, seconds: 4, rate: 44100 },
];

const hash = (...buffers) => {
  const h = createHash("sha1");
  for (const b of buffers) h.update(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
  return h.digest("hex").slice(0, 16);
};

const results = {};
for (const c of cases) {
  const file = parseHES(new Uint8Array(readFileSync(c.path)));
  const frames = Math.floor(c.seconds * c.rate);
  const opts = { sampleRate: c.rate, defaultPlaySeconds: 600, defaultFadeSeconds: 0 };

  // plain render, in awkward block sizes so chunk boundaries are exercised
  const p = new HESPlayer(opts);
  p.load(file, c.track);
  p.channelCaptureEnabled = true;
  const l = new Int16Array(frames);
  const r = new Int16Array(frames);
  const caps = [];
  let at = 0;
  for (const step of cycle([1000, 4096, 37, 5512])) {
    if (at >= frames) break;
    const n = Math.min(step, frames - at);
    p.renderInto(l, r, at, n);
    caps.push(p.channelCapture.slice(0, p.channelCaptureLength * 6));
    at += n;
  }
  results[`${c.name}/mix`] = hash(l, r);
  results[`${c.name}/perch`] = hash(...caps);

  // skip to the middle, then render: must match the same span of the plain run
  const half = Math.floor(frames / 2);
  const p2 = new HESPlayer(opts);
  p2.load(file, c.track);
  p2.skip(half);
  const l2 = new Int16Array(frames - half);
  const r2 = new Int16Array(frames - half);
  p2.renderInto(l2, r2, 0, frames - half);
  results[`${c.name}/skip`] = hash(l2, r2);
  results[`${c.name}/skip-matches-plain`] = String(
    hash(l.subarray(half), r.subarray(half)) === hash(l2, r2)
  );

  // state saved by one instance, restored into another
  const p3 = new HESPlayer(opts);
  p3.load(file, c.track);
  p3.skip(half);
  const state = p3.saveState();
  const p4 = new HESPlayer(opts);
  p4.load(file, c.track);
  p4.restoreState(state);
  const l4 = new Int16Array(frames - half);
  const r4 = new Int16Array(frames - half);
  p4.renderInto(l4, r4, 0, frames - half);
  results[`${c.name}/state`] = hash(l4, r4);
  results[`${c.name}/clocks`] = String(p.clockCount);
}

function* cycle(list) {
  for (let i = 0; ; i++) yield list[i % list.length];
}

const baselinePath = process.argv[2];
if (baselinePath == null) {
  console.log(JSON.stringify(results, null, 2));
} else if (!existsSync(baselinePath)) {
  writeFileSync(baselinePath, JSON.stringify(results, null, 2));
  console.log(`wrote baseline ${baselinePath} (${Object.keys(results).length} fingerprints)`);
} else {
  const base = JSON.parse(readFileSync(baselinePath, "utf8"));
  const CYCLE_SLACK = 4096;
  let bad = 0;
  for (const key of Object.keys(results)) {
    if (base[key] === results[key]) continue;
    if (key.endsWith("/clocks")) {
      const drift = Math.abs(Number(results[key]) - Number(base[key]));
      if (drift <= CYCLE_SLACK) continue;
      console.log(`DRIFT ${key}: ${base[key]} -> ${results[key]}`);
      bad++;
      continue;
    }
    console.log(`DIFF ${key}: ${base[key]} -> ${results[key]}`);
    bad++;
  }
  for (const key of Object.keys(base)) if (!(key in results)) console.log(`MISSING ${key}`);
  console.log(bad === 0 ? `all ${Object.keys(results).length} fingerprints match` : `${bad} differ`);
  process.exit(bad === 0 ? 0 : 1);
}
