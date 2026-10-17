// Render an NSF to a WAV file. The point of this script is ears: statistics
// hide the bugs that are obvious the moment you listen.
//
//   node test/render.mjs <file.nsf> [track] [seconds] [out.wav]

import { readFileSync, writeFileSync } from "node:fs";
import { HESPlayer, parseHES } from "../dist/index.js";

const [, , path, trackArg, secondsArg, outArg] = process.argv;
if (!path) {
  console.error("usage: node test/render.mjs <file.hes> [track] [seconds] [out.wav]");
  process.exit(1);
}

const data = new Uint8Array(readFileSync(path));
const file = parseHES(data);
const track = trackArg != null ? Number(trackArg) : file.startSong;
const seconds = secondsArg != null ? Number(secondsArg) : 15;
const out = outArg ?? "out.wav";

console.log(
  `version=${file.version} startSong=${file.startSong} request=$${file.requestAddress.toString(16)} ` +
    `blocks=${file.blocks.length} mpr=[${[...file.mpr].map((b) => b.toString(16)).join(",")}]`
);
console.log(`track ${track}`);

const sampleRate = 44100;
const player = new HESPlayer({ sampleRate, defaultPlaySeconds: seconds, defaultFadeSeconds: 0 });
const t0 = process.hrtime.bigint();
player.load(file, track);

const total = Math.floor(seconds * sampleRate);
const left = new Int16Array(total);
const right = new Int16Array(total);
const block = 4096;
for (let at = 0; at < total; at += block) {
  player.renderInto(left, right, at, Math.min(block, total - at));
}
const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;

let peak = 0;
let sum = 0;
let silentHead = 0;
for (let i = 0; i < total; i++) {
  const v = Math.abs(left[i]);
  if (v > peak) peak = v;
  sum += v * v;
  if (peak === 0) silentHead = i;
}
const rms = Math.sqrt(sum / total);
console.log(
  `rendered ${seconds}s in ${elapsed.toFixed(2)}s (${(seconds / elapsed).toFixed(1)}x realtime) ` +
    `peak=${peak} rms=${rms.toFixed(1)} silentHead=${(silentHead / sampleRate).toFixed(3)}s`
);
console.log("channels:", JSON.stringify(player.getChannelStatusArray(), null, 0));

// 16-bit stereo WAV: the PSG pans each channel in hardware.
const header = Buffer.alloc(44);
const bytes = total * 4;
header.write("RIFF", 0);
header.writeUInt32LE(36 + bytes, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(bytes, 40);
const interleaved = new Int16Array(total * 2);
for (let i = 0; i < total; i++) {
  interleaved[i * 2] = left[i];
  interleaved[i * 2 + 1] = right[i];
}
writeFileSync(out, Buffer.concat([header, Buffer.from(interleaved.buffer)]));
console.log(`wrote ${out}`);
