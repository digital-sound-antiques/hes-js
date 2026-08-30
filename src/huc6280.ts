/**
 * Hudson HuC6280 core, cycle-counting, written from the published instruction
 * set.
 *
 * A 65C02 with Hudson's additions, so three things differ from the 6502 this
 * started as: the undocumented NMOS opcodes are gone and their slots carry real
 * instructions; decimal mode works; and the zero page and stack are not at page
 * zero and one but at $2000 and $2100, which is why every HES file maps RAM to
 * MPR1.
 *
 * What the chip adds beyond the 65C02: an MMU (eight mappings of 8 KB, reached
 * with TAM/TMA), block transfer instructions that move memory without a loop,
 * a switchable clock (CSL/CSH), register swaps, and the T flag - a mode where
 * arithmetic works on a zero-page byte instead of the accumulator.
 *
 * Timing granularity is one instruction: `step()` performs a whole instruction
 * and returns the cycles it took. Those are CPU cycles, which are master clocks
 * divided by three in fast mode and by twelve in slow mode; `fast` says which,
 * and the caller converts.
 */

export interface HuC6280Bus {
  /** Logical (16-bit) read, mapped through the MMU by the bus. */
  read(addr: number): number;
  write(addr: number, value: number): void;
  /** TAM: install `bank` in every mapping register the mask selects. */
  setMpr(mask: number, bank: number): void;
  /** TMA: the bank in the lowest mapping register the mask selects. */
  getMpr(mask: number): number;
  /** ST0/ST1/ST2: a write straight to a video controller register. */
  writeVdc(port: number, value: number): void;
}

/**
 * Cycles each opcode takes with no penalty applied. Page-crossing reads and
 * taken branches add to these; read-modify-write and store forms already
 * include the cycle the real chip always spends on them.
 */
const BASE_CYCLES = /* prettier-ignore */ new Uint8Array([
  8, 7, 3, 4, 6, 4, 6, 7, 3, 2, 2, 2, 7, 5, 6, 6, // 0x
  2, 7, 7, 4, 6, 4, 6, 7, 2, 5, 2, 2, 7, 5, 7, 6, // 1x
  7, 7, 3, 4, 4, 4, 6, 7, 4, 2, 2, 2, 5, 5, 6, 6, // 2x
  2, 7, 7, 2, 4, 4, 6, 7, 2, 5, 2, 2, 5, 5, 7, 6, // 3x
  7, 7, 3, 5, 8, 4, 6, 7, 3, 2, 2, 2, 4, 5, 6, 6, // 4x
  2, 7, 7, 5, 3, 4, 6, 7, 2, 5, 3, 2, 2, 5, 7, 6, // 5x
  7, 7, 2, 17, 4, 4, 6, 7, 4, 2, 2, 2, 7, 5, 6, 6, // 6x
  2, 7, 7, 17, 4, 4, 6, 7, 2, 5, 4, 2, 7, 5, 7, 6, // 7x
  4, 7, 2, 7, 4, 4, 4, 7, 2, 2, 2, 2, 5, 5, 5, 6, // 8x
  2, 7, 7, 8, 4, 4, 4, 7, 2, 5, 2, 2, 5, 5, 5, 6, // 9x
  2, 7, 2, 7, 4, 4, 4, 7, 2, 2, 2, 2, 5, 5, 5, 6, // Ax
  2, 7, 7, 8, 4, 4, 4, 7, 2, 5, 2, 2, 5, 5, 5, 6, // Bx
  2, 7, 2, 17, 4, 4, 6, 7, 2, 2, 2, 2, 5, 5, 6, 6, // Cx
  2, 7, 7, 17, 3, 4, 6, 7, 2, 5, 3, 2, 2, 5, 7, 6, // Dx
  2, 7, 2, 17, 4, 4, 6, 7, 2, 2, 2, 2, 5, 5, 6, 6, // Ex
  2, 7, 7, 17, 2, 4, 6, 7, 2, 5, 4, 2, 2, 5, 7, 6, // Fx
]);

/**
 * Cycles the T flag adds: with it set, an arithmetic instruction reads and
 * writes a zero-page byte on top of everything else it does.
 */
const T_FLAG_CYCLES = 3;

/** Cycles per byte moved by a block transfer, on top of its 17-cycle setup. */
const BLOCK_CYCLES_PER_BYTE = 6;

/**
 * Base of the zero page. The 6502's first page is I/O on this machine, so the
 * chip's short addressing modes reach $2000-$20FF instead - RAM, in every
 * sensible memory map.
 */
const ZP_BASE = 0x2000;

/** Base of the stack page, for the same reason. */
const STACK_BASE = 0x2100;

export interface HuC6280State {
  a: number;
  x: number;
  y: number;
  s: number;
  pc: number;
  p: number;
  fast: boolean;
  tFlag: boolean;
}

