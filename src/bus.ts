/**
 * The machine a HES file plays in: 8 KB of RAM, the PSG, the timer, the
 * interrupt controller, and the MMU that decides which of them the CPU can see.
 *
 * The CPU addresses 64 KB in eight 8 KB pages, and each page carries a mapping
 * register naming one of 256 physical banks. Bank $F8 is RAM and bank $FF is
 * the hardware page, where the sound chip and the timer live; the rest is the
 * file's memory image. A HES file states the eight mappings it wants, and a
 * driver moves them around as it plays.
 */

import { PSG } from "./psg.js";
import type { HuC6280Bus } from "./huc6280.js";
import type { HESFile } from "./hes-file.js";

/** Physical bank holding the machine's work RAM. */
const RAM_BANK = 0xf8;
/** Physical bank holding the hardware registers. */
const HARDWARE_BANK = 0xff;

const PAGE_SIZE = 0x2000;
const RAM_SIZE = 0x2000;

/**
 * The timer counts down once every 1024 clocks.
 *
 * Clocks, not CPU cycles: the prescaler divides the chip's clock input, so a
 * driver that switches the CPU between fast and slow with CSL/CSH does not
 * change the tempo of its own music. Counting this in CPU cycles instead makes
 * the interrupt period depend on which speed the CPU happens to be running at,
 * which is heard as a tempo that will not sit still.
 */
const TIMER_PRESCALE = 1024;

/**
 * Interrupt sources, as the controller's registers order them: bit 2 the timer,
 * bit 1 the display, bit 0 the second external line. In both the disable and
 * the status register a set bit means the same thing it names - masked off, or
 * asking to be taken.
 */
export const IRQ_TIMER = 0x04;
export const IRQ_VDC = 0x02;
export const IRQ_EXTERNAL = 0x01;

export class HESBus implements HuC6280Bus {
  readonly ram = new Uint8Array(RAM_SIZE);
  readonly psg = new PSG();

  /** Bank selected by each of the eight mapping registers. */
  readonly mpr = new Uint8Array(8);

  /** The file's image, as 8 KB banks, and which of them exist. */
  private banks: (Uint8Array | null)[] = new Array(256).fill(null);
  /** Read as zero; stands in for a bank the file never provided. */
  private readonly voidBank = new Uint8Array(PAGE_SIZE);

  // --- timer ---
  timerReload = 0;
  timerValue = 0;
  timerRunning = false;
  private timerCycles = 0;

  // --- interrupt controller ---
  /** 1 = that source is masked off. */
  irqDisable = 0;
  /** Sources currently asking to be taken. */
  irqPending = 0;

  constructor(file: HESFile) {
    for (const block of file.blocks) {
      // A block may start part way into a bank, so it is laid out byte by byte
      // rather than sliced.
      for (let i = 0; i < block.data.length; i++) {
        const physical = block.physicalAddress + i;
        const bank = (physical >> 13) & 0xff;
        let page = this.banks[bank];
        if (page == null) {
          page = new Uint8Array(PAGE_SIZE);
          this.banks[bank] = page;
        }
        page[physical & 0x1fff] = block.data[i];
      }
    }
    this.mpr.set(file.mpr);
  }

  reset(mpr: Uint8Array): void {
    this.ram.fill(0);
    this.mpr.set(mpr);
    this.timerReload = 0;
    this.timerValue = 0;
    this.timerRunning = false;
    this.timerCycles = 0;
    this.irqDisable = 0;
    this.irqPending = 0;
  }

  // --- HuC6280Bus ---

  setMpr(mask: number, bank: number): void {
    for (let i = 0; i < 8; i++) if (mask & (1 << i)) this.mpr[i] = bank & 0xff;
  }

  getMpr(mask: number): number {
    for (let i = 0; i < 8; i++) if (mask & (1 << i)) return this.mpr[i];
    return 0;
  }

  /** ST0/ST1/ST2 talk to the video controller, which a music rip has none of. */
  writeVdc(): void {
    /* no display here */
  }

