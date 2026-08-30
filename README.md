# hes-js

PC Engine / TurboGrafx-16 sound file (`.hes`) player library for JavaScript,
written from scratch in TypeScript. No WebAssembly, no native dependencies.

Everything here is implemented from published hardware documentation. No code is
derived from any other emulator.

## What it does

- **HuC6280 core** with cycle counting: a 65C02 with Hudson's additions - the
  MMU reached through TAM/TMA, the block transfer instructions, the register
  swaps, the switchable clock, and the T flag. Zero page and stack sit at $2000
  and $2100, and decimal mode works.
- **PSG**: six wavetable channels in stereo, each playing a 32-step 5-bit
  waveform, with direct D/A, noise on the last two channels and an LFO on the
  first two. Volume and balance are logarithmic and additive, 1.5 dB a step.
- **The machine around them**: RAM, the memory mapper, the timer and the
  interrupt controller, with both the timer and the display's vertical blank
  driving playback - a HES file has no play address, so its driver installs an
  interrupt handler and the player supplies the interrupts.
- **Band-limited stereo output** at any sample rate, through an independent
  chain per side.
- **Exact state snapshots** for instant seeking.
- **Per-channel output** for visualisation.

Not implemented: the CD-ROM² hardware, so a rip that expects ADPCM or CD audio
will not sound like the original.

## Usage

```js
import { HESPlayer, parseHES } from "hes-js";

const file = parseHES(new Uint8Array(hesBytes));
const player = new HESPlayer({ sampleRate: 44100 });
player.load(file, 0x3d); // track number, as the .m3u names it

const left = new Int16Array(4096);
const right = new Int16Array(4096);
player.renderInto(left, right, 0, 4096);
```

`skip(count)` advances without producing audio, for seeking and for running a
scanner ahead of the play head. `saveState()` / `restoreState()` carry the whole
machine. `getChannelStatus(i)` reports what each channel is doing.

## Development

```
npm install
npm run build

node test/cpu.mjs                                              # the CPU's own instructions
node test/render.mjs <file.hes> [track] [seconds] [out.wav]    # listen to it
node test/dump.mjs   <file.hes>                                # what the container holds
node test/batch.mjs  <dir> [seconds]                           # every track of every file
```

Track numbers may be given in hex (`0x3d`), matching how `.m3u` playlists write
them.

## Status

Early development. Plays what it has been tested against; the timing details
that only some drivers exercise have not all been verified against hardware.

## License

ISC. See LICENSE.md.