export class HuC6280 {
  private bus: HuC6280Bus;

  a = 0;
  x = 0;
  y = 0;
  /** Stack pointer, low byte of $01xx. */
  s = 0xfd;
  pc = 0;

  // Status bits, each held as 0 or 1.
  fc = 0;
  fz = 0;
  fi = 1;
  fd = 0;
  fv = 0;
  fn = 0;

  /**
   * Clock select. CSH runs the core at a third of the master clock, CSL at a
   * twelfth; the cycle counts this returns are in whichever is current, so the
   * caller converts before advancing anything else.
   */
  fast = true;

  /**
   * Set by SET, consumed by the next arithmetic instruction, which then works
   * on the zero-page byte X points at instead of the accumulator.
   */
  tFlag = false;

  /** Edge-triggered NMI, latched until taken. */
  nmiPending = false;
  /** Level-triggered IRQ: whatever the devices currently assert. */
  irqLine = false;
  /**
   * Vector for the interrupt `irqLine` stands for.
   *
   * This chip gives its three interrupt sources a vector each rather than
   * sharing one, so the controller picks which is being asked for and the CPU
   * takes it. $FFF6 is the external line (and BRK), $FFF8 the display, $FFFA
   * the timer.
   */
  irqVector = 0xfff8;

  /**
   * Set by the step that actually entered an interrupt handler.
   *
   * A request the CPU is masking is not taken, and a caller that clears the
   * source anyway loses that interrupt: the driver never sees it, and its music
   * skips a frame. So the source is cleared on the strength of this rather than
   * on the request having been made.
   */
  irqTaken = false;

  /** Cycles owed to DMA, paid at the start of the next instruction. */
  private stallCycles = 0;
  /** Penalty cycles accumulated by the instruction in flight. */
  private extra = 0;

  constructor(bus: HuC6280Bus) {
    this.bus = bus;
  }

  reset(): void {
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.s = 0xfd;
    this.fc = 0;
    this.fz = 0;
    this.fi = 1;
    this.fd = 0;
    this.fv = 0;
    this.fn = 0;
    this.fast = true;
    this.tFlag = false;
    this.nmiPending = false;
    this.irqLine = false;
    this.stallCycles = 0;
    this.pc = this.rd16(0xfffc);
  }

  /** Steal `n` cycles from the CPU, as the DMC's DMA unit does. */
  stall(n: number): void {
    this.stallCycles += n;
  }

  get p(): number {
    return (
      this.fc | (this.fz << 1) | (this.fi << 2) | (this.fd << 3) | 0x20 | (this.fv << 6) | (this.fn << 7)
    );
  }

  set p(v: number) {
    this.fc = v & 1;
    this.fz = (v >> 1) & 1;
    this.fi = (v >> 2) & 1;
    this.fd = (v >> 3) & 1;
    this.fv = (v >> 6) & 1;
    this.fn = (v >> 7) & 1;
  }

  saveState(): HuC6280State {
    return {
      a: this.a,
      x: this.x,
      y: this.y,
      s: this.s,
      pc: this.pc,
      p: this.p,
      fast: this.fast,
      tFlag: this.tFlag,
    };
  }

  loadState(st: HuC6280State): void {
    this.a = st.a;
    this.x = st.x;
    this.y = st.y;
    this.s = st.s;
    this.pc = st.pc;
    this.p = st.p;
    this.fast = st.fast;
    this.tFlag = st.tFlag;
  }

  // --- bus helpers -------------------------------------------------------

  private rd(addr: number): number {
    return this.bus.read(addr & 0xffff) & 0xff;
  }

  private wr(addr: number, value: number): void {
    this.bus.write(addr & 0xffff, value & 0xff);
  }

  private rd16(addr: number): number {
    return this.rd(addr) | (this.rd(addr + 1) << 8);
  }