  read(addr: number): number {
    const bank = this.mpr[(addr >> 13) & 7];
    const offset = addr & 0x1fff;
    if (bank === RAM_BANK) return this.ram[offset];
    if (bank === HARDWARE_BANK) return this.readHardware(offset);
    return (this.banks[bank] ?? this.voidBank)[offset];
  }

  write(addr: number, value: number): void {
    const bank = this.mpr[(addr >> 13) & 7];
    const offset = addr & 0x1fff;
    if (bank === RAM_BANK) {
      this.ram[offset] = value & 0xff;
      return;
    }
    if (bank === HARDWARE_BANK) {
      this.writeHardware(offset, value & 0xff);
      return;
    }
    // The file's image is ROM on the real machine, so a write to it is lost.
  }

  /**
   * The hardware page. Its regions are decoded by the top bits of the offset:
   * $0000 video, $0800 PSG, $0C00 timer, $1000 pad, $1400 interrupt controller.
   */
  private readHardware(offset: number): number {
    switch (offset & 0x1c00) {
      case 0x0c00:
        return this.timerValue & 0x7f;
      case 0x1000:
        // No pad is connected; the value with nothing pressed.
        return 0xff;
      case 0x1400:
        switch (offset & 3) {
          case 2:
            return this.irqDisable;
          case 3:
            return this.irqPending;
          default:
            return 0;
        }
      default:
        return 0;
    }
  }

  private writeHardware(offset: number, value: number): void {
    switch (offset & 0x1c00) {
      case 0x0800:
        this.psg.write(offset & 0x0f, value);
        break;
      case 0x0c00:
        if ((offset & 1) === 0) {
          this.timerReload = value & 0x7f;
        } else {
          const running = (value & 1) !== 0;
          // Starting the timer loads it; while it runs, a write to the reload
          // register only takes effect at the next underflow.
          if (running && !this.timerRunning) {
            this.timerValue = this.timerReload;
            this.timerCycles = 0;
          }
          this.timerRunning = running;
        }
        break;
      case 0x1400:
        switch (offset & 3) {
          case 2:
            this.irqDisable = value & 0x07;
            break;
          case 3:
            // A write here acknowledges the timer's request.
            this.irqPending &= ~IRQ_TIMER;
            break;
        }
        break;
    }
  }

  /** Advance the timer by `clocks` master clocks, raising its interrupt on underflow. */
  advanceTimer(clocks: number): void {
    if (!this.timerRunning) return;
    this.timerCycles += clocks;
    while (this.timerCycles >= TIMER_PRESCALE) {
      this.timerCycles -= TIMER_PRESCALE;
      if (this.timerValue === 0) {
        this.timerValue = this.timerReload;
        this.irqPending |= IRQ_TIMER;
      } else {
        this.timerValue--;
      }
    }
  }

  /** Clocks until the timer next underflows, or Infinity while it is stopped. */
  timerEventIn(): number {
    if (!this.timerRunning) return Infinity;
    return (this.timerValue + 1) * TIMER_PRESCALE - this.timerCycles;
  }

  /** Raise an interrupt from outside, as the display's vertical blank does. */
  raise(source: number): void {
    this.irqPending |= source;
  }

  /**
   * Clear a source once its handler has been entered.
   *
   * On the real machine the display's request goes away when the driver reads
   * the video controller's status register. There is no video controller in a
   * music rip, so the handler would never be able to clear it and the machine
   * would take the same interrupt forever; taking it is treated as clearing it.
   */
  acknowledge(source: number): void {
    this.irqPending &= ~source;
  }

  /** True while any unmasked source is asking to be taken. */
  get irqAsserted(): boolean {
    return (this.irqPending & ~this.irqDisable & 0x07) !== 0;
  }

  /**
   * Vector for the highest-priority source currently asking.
   *
   * The chip gives each source a vector of its own: $FFF6 the external line
   * (which BRK also uses), $FFF8 the display, $FFFA the timer. Priority runs
   * the other way from the register's bit order - the external line is taken
   * first.
   */
  get irqVector(): number {
    const active = this.irqPending & ~this.irqDisable;
    if (active & IRQ_EXTERNAL) return 0xfff6;
    if (active & IRQ_VDC) return 0xfff8;
    return 0xfffa;
  }
}
