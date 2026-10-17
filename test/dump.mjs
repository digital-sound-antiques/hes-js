// What a HES file actually contains: header, MMU setup, and where its blocks
// land in the 21-bit physical space.
//
//   node test/dump.mjs <file.hes>

import { readFileSync } from "node:fs";
import { parseHES } from "../dist/index.js";

const file = parseHES(new Uint8Array(readFileSync(process.argv[2])));
const hex = (v, n = 2) => "$" + v.toString(16).toUpperCase().padStart(n, "0");
console.log(`version=${file.version} startSong=${file.startSong} request=${hex(file.requestAddress, 4)}`);
console.log(
  "MPR: " +
    [...file.mpr]
      .map((b, i) => `${i}:${hex(b)}→${hex(i * 0x2000, 4)}`)
      .join("  ")
);
let total = 0;
for (const b of file.blocks) {
  total += b.data.length;
  const bank = b.physicalAddress >> 13;
  console.log(
    `block: physical ${hex(b.physicalAddress, 6)} (bank ${hex(bank)}) ${b.data.length} bytes` +
      ` → banks ${hex(bank)}..${hex((b.physicalAddress + b.data.length - 1) >> 13)}`
  );
}
console.log(`${file.blocks.length} block(s), ${total} bytes total`);