  private fetch(): number {
    const v = this.rd(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private push(v: number): void {
    this.wr(STACK_BASE | this.s, v);
    this.s = (this.s - 1) & 0xff;
  }

  /** Push a 16-bit value, high byte first, as the interrupt sequence does. */
  push2(value: number): void {
    this.push((value >> 8) & 0xff);
    this.push(value & 0xff);
  }

  private pop(): number {
    this.s = (this.s + 1) & 0xff;
    return this.rd(STACK_BASE | this.s);
  }

  // --- addressing --------------------------------------------------------

  private zp(): number {
    return ZP_BASE | this.fetch();
  }

  private zpx(): number {
    return ZP_BASE | ((this.fetch() + this.x) & 0xff);
  }

  private zpy(): number {
    return ZP_BASE | ((this.fetch() + this.y) & 0xff);
  }

  private abs(): number {
    return this.fetch() | (this.fetch() << 8);
  }

  /** `pen` is set for read-only forms, which pay a cycle when the index
   *  carries into a new page; stores and RMWs pay it unconditionally and have
   *  it folded into BASE_CYCLES. */
  private absx(pen: boolean): number {
    const base = this.abs();
    const addr = (base + this.x) & 0xffff;
    if (pen && (base & 0xff00) !== (addr & 0xff00)) this.extra++;
    return addr;
  }

  private absy(pen: boolean): number {
    const base = this.abs();
    const addr = (base + this.y) & 0xffff;
    if (pen && (base & 0xff00) !== (addr & 0xff00)) this.extra++;
    return addr;
  }

  /** (zp,X): the pointer is fetched from the zero page and wraps within it. */
  private indx(): number {
    const p = (this.fetch() + this.x) & 0xff;
    return this.rd(ZP_BASE | p) | (this.rd(ZP_BASE | ((p + 1) & 0xff)) << 8);
  }

  /** (zp),Y */
  private indy(pen: boolean): number {
    const p = this.fetch();
    const base = this.rd(ZP_BASE | p) | (this.rd(ZP_BASE | ((p + 1) & 0xff)) << 8);
    const addr = (base + this.y) & 0xffff;
    if (pen && (base & 0xff00) !== (addr & 0xff00)) this.extra++;
    return addr;
  }

  /** (zp): the 65C02's indirect mode, without an index. */
  private ind(): number {
    const p = this.fetch();
    return this.rd(ZP_BASE | p) | (this.rd(ZP_BASE | ((p + 1) & 0xff)) << 8);
  }

  // --- flag helpers ------------------------------------------------------

  private setNZ(v: number): number {
    const b = v & 0xff;
    this.fz = b === 0 ? 1 : 0;
    this.fn = b >> 7;
    return b;
  }

  private branch(take: boolean): void {
    const off = (this.fetch() << 24) >> 24; // sign-extend
    if (!take) return;
    const target = (this.pc + off) & 0xffff;
    this.extra += (this.pc & 0xff00) !== (target & 0xff00) ? 2 : 1;
    this.pc = target;
  }

  /**
   * The arithmetic instructions, with the T flag honoured: when it is set the
   * left operand is the zero-page byte X points at, and the result goes back
   * there rather than into the accumulator.
   */
  private aluOr(t: boolean, v: number): void {
    if (!t) {
      this.a = this.setNZ(this.a | v);
      return;
    }
    const addr = ZP_BASE | this.x;
    this.wr(addr, this.setNZ(this.rd(addr) | v));
  }

  private aluAnd(t: boolean, v: number): void {
    if (!t) {
      this.a = this.setNZ(this.a & v);
      return;
    }
    const addr = ZP_BASE | this.x;
    this.wr(addr, this.setNZ(this.rd(addr) & v));
  }

  private aluEor(t: boolean, v: number): void {
    if (!t) {
      this.a = this.setNZ(this.a ^ v);
      return;
    }
    const addr = ZP_BASE | this.x;
    this.wr(addr, this.setNZ(this.rd(addr) ^ v));
  }

  /** Borrowing the accumulator keeps the carry and overflow rules in one place. */
  private aluAdc(t: boolean, v: number): void {
    if (!t) {
      this.adc(v);
      return;
    }
    const addr = ZP_BASE | this.x;
    const save = this.a;
    this.a = this.rd(addr);
    this.adc(v);
    this.wr(addr, this.a);
    this.a = save;
  }

  private aluSbc(t: boolean, v: number): void {
    if (!t) {
      this.sbc(v);
      return;
    }
    const addr = ZP_BASE | this.x;
    const save = this.a;
    this.a = this.rd(addr);
    this.sbc(v);
    this.wr(addr, this.a);
    this.a = save;
  }

  /**
   * Block transfer: seven bytes of instruction move up to 64 KB with no loop in
   * the program. `srcStep` and `dstStep` are 1 forward, -1 back, 0 fixed, or 2
   * for alternating between two addresses - which is how a word-wide port is
   * fed.
   */
  private block(srcStep: number, dstStep: number): void {
    const src0 = this.fetch() | (this.fetch() << 8);
    const dst0 = this.fetch() | (this.fetch() << 8);
    let len = this.fetch() | (this.fetch() << 8);
    if (len === 0) len = 0x10000;
    let src = src0;
    let dst = dst0;
    for (let i = 0; i < len; i++) {
      const from = srcStep === 2 ? (src0 + (i & 1)) & 0xffff : src;
      const to = dstStep === 2 ? (dst0 + (i & 1)) & 0xffff : dst;
      this.wr(to, this.rd(from));
      if (srcStep === 1 || srcStep === -1) src = (src + srcStep) & 0xffff;
      if (dstStep === 1 || dstStep === -1) dst = (dst + dstStep) & 0xffff;
    }
    this.extra += len * BLOCK_CYCLES_PER_BYTE;
  }

  private adc(v: number): void {
    if (this.fd) {
      // Decimal mode works on this chip, unlike the 2A03 this core grew from.
      let lo = (this.a & 0x0f) + (v & 0x0f) + this.fc;
      let hi = (this.a >> 4) + (v >> 4);
      if (lo > 9) {
        lo -= 10;
        hi++;
      }
      this.fc = hi > 9 ? 1 : 0;
      if (hi > 9) hi -= 10;
      const r = ((hi & 0x0f) << 4) | (lo & 0x0f);
      this.fv = 0;
      this.a = this.setNZ(r);
      return;
    }
    const sum = this.a + v + this.fc;
    this.fc = sum > 0xff ? 1 : 0;
    this.fv = (~(this.a ^ v) & (this.a ^ sum) & 0x80) !== 0 ? 1 : 0;
    this.a = this.setNZ(sum);
  }

  private sbc(v: number): void {
    if (this.fd) {
      let lo = (this.a & 0x0f) - (v & 0x0f) - (1 - this.fc);
      let hi = (this.a >> 4) - (v >> 4);
      if (lo & 0x10) {
        lo += 10;
        hi--;
      }
      if (hi & 0x10) hi += 10;
      const borrow = this.a - v - (1 - this.fc);
      this.fc = borrow >= 0 ? 1 : 0;
      this.fv = 0;
      this.a = this.setNZ(((hi & 0x0f) << 4) | (lo & 0x0f));
      return;
    }
    this.adc(v ^ 0xff);
  }

  private cmp(reg: number, v: number): void {
    const d = reg - v;
    this.fc = d >= 0 ? 1 : 0;
    this.setNZ(d);
  }

  private aslMem(addr: number): number {
    const v = this.rd(addr);
    this.fc = v >> 7;
    const r = this.setNZ(v << 1);
    this.wr(addr, r);
    return r;
  }

  private lsrMem(addr: number): number {
    const v = this.rd(addr);
    this.fc = v & 1;
    const r = this.setNZ(v >> 1);
    this.wr(addr, r);
    return r;
  }

  private rolMem(addr: number): number {
    const v = this.rd(addr);
    const c = this.fc;
    this.fc = v >> 7;
    const r = this.setNZ((v << 1) | c);
    this.wr(addr, r);
    return r;
  }

  private rorMem(addr: number): number {
    const v = this.rd(addr);
    const c = this.fc;
    this.fc = v & 1;
    const r = this.setNZ((v >> 1) | (c << 7));
    this.wr(addr, r);
    return r;
  }

  // --- interrupts --------------------------------------------------------

  private interrupt(vector: number, brk: boolean): void {
    if (brk) this.pc = (this.pc + 1) & 0xffff;
    this.push(this.pc >> 8);
    this.push(this.pc & 0xff);
    this.push(brk ? this.p | 0x10 : this.p);
    this.fi = 1;
    // Decimal mode is cleared on entry, unlike the NMOS part.
    this.fd = 0;
    this.pc = this.rd16(vector);
  }

  /**
   * Execute one instruction, or take a pending interrupt.
   *
   * Returns the cycles consumed, including any DMA stall paid off here. A
   * jammed CPU reports cycles passing without doing anything, so a caller
   * driving the APU by CPU cycles keeps producing sound.
   */
  step(): number {
    const stall = this.stallCycles;
    this.stallCycles = 0;
    this.irqTaken = false;

    if (this.nmiPending) {
      this.nmiPending = false;
      this.interrupt(0xfffa, false);
      return stall + 7;
    }
    if (this.irqLine && this.fi === 0) {
      this.irqTaken = true;
      this.interrupt(this.irqVector, false);
      return stall + 7;
    }

    this.irqTaken = false;
    this.extra = 0;
    // SET applies to exactly one instruction, whatever it turns out to be.
    const t = this.tFlag;
    this.tFlag = false;
    const op = this.fetch();
    let addr = 0;
    let v = 0;

    switch (op) {
      // --- load / store ---
      case 0xa9: this.a = this.setNZ(this.fetch()); break;                       // LDA #
      case 0xa5: this.a = this.setNZ(this.rd(this.zp())); break;
      case 0xb5: this.a = this.setNZ(this.rd(this.zpx())); break;
      case 0xad: this.a = this.setNZ(this.rd(this.abs())); break;
      case 0xbd: this.a = this.setNZ(this.rd(this.absx(true))); break;
      case 0xb9: this.a = this.setNZ(this.rd(this.absy(true))); break;
      case 0xa1: this.a = this.setNZ(this.rd(this.indx())); break;
      case 0xb1: this.a = this.setNZ(this.rd(this.indy(true))); break;

      case 0xa2: this.x = this.setNZ(this.fetch()); break;                       // LDX #
      case 0xa6: this.x = this.setNZ(this.rd(this.zp())); break;
      case 0xb6: this.x = this.setNZ(this.rd(this.zpy())); break;
      case 0xae: this.x = this.setNZ(this.rd(this.abs())); break;
      case 0xbe: this.x = this.setNZ(this.rd(this.absy(true))); break;

      case 0xa0: this.y = this.setNZ(this.fetch()); break;                       // LDY #
      case 0xa4: this.y = this.setNZ(this.rd(this.zp())); break;
      case 0xb4: this.y = this.setNZ(this.rd(this.zpx())); break;
      case 0xac: this.y = this.setNZ(this.rd(this.abs())); break;
      case 0xbc: this.y = this.setNZ(this.rd(this.absx(true))); break;

      case 0x85: this.wr(this.zp(), this.a); break;                              // STA
      case 0x95: this.wr(this.zpx(), this.a); break;
      case 0x8d: this.wr(this.abs(), this.a); break;
      case 0x9d: this.wr(this.absx(false), this.a); break;
      case 0x99: this.wr(this.absy(false), this.a); break;
      case 0x81: this.wr(this.indx(), this.a); break;
      case 0x91: this.wr(this.indy(false), this.a); break;

      case 0x86: this.wr(this.zp(), this.x); break;                              // STX
      case 0x96: this.wr(this.zpy(), this.x); break;
      case 0x8e: this.wr(this.abs(), this.x); break;

      case 0x84: this.wr(this.zp(), this.y); break;                              // STY
      case 0x94: this.wr(this.zpx(), this.y); break;
      case 0x8c: this.wr(this.abs(), this.y); break;

      // --- transfers ---
      case 0xaa: this.x = this.setNZ(this.a); break;                             // TAX
      case 0xa8: this.y = this.setNZ(this.a); break;                             // TAY
      case 0x8a: this.a = this.setNZ(this.x); break;                             // TXA
      case 0x98: this.a = this.setNZ(this.y); break;                             // TYA
      case 0xba: this.x = this.setNZ(this.s); break;                             // TSX
      case 0x9a: this.s = this.x; break;                                         // TXS

      // --- stack ---
      case 0x48: this.push(this.a); break;                                       // PHA
      case 0x68: this.a = this.setNZ(this.pop()); break;                         // PLA
      case 0x08: this.push(this.p | 0x10); break;                                // PHP
      case 0x28: this.p = this.pop(); break;                                     // PLP

      // --- logic ---
      case 0x29: this.aluAnd(t, this.fetch()); break;              // AND
      case 0x25: this.aluAnd(t, this.rd(this.zp())); break;
      case 0x35: this.aluAnd(t, this.rd(this.zpx())); break;
      case 0x2d: this.aluAnd(t, this.rd(this.abs())); break;
      case 0x3d: this.aluAnd(t, this.rd(this.absx(true))); break;
      case 0x39: this.aluAnd(t, this.rd(this.absy(true))); break;
      case 0x21: this.aluAnd(t, this.rd(this.indx())); break;
      case 0x31: this.aluAnd(t, this.rd(this.indy(true))); break;

      case 0x09: this.aluOr(t, this.fetch()); break;              // ORA
      case 0x05: this.aluOr(t, this.rd(this.zp())); break;
      case 0x15: this.aluOr(t, this.rd(this.zpx())); break;
      case 0x0d: this.aluOr(t, this.rd(this.abs())); break;
      case 0x1d: this.aluOr(t, this.rd(this.absx(true))); break;
      case 0x19: this.aluOr(t, this.rd(this.absy(true))); break;
      case 0x01: this.aluOr(t, this.rd(this.indx())); break;
      case 0x11: this.aluOr(t, this.rd(this.indy(true))); break;

      case 0x49: this.aluEor(t, this.fetch()); break;              // EOR
      case 0x45: this.aluEor(t, this.rd(this.zp())); break;
      case 0x55: this.aluEor(t, this.rd(this.zpx())); break;
      case 0x4d: this.aluEor(t, this.rd(this.abs())); break;
      case 0x5d: this.aluEor(t, this.rd(this.absx(true))); break;
      case 0x59: this.aluEor(t, this.rd(this.absy(true))); break;
      case 0x41: this.aluEor(t, this.rd(this.indx())); break;
      case 0x51: this.aluEor(t, this.rd(this.indy(true))); break;

      case 0x24:                                                                 // BIT
      case 0x2c: {
        v = this.rd(op === 0x24 ? this.zp() : this.abs());
        this.fz = (this.a & v) === 0 ? 1 : 0;
        this.fn = v >> 7;
        this.fv = (v >> 6) & 1;
        break;
      }

      // --- arithmetic ---
      case 0x69: this.aluAdc(t, this.fetch()); break;                                  // ADC
      case 0x65: this.aluAdc(t, this.rd(this.zp())); break;
      case 0x75: this.aluAdc(t, this.rd(this.zpx())); break;
      case 0x6d: this.aluAdc(t, this.rd(this.abs())); break;
      case 0x7d: this.aluAdc(t, this.rd(this.absx(true))); break;
      case 0x79: this.aluAdc(t, this.rd(this.absy(true))); break;
      case 0x61: this.aluAdc(t, this.rd(this.indx())); break;
      case 0x71: this.aluAdc(t, this.rd(this.indy(true))); break;

      case 0xe9: this.aluSbc(t, this.fetch()); break;                                  // SBC # (0xEB unofficial)
      case 0xe5: this.aluSbc(t, this.rd(this.zp())); break;
      case 0xf5: this.aluSbc(t, this.rd(this.zpx())); break;
      case 0xed: this.aluSbc(t, this.rd(this.abs())); break;
      case 0xfd: this.aluSbc(t, this.rd(this.absx(true))); break;
      case 0xf9: this.aluSbc(t, this.rd(this.absy(true))); break;
      case 0xe1: this.aluSbc(t, this.rd(this.indx())); break;
      case 0xf1: this.aluSbc(t, this.rd(this.indy(true))); break;

      case 0xc9: this.cmp(this.a, this.fetch()); break;                          // CMP
      case 0xc5: this.cmp(this.a, this.rd(this.zp())); break;
      case 0xd5: this.cmp(this.a, this.rd(this.zpx())); break;
      case 0xcd: this.cmp(this.a, this.rd(this.abs())); break;
      case 0xdd: this.cmp(this.a, this.rd(this.absx(true))); break;
      case 0xd9: this.cmp(this.a, this.rd(this.absy(true))); break;
      case 0xc1: this.cmp(this.a, this.rd(this.indx())); break;
      case 0xd1: this.cmp(this.a, this.rd(this.indy(true))); break;

      case 0xe0: this.cmp(this.x, this.fetch()); break;                          // CPX
      case 0xe4: this.cmp(this.x, this.rd(this.zp())); break;
      case 0xec: this.cmp(this.x, this.rd(this.abs())); break;

      case 0xc0: this.cmp(this.y, this.fetch()); break;                          // CPY
      case 0xc4: this.cmp(this.y, this.rd(this.zp())); break;
      case 0xcc: this.cmp(this.y, this.rd(this.abs())); break;

      // --- increment / decrement ---
      case 0xe6: addr = this.zp(); this.wr(addr, this.setNZ(this.rd(addr) + 1)); break;      // INC
      case 0xf6: addr = this.zpx(); this.wr(addr, this.setNZ(this.rd(addr) + 1)); break;
      case 0xee: addr = this.abs(); this.wr(addr, this.setNZ(this.rd(addr) + 1)); break;
      case 0xfe: addr = this.absx(false); this.wr(addr, this.setNZ(this.rd(addr) + 1)); break;

      case 0xc6: addr = this.zp(); this.wr(addr, this.setNZ(this.rd(addr) - 1)); break;      // DEC
      case 0xd6: addr = this.zpx(); this.wr(addr, this.setNZ(this.rd(addr) - 1)); break;
      case 0xce: addr = this.abs(); this.wr(addr, this.setNZ(this.rd(addr) - 1)); break;
      case 0xde: addr = this.absx(false); this.wr(addr, this.setNZ(this.rd(addr) - 1)); break;

      case 0xe8: this.x = this.setNZ(this.x + 1); break;                         // INX
      case 0xc8: this.y = this.setNZ(this.y + 1); break;                         // INY
      case 0xca: this.x = this.setNZ(this.x - 1); break;                         // DEX
      case 0x88: this.y = this.setNZ(this.y - 1); break;                         // DEY

      // --- shifts ---
      case 0x0a: this.fc = this.a >> 7; this.a = this.setNZ(this.a << 1); break;             // ASL A
      case 0x06: this.aslMem(this.zp()); break;
      case 0x16: this.aslMem(this.zpx()); break;
      case 0x0e: this.aslMem(this.abs()); break;
      case 0x1e: this.aslMem(this.absx(false)); break;

      case 0x4a: this.fc = this.a & 1; this.a = this.setNZ(this.a >> 1); break;              // LSR A
      case 0x46: this.lsrMem(this.zp()); break;
      case 0x56: this.lsrMem(this.zpx()); break;
      case 0x4e: this.lsrMem(this.abs()); break;
      case 0x5e: this.lsrMem(this.absx(false)); break;

      case 0x2a: {                                                               // ROL A
        const c = this.fc;
        this.fc = this.a >> 7;
        this.a = this.setNZ((this.a << 1) | c);
        break;
      }
      case 0x26: this.rolMem(this.zp()); break;
      case 0x36: this.rolMem(this.zpx()); break;
      case 0x2e: this.rolMem(this.abs()); break;
      case 0x3e: this.rolMem(this.absx(false)); break;

      case 0x6a: {                                                               // ROR A
        const c = this.fc;
        this.fc = this.a & 1;
        this.a = this.setNZ((this.a >> 1) | (c << 7));
        break;
      }
      case 0x66: this.rorMem(this.zp()); break;
      case 0x76: this.rorMem(this.zpx()); break;
      case 0x6e: this.rorMem(this.abs()); break;
      case 0x7e: this.rorMem(this.absx(false)); break;

      // --- jumps / branches ---
      case 0x4c: this.pc = this.abs(); break;                                    // JMP abs
      case 0x6c: {                                                              // JMP (ind)
        const p = this.abs();
        // No page-wrap bug here: the CMOS part fixed it.
        this.pc = this.rd(p) | (this.rd((p + 1) & 0xffff) << 8);
        break;
      }
      case 0x20: {                                                              // JSR
        const target = this.abs();
        const ret = (this.pc - 1) & 0xffff;
        this.push(ret >> 8);
        this.push(ret & 0xff);
        this.pc = target;
        break;
      }
      case 0x60: this.pc = (this.pop() | (this.pop() << 8)) + 1 & 0xffff; break; // RTS
      case 0x40: {                                                              // RTI
        this.p = this.pop();
        this.pc = this.pop() | (this.pop() << 8);
        break;
      }
      // BRK shares the external line's vector.
      case 0x00: this.interrupt(0xfff6, true); break;                            // BRK

      case 0x10: this.branch(this.fn === 0); break;                              // BPL
      case 0x30: this.branch(this.fn === 1); break;                              // BMI
      case 0x50: this.branch(this.fv === 0); break;                              // BVC
      case 0x70: this.branch(this.fv === 1); break;                              // BVS
      case 0x90: this.branch(this.fc === 0); break;                              // BCC
      case 0xb0: this.branch(this.fc === 1); break;                              // BCS
      case 0xd0: this.branch(this.fz === 0); break;                              // BNE
      case 0xf0: this.branch(this.fz === 1); break;                              // BEQ

      // --- flags ---
      case 0x18: this.fc = 0; break;                                             // CLC
      case 0x38: this.fc = 1; break;                                             // SEC
      case 0x58: this.fi = 0; break;                                             // CLI
      case 0x78: this.fi = 1; break;                                             // SEI
      case 0xb8: this.fv = 0; break;                                             // CLV
      case 0xd8: this.fd = 0; break;                                             // CLD
      case 0xf8: this.fd = 1; break;                                             // SED

      // --- 65C02 additions ---
      case 0xea: break;                                                          // NOP
      case 0x80: this.branch(true); break;                                       // BRA
      case 0x44: {                                                              // BSR
        const off = (this.fetch() << 24) >> 24;
        const ret = (this.pc - 1) & 0xffff;
        this.push2(ret);
        this.pc = (this.pc + off) & 0xffff;
        break;
      }
      case 0x5a: this.push(this.y); break;                                       // PHY
      case 0x7a: this.y = this.setNZ(this.pop()); break;                         // PLY
      case 0xda: this.push(this.x); break;                                       // PHX
      case 0xfa: this.x = this.setNZ(this.pop()); break;                         // PLX
      case 0x1a: this.a = this.setNZ(this.a + 1); break;                         // INC A
      case 0x3a: this.a = this.setNZ(this.a - 1); break;                         // DEC A
      case 0x64: this.wr(this.zp(), 0); break;                                   // STZ
      case 0x74: this.wr(this.zpx(), 0); break;
      case 0x9c: this.wr(this.abs(), 0); break;
      case 0x9e: this.wr(this.absx(false), 0); break;
      case 0x89: {                                                              // BIT #
        v = this.fetch();
        this.fz = (this.a & v) === 0 ? 1 : 0;
        break;
      }
      case 0x34:                                                                 // BIT zp,X
      case 0x3c: {                                                               // BIT abs,X
        v = this.rd(op === 0x34 ? this.zpx() : this.absx(true));
        this.fz = (this.a & v) === 0 ? 1 : 0;
        this.fn = v >> 7;
        this.fv = (v >> 6) & 1;
        break;
      }
      case 0x04:                                                                 // TSB
      case 0x0c: {
        addr = op === 0x04 ? this.zp() : this.abs();
        v = this.rd(addr);
        this.fz = (this.a & v) === 0 ? 1 : 0;
        this.fn = v >> 7;
        this.fv = (v >> 6) & 1;
        this.wr(addr, v | this.a);
        break;
      }
      case 0x14:                                                                 // TRB
      case 0x1c: {
        addr = op === 0x14 ? this.zp() : this.abs();
        v = this.rd(addr);
        this.fz = (this.a & v) === 0 ? 1 : 0;
        this.fn = v >> 7;
        this.fv = (v >> 6) & 1;
        this.wr(addr, v & ~this.a);
        break;
      }
      case 0x7c: {                                                              // JMP (abs,X)
        const p = (this.abs() + this.x) & 0xffff;
        this.pc = this.rd(p) | (this.rd((p + 1) & 0xffff) << 8);
        break;
      }

      // --- 65C02 (zp) indirect, without an index ---
      case 0x12: this.aluOr(t, this.rd(this.ind())); break;                      // ORA (zp)
      case 0x32: this.aluAnd(t, this.rd(this.ind())); break;                     // AND (zp)
      case 0x52: this.aluEor(t, this.rd(this.ind())); break;                     // EOR (zp)
      case 0x72: this.aluAdc(t, this.rd(this.ind())); break;                     // ADC (zp)
      case 0x92: this.wr(this.ind(), this.a); break;                             // STA (zp)
      case 0xb2: this.a = this.setNZ(this.rd(this.ind())); break;                // LDA (zp)
      case 0xd2: this.cmp(this.a, this.rd(this.ind())); break;                   // CMP (zp)
      case 0xf2: this.aluSbc(t, this.rd(this.ind())); break;                     // SBC (zp)

      // --- 65C02 bit set/reset and bit branches ---
      case 0x07: case 0x17: case 0x27: case 0x37:                                // RMBn zp
      case 0x47: case 0x57: case 0x67: case 0x77: {
        addr = this.zp();
        this.wr(addr, this.rd(addr) & ~(1 << (op >> 4)));
        break;
      }
      case 0x87: case 0x97: case 0xa7: case 0xb7:                                // SMBn zp
      case 0xc7: case 0xd7: case 0xe7: case 0xf7: {
        addr = this.zp();
        this.wr(addr, this.rd(addr) | (1 << ((op >> 4) - 8)));
        break;
      }
      case 0x0f: case 0x1f: case 0x2f: case 0x3f:                                // BBRn zp,rel
      case 0x4f: case 0x5f: case 0x6f: case 0x7f: {
        v = this.rd(this.zp());
        this.branch((v & (1 << (op >> 4))) === 0);
        break;
      }
      case 0x8f: case 0x9f: case 0xaf: case 0xbf:                                // BBSn zp,rel
      case 0xcf: case 0xdf: case 0xef: case 0xff: {
        v = this.rd(this.zp());
        this.branch((v & (1 << ((op >> 4) - 8))) !== 0);
        break;
      }

      // --- Hudson: register swaps and clears, no flags touched ---
      case 0x02: { const tmp = this.x; this.x = this.y; this.y = tmp; break; }    // SXY
      case 0x22: { const tmp = this.a; this.a = this.x; this.x = tmp; break; }    // SAX
      case 0x42: { const tmp = this.a; this.a = this.y; this.y = tmp; break; }    // SAY
      case 0x62: this.a = 0; break;                                              // CLA
      case 0x82: this.x = 0; break;                                              // CLX
      case 0xc2: this.y = 0; break;                                              // CLY

      // --- Hudson: the video controller stores ---
      case 0x03: this.bus.writeVdc(0, this.fetch()); break;                      // ST0
      case 0x13: this.bus.writeVdc(2, this.fetch()); break;                      // ST1
      case 0x23: this.bus.writeVdc(3, this.fetch()); break;                      // ST2

      // --- Hudson: the memory mapper ---
      case 0x53: this.bus.setMpr(this.fetch(), this.a); break;                   // TAM #mask
      case 0x43: this.a = this.setNZ(this.bus.getMpr(this.fetch())); break;      // TMA #mask

      // --- Hudson: test bits against memory without storing ---
      case 0x83: case 0x93: case 0xa3: case 0xb3: {                              // TST #imm
        const imm = this.fetch();
        addr =
          op === 0x83 ? this.zp() : op === 0x93 ? this.abs() : op === 0xa3 ? this.zpx() : this.absx(true);
        v = this.rd(addr);
        this.fz = (imm & v) === 0 ? 1 : 0;
        this.fn = v >> 7;
        this.fv = (v >> 6) & 1;
        break;
      }

      // --- Hudson: clock speed, and the T flag ---
      case 0x54: this.fast = false; break;                                       // CSL
      case 0xd4: this.fast = true; break;                                        // CSH
      case 0xf4: this.tFlag = true; break;                                       // SET

      // --- Hudson: block transfers ---
      case 0x73: this.block(1, 1); break;                                        // TII
      case 0xc3: this.block(-1, -1); break;                                      // TDD
      case 0xd3: this.block(1, 0); break;                                        // TIN
      case 0xe3: this.block(1, 2); break;                                        // TIA
      case 0xf3: this.block(2, 1); break;                                        // TAI

      // --- Everything left over does nothing. The CMOS part has no
      //     undocumented opcodes to reproduce, and no state to jam in. ---
      default:
        break;
    }

    if (t) this.extra += T_FLAG_CYCLES;
    return stall + BASE_CYCLES[op] + this.extra;
  }
}
