// The HuC6280's own instructions, run as small programs against a flat memory
// bus. Checks what the 6502 this core grew from cannot do: the relocated zero
// page and stack, decimal mode, the 65C02 additions, Hudson's swaps, block
// transfers, the mapper instructions and the T flag.
//
//   node test/cpu.mjs

import { HuC6280 } from "../dist/index.js";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail != null ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Flat 64 KB, plus somewhere to see the mapper and video writes land. */
function machine(program, at = 0xe000) {
  const mem = new Uint8Array(0x10000);
  const mpr = new Uint8Array(8).fill(0);
  const vdc = [];
  mem.set(program, at);
  const cpu = new HuC6280({
    read: (a) => mem[a],
    write: (a, v) => { mem[a] = v; },
    setMpr: (mask, bank) => { for (let i = 0; i < 8; i++) if (mask & (1 << i)) mpr[i] = bank; },
    getMpr: (mask) => { for (let i = 0; i < 8; i++) if (mask & (1 << i)) return mpr[i]; return 0; },
    writeVdc: (port, v) => vdc.push([port, v]),
  });
  cpu.pc = at;
  cpu.s = 0xff;
  const run = (steps) => { let c = 0; for (let i = 0; i < steps; i++) c += cpu.step(); return c; };
  return { cpu, mem, mpr, vdc, run };
}

// ---- the zero page and stack are not at $0000/$0100 --------------------
{
  const m = machine([0xa9, 0x42, 0x85, 0x10]); // LDA #$42  STA $10
  m.run(2);
  check("zero page is at $2000", m.mem[0x2010] === 0x42 && m.mem[0x0010] === 0,
    `$2010=${m.mem[0x2010]} $0010=${m.mem[0x0010]}`);

  const s = machine([0xa9, 0x99, 0x48]); // LDA #$99  PHA
  s.run(2);
  check("stack is at $2100", s.mem[0x21ff] === 0x99, `$21FF=${s.mem[0x21ff]}`);
}

// ---- decimal mode works on this chip ----------------------------------
{
  const m = machine([0xf8, 0x18, 0xa9, 0x09, 0x69, 0x01]); // SED CLC LDA #$09 ADC #$01
  m.run(4);
  check("BCD add: $09 + $01 = $10", m.cpu.a === 0x10, `A=$${m.cpu.a.toString(16)}`);
  const t = machine([0xf8, 0x38, 0xa9, 0x10, 0xe9, 0x01]); // SED SEC LDA #$10 SBC #$01
  t.run(4);
  check("BCD subtract: $10 - $01 = $09", t.cpu.a === 0x09, `A=$${t.cpu.a.toString(16)}`);
}

// ---- 65C02 additions ---------------------------------------------------
{
  const m = machine([0x80, 0x02, 0xa9, 0xff, 0xa9, 0x11]); // BRA +2, (skipped), LDA #$11
  m.run(2);
  check("BRA skips over the next instruction", m.cpu.a === 0x11, `A=$${m.cpu.a.toString(16)}`);

  const i = machine([0xa9, 0x7f, 0x1a, 0x3a, 0x3a]); // LDA #$7F INC A DEC A DEC A
  i.run(4);
  check("INC A / DEC A", i.cpu.a === 0x7e, `A=$${i.cpu.a.toString(16)}`);

  const z = machine([0xa9, 0xff, 0x85, 0x20, 0x64, 0x20]); // LDA #$FF STA $20 STZ $20
  z.run(3);
  check("STZ zeroes memory", z.mem[0x2020] === 0);

  const p = machine([0xa2, 0x33, 0xa0, 0x44, 0xda, 0x5a, 0xfa, 0x7a]); // LDX/LDY, PHX PHY PLX PLY
  p.run(6);
  check("PHX/PHY/PLX/PLY swap through the stack", p.cpu.x === 0x44 && p.cpu.y === 0x33,
    `X=$${p.cpu.x.toString(16)} Y=$${p.cpu.y.toString(16)}`);

  const b = machine([0xa9, 0x0f, 0x85, 0x30, 0xa9, 0xf0, 0x04, 0x30, 0x14, 0x30]);
  // LDA #$0F STA $30 LDA #$F0 TSB $30 TRB $30
  b.run(5);
  check("TSB then TRB", b.mem[0x2030] === 0x0f, `$2030=$${b.mem[0x2030].toString(16)}`);
}

// ---- bit set/reset and the bit branches -------------------------------
{
  const m = machine([0xa9, 0x00, 0x85, 0x40, 0xc7, 0x40, 0x07, 0x40]);
  // LDA #$00 STA $40 SMB4 $40 RMB0 $40
  m.run(4);
  check("SMB4 sets one bit", m.mem[0x2040] === 0x10, `$2040=$${m.mem[0x2040].toString(16)}`);

  const t = machine([0xa9, 0x08, 0x85, 0x41, 0x8f, 0x41, 0x02, 0xa9, 0xbb, 0xa9, 0xcc]);
  // LDA #$08 STA $41 BBS0 $41,+2 -> not taken (bit 0 clear); LDA #$BB
  t.run(4);
  check("BBS0 not taken when the bit is clear", t.cpu.a === 0xbb, `A=$${t.cpu.a.toString(16)}`);
}

