/**
 * HES container parsing.
 *
 * A rip of PC Engine music: a few blocks of memory image, the eight MMU
 * mappings the machine should start with, and one entry point. There is no play
 * address the way an NSF has one - a PC Engine driver installs its own timer or
 * VBlank interrupt handler and runs from there, so the player's job is to set up
 * memory, call the entry point once per track, and then keep the interrupts
 * coming.
 *
 * Layout as specified by Mamiya (2000):
 *
 *   header
 *     $00  4  'HESM'
 *     $04  1  version
 *     $05  1  start song
 *     $06  2  request address (logical)
 *     $08  8  initial MPR0-7
 *   chunks, from $10
 *     $00  4  'DATA'
 *     $04  4  size
 *     $08  4  load address (physical)
 *     $0C  4  reserved
 *     $10  n  data
 */

const MAGIC = [0x48, 0x45, 0x53, 0x4d]; // "HESM"

/** One block of the memory image, placed by physical address. */
export interface HESBlock {
  /** 21-bit physical address; the MMU maps 8 KB pages of this space. */
  physicalAddress: number;
  data: Uint8Array;
}

export interface HESFile {
  version: number;
  /**
   * Track the file wants played first, as the header states it. Taken at face
   * value: unlike NSF's one-based field, this one is handed to the driver as it
   * stands.
   */
  startSong: number;
  /** Entry point, in the CPU's 64 KB logical space, called once per track. */
  requestAddress: number;
  /** The eight MMU mappings to install before entry; each is a physical bank. */
  mpr: Uint8Array;
  blocks: HESBlock[];
}

function hasMagic(data: Uint8Array): boolean {
  if (data.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (data[i] !== MAGIC[i]) return false;
  return true;
}

export function isHESFile(data: Uint8Array): boolean {
  return hasMagic(data);
}

function u16(data: Uint8Array, at: number): number {
  return data[at] | (data[at + 1] << 8);
}

function u32(data: Uint8Array, at: number): number {
  return (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
}

export function parseHES(data: Uint8Array): HESFile {
  if (!hasMagic(data)) throw new Error("not a HES file");
  if (data.length < 0x10) throw new Error("hes: file is shorter than its header");

  const file: HESFile = {
    version: data[4],
    startSong: data[5],
    requestAddress: u16(data, 6),
    mpr: data.slice(8, 16),
    blocks: [],
  };

  let at = 0x10;
  while (at + 16 <= data.length) {
    const id = String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
    if (id !== "DATA") break; // the format defines no other chunk; stop rather than guess
    const size = u32(data, at + 4);
    const physicalAddress = u32(data, at + 8);
    const start = at + 16;
    const end = Math.min(start + size, data.length);
    if (end > start) file.blocks.push({ physicalAddress, data: data.slice(start, end) });
    at = start + size;
  }

  if (file.blocks.length === 0) throw new Error("hes: no DATA chunk");
  return file;
}