// ---- Hudson: swaps, clears, mapper, video stores ----------------------
{
  const m = machine([0xa9, 0x11, 0xa2, 0x22, 0xa0, 0x33, 0x02, 0x22, 0x42]);
  // LDA #$11 LDX #$22 LDY #$33 SXY SAX SAY
  m.run(6);
  check("SXY / SAX / SAY", m.cpu.a === 0x22 && m.cpu.x === 0x11 && m.cpu.y === 0x33,
    `A=$${m.cpu.a.toString(16)} X=$${m.cpu.x.toString(16)} Y=$${m.cpu.y.toString(16)}`);

  const c = machine([0xa9, 0xff, 0xa2, 0xff, 0xa0, 0xff, 0x62, 0x82, 0xc2]);
  c.run(6);
  check("CLA / CLX / CLY", c.cpu.a === 0 && c.cpu.x === 0 && c.cpu.y === 0);

  const t = machine([0xa9, 0x05, 0x53, 0x04, 0xa9, 0x00, 0x43, 0x04]);
  // LDA #$05 TAM #%00000100 (MPR2) LDA #$00 TMA #%00000100
  t.run(4);
  check("TAM then TMA round-trips a bank", t.mpr[2] === 5 && t.cpu.a === 5,
    `MPR2=${t.mpr[2]} A=${t.cpu.a}`);

  const v = machine([0x03, 0x07, 0x13, 0x34, 0x23, 0x12]); // ST0 #$07 ST1 #$34 ST2 #$12
  v.run(3);
  check("ST0/ST1/ST2 reach the video ports",
    JSON.stringify(v.vdc) === JSON.stringify([[0, 7], [2, 0x34], [3, 0x12]]),
    JSON.stringify(v.vdc));

  const k = machine([0x54, 0xd4]); // CSL CSH
  k.run(1);
  const slow = k.cpu.fast;
  k.run(1);
  check("CSL / CSH switch the clock", slow === false && k.cpu.fast === true);
}

// ---- block transfer ---------------------------------------------------
{
  const m = machine([0x73, 0x00, 0x30, 0x00, 0x40, 0x04, 0x00]); // TII $3000 -> $4000, 4 bytes
  for (let i = 0; i < 4; i++) m.mem[0x3000 + i] = 0xa0 + i;
  const cycles = m.run(1);
  check("TII copies a block", [...m.mem.subarray(0x4000, 0x4004)].join(",") === "160,161,162,163",
    [...m.mem.subarray(0x4000, 0x4004)].join(","));
  check("TII costs 17 + 6 per byte", cycles === 17 + 6 * 4, `${cycles} cycles`);

  const d = machine([0xc3, 0x03, 0x30, 0x03, 0x40, 0x04, 0x00]); // TDD, descending
  for (let i = 0; i < 4; i++) d.mem[0x3000 + i] = 0xb0 + i;
  d.run(1);
  check("TDD copies backwards", [...d.mem.subarray(0x4000, 0x4004)].join(",") === "176,177,178,179",
    [...d.mem.subarray(0x4000, 0x4004)].join(","));

  const n = machine([0xd3, 0x00, 0x30, 0x00, 0x40, 0x04, 0x00]); // TIN, fixed destination
  for (let i = 0; i < 4; i++) n.mem[0x3000 + i] = 0xc0 + i;
  n.run(1);
  check("TIN holds the destination", n.mem[0x4000] === 0xc3 && n.mem[0x4001] === 0,
    `$4000=$${n.mem[0x4000].toString(16)}`);

  const a = machine([0xe3, 0x00, 0x30, 0x00, 0x40, 0x04, 0x00]); // TIA, alternating destination
  for (let i = 0; i < 4; i++) a.mem[0x3000 + i] = 0xd0 + i;
  a.run(1);
  check("TIA alternates the destination", a.mem[0x4000] === 0xd2 && a.mem[0x4001] === 0xd3,
    `$4000=$${a.mem[0x4000].toString(16)} $4001=$${a.mem[0x4001].toString(16)}`);
}

// ---- the T flag ------------------------------------------------------
{
  const m = machine([0xa2, 0x50, 0xa9, 0x00, 0xf4, 0x69, 0x07]);
  // LDX #$50  LDA #$00  SET  ADC #$07   -> adds to $2050, not to A
  m.mem[0x2050] = 0x10;
  m.run(4);
  check("SET makes ADC work on the zero page", m.mem[0x2050] === 0x17 && m.cpu.a === 0x00,
    `$2050=$${m.mem[0x2050].toString(16)} A=$${m.cpu.a.toString(16)}`);

  const o = machine([0xa2, 0x51, 0xa9, 0x00, 0xf4, 0x09, 0x0f, 0x09, 0xf0]);
  // SET applies to one instruction only: the second ORA goes to A
  o.mem[0x2051] = 0x00;
  o.run(5);
  check("SET applies to exactly one instruction",
    o.mem[0x2051] === 0x0f && o.cpu.a === 0xf0,
    `$2051=$${o.mem[0x2051].toString(16)} A=$${o.cpu.a.toString(16)}`);
}

console.log(failures === 0 ? "\nall HuC6280 checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
