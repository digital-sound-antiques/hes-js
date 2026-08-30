/**
 * High-level .hes player: owns the machine, starts a track, and keeps the
 * interrupts coming.
 *
 * A HES file is unlike an NSF in one way that shapes everything here: it has no
 * play address. The driver installs its own interrupt handler - usually on the
 * timer, sometimes on the display's vertical blank - and once its entry point
 * has returned, playback is whatever that handler does each time it is taken.
 * So the player calls the entry point once and then supplies the two interrupt
 * sources on schedule, exactly as the console would.
 *
 * Timing is counted in master clocks divided by three, the rate the CPU runs at
 * in fast mode. A slow-mode CPU cycle is four of those, and a PSG clock is two,
 * which keeps every part on one integer timebase.
 */

import { HuC6280, type HuC6280State } from "./huc6280.js";
import { HESBus, IRQ_VDC } from "./bus.js";
import { PSG_CHANNELS } from "./psg.js";
import { isHESFile, parseHES, type HESFile } from "./hes-file.js";
import { CIC_RATIO, CicDecimator, HalfBand, MASTER_OUTPUT_LEVEL, NesFilter } from "./mixer.js";
import { Resampler } from "./resampler.js";
import { restore, snapshot } from "./state.js";

export { isHESFile };

/** Master clock, divided by three: the rate this player counts time in. */
export const CLOCK = 21477270 / 3;
/** A PSG clock is two of those. */
const PSG_DIVIDER = 2;
/** A slow-mode CPU cycle is four of those. */
const SLOW_CPU_MULTIPLIER = 4;

/** Display refresh, for the vertical blank the driver may be using. */
const VBLANK_HZ = 59.826;

/** Address the CPU lands on when the entry routine returns; nothing is mapped. */
const SENTINEL = 0x1ff0;

/** Clocks the entry routine is given before the player stops waiting for it. */
const INIT_CLOCK_LIMIT = 40_000_000;

/** Longest span the machine is advanced in one go. */
const MAX_ADVANCE = 4096;

/** Samples computed in full at the end of a skip, to settle the filters. */
const FILTER_PRIME_SAMPLES = 512;

const DEFAULT_PLAY_SECONDS = 150;
const DEFAULT_FADE_SECONDS = 5;

export interface HESPlayerOptions {
  /** Output sample rate. Defaults to 44100. */
  sampleRate?: number;
  /** Track length in seconds when nothing else says. Defaults to 150. */
  defaultPlaySeconds?: number;
  /** Fade length in seconds when nothing else says. Defaults to 5. */
  defaultFadeSeconds?: number;
}

/**
 * A complete, transferable player snapshot.
 *
 * The machine's own parts are carried as walked object graphs rather than as
 * lists of named fields. Enumerating them by hand is how a snapshot ends up
 * missing one - a prescaler's remainder, a held sample - and the symptom of
 * that is a seek which sounds almost right, which is far harder to notice than
 * one that fails outright.
 */
export interface HESPlayerState {
  cpu: HuC6280State;
  bus: unknown;
  left: unknown;
  right: unknown;
  cpuIdle: boolean;
  clocksToVBlank: number;
  psgRemainder: number;
  heldLeft: number;
  heldRight: number;
  outputSample: number;
  clock: number;
  channelHp: Float64Array;
  /**
   * Samples the machine had produced but not yet handed out.
   *
   * Part of the state, not scratch: a snapshot taken mid-buffer and restored
   * without these resumes a fraction of a sample early, and every later sample
   * is then computed from a machine that is slightly out of step with the
   * filters. It is a small error that never goes away.
   */
  pending: { left: Float64Array; right: Float64Array; read: number };
}

export interface ChannelStatus {
  index: number;
  /** True while the channel is contributing something audible. */
  active: boolean;
  /** Level, 0..1, as its own volume and balance set it. */
  level: number;
  /** MIDI note number, fractional; null when the channel has no pitch. */
  note: number | null;
  /** 12-bit divider as the registers hold it. */
  period: number;
  /** "wave", "dda", "noise", or "lfo" for a channel spent on modulation. */
  mode: string;
  /** The 32-step waveform, for a display; null in the modes that have none. */
  wave: Uint8Array | null;
  /** Retriggers since load. */
  keyOnCount: number;
}

/**
 * One side's path from the machine's clock rate to the host's: the decimator,
 * two half-band stages, the windowed sinc, and the console's analogue response.
 *
 * Holding it as an object rather than as loose fields is what lets the player
 * keep two of them without the two ever sharing state by accident - and lets a
 * state snapshot carry both by walking the object graph.
 */
class SideChain {
  cic = new CicDecimator();
  halfBand = new HalfBand();
  resampler: Resampler;
  filter: NesFilter;

  /** Decimated values from one push, and the samples that came out of them. */
  private cicOut: Float64Array;
  out: Float64Array;

  /**
   * Everything is built here rather than filled in afterwards: a chain with a
   * half-built filter is a chain that quietly produces NaN, and there is no
   * point at which a half-built one is useful.
   */
  constructor(inRate: number, outRate: number, room: number) {
    this.resampler = new Resampler(inRate, outRate);
    this.filter = new NesFilter(outRate);
    this.cicOut = new Float64Array(room);
    this.out = new Float64Array(room);
  }

  /**
   * Feed a run of one value; returns how many output samples reached {@link out}.
   *
   * `audible` false runs the filters without computing the resampling kernel,
   * which is what a skip needs: the memory stays continuous, so the first
   * sample after it is the one continuous playback would have produced.
   */
  push(value: number, count: number, audible: boolean): number {
    const cicOut = this.cicOut;
    const resampler = this.resampler;
    // The run is taken in pieces the decimator's output buffer can hold. A
    // caller is free to hand over a span of any length, and where the buffer
    // falls in the middle of one is not its business.
    const chunk = (cicOut.length - 1) * this.cic.ratio;
    let left = count;
    let ready = 0;
    while (left > 0) {
      const take = left < chunk ? left : chunk;
      const n = this.cic.pushRun(value, take, cicOut);
      left -= take;
      for (let i = 0; i < n; i++) {
        if (!this.halfBand.push(cicOut[i])) continue;
        if (!resampler.push(this.halfBand.value, audible)) continue;
        if (ready >= this.out.length) {
          const grown = new Float64Array(this.out.length * 2);
          grown.set(this.out);
          this.out = grown;
        }
        if (audible) this.out[ready] = this.filter.process(resampler.value);
        ready++;
      }
    }
    return ready;
  }

  clear(): void {
    this.cic.clear();
    this.halfBand.clear();
    this.resampler.clear();
    this.filter.clear();
  }
}

export class HESPlayer {
  readonly sampleRate: number;

  private file: HESFile | null = null;
  private bus: HESBus | null = null;
  private cpu: HuC6280 | null = null;

  /**
   * One rate-reduction chain per side.
   *
   * The PSG pans every channel in hardware, so the two sides are genuinely
   * different signals - not a mono signal with a balance applied - and each
   * needs its own filter memory. Sharing one chain and deriving the second
   * side from it was tried first; it collapses the stereo image and, because
   * the two sides then have to agree on a phase that advances inside the
   * filter, it is easy to get subtly wrong. Two chains cost twice as much and
   * are obviously correct.
   */
  private left: SideChain | null = null;
  private right: SideChain | null = null;

  private trackIndex = 0;
  private cpuIdle = true;
  /** Clocks until the next vertical blank. */
  private clocksToVBlank = 0;
  private readonly vblankPeriod = Math.round(CLOCK / VBLANK_HZ);

  /** Output samples produced since the track started. */
  private outputSample = 0;
  /** Clocks run since the track started. */
  private clock = 0;

  private readonly options: Required<HESPlayerOptions>;

  /** Samples the machine has produced but the caller has not taken yet. */
  private pendingL = new Float64Array(0);
  private pendingR = new Float64Array(0);
  private pendingCount = 0;
  private pendingRead = 0;
  private advanceLimit = MAX_ADVANCE;
  private maxSamplesPerAdvance = 1;

  /** Sub-clock remainders, so any advance can be split. */
  private psgRemainder = 0;
  /** The level the run currently being accumulated carries. */
  private heldLeft = 0;
  private heldRight = 0;

  /** Output samples that hit the rails since the track started. */
  clippedSamples = 0;

  /** Whether {@link channelCapture} is filled during rendering. */
  channelCaptureEnabled = false;
  private channelCaptureBuffer = new Int16Array(0);
  private channelCaptureCount = 0;
  private chAcc = new Float64Array(PSG_CHANNELS);
  private chAccCount = 0;
  private channelHp = new Float64Array(PSG_CHANNELS);
  private chHpCoef = 0;

  /** True while {@link skip} is running: computed samples are thrown away. */
  private discardOutput = false;
  private skippedSamples = 0;
  /** Whether a skip settles the filters at its end. Off for a scanner. */
  filterPrimeOnSkip = true;

  constructor(options: HESPlayerOptions = {}) {
    this.sampleRate = options.sampleRate ?? 44100;
    this.options = {
      sampleRate: this.sampleRate,
      defaultPlaySeconds: options.defaultPlaySeconds ?? DEFAULT_PLAY_SECONDS,
      defaultFadeSeconds: options.defaultFadeSeconds ?? DEFAULT_FADE_SECONDS,
    };
    this.chHpCoef = Math.exp((-2 * Math.PI * 30) / this.sampleRate);
  }

  get hes(): HESFile | null {
    return this.file;
  }

  get track(): number {
    return this.trackIndex;
  }

  load(input: Uint8Array | ArrayBuffer | HESFile, track?: number): void {
    const file =
      input instanceof ArrayBuffer
        ? parseHES(new Uint8Array(input))
        : input instanceof Uint8Array
          ? parseHES(input)
          : input;
    this.file = file;
    this.bus = new HESBus(file);
    this.cpu = new HuC6280(this.bus);

    // Three stages down from the clock: the decimator, one half-band, then the
    // windowed sinc to the host's rate.
    const inRate = CLOCK / CIC_RATIO / 2;
    const room = Math.ceil(MAX_ADVANCE / CIC_RATIO) + 8;
    this.left = new SideChain(inRate, this.sampleRate, room);
    this.right = new SideChain(inRate, this.sampleRate, room);
    this.maxSamplesPerAdvance = Math.ceil((MAX_ADVANCE * this.sampleRate) / CLOCK) + 1;
    this.pendingL = new Float64Array(room);
    this.pendingR = new Float64Array(room);

    this.setTrack(track ?? file.startSong);
  }

  /** Restart the machine on `track` and run the file's entry routine. */
  setTrack(track: number): void {
    const file = this.file;
    const bus = this.bus;
    const cpu = this.cpu;
    if (file == null || bus == null || cpu == null) throw new Error("hes: no file loaded");

    this.trackIndex = track & 0xff;
    this.outputSample = 0;
    this.clock = 0;
    this.psgRemainder = 0;
    this.heldLeft = 0;
    this.heldRight = 0;
    this.clocksToVBlank = this.vblankPeriod;
    this.pendingCount = 0;
    this.pendingRead = 0;
    this.chAcc.fill(0);
    this.chAccCount = 0;
    this.channelHp.fill(0);
    this.left?.clear();
    this.right?.clear();

    bus.reset(file.mpr);
    cpu.reset();

    // The entry routine is handed the track number and left to set everything
    // else up itself, interrupt handler included.
    cpu.a = this.trackIndex;
    cpu.x = 0;
    cpu.y = 0;
    this.enter(file.requestAddress);

    // Whatever the machine emits while it starts up is not part of the track.
    this.discardOutput = true;
    let spent = 0;
    while (!this.cpuIdle && spent < INIT_CLOCK_LIMIT) spent += this.stepMachine();
    this.discardOutput = false;
    this.pendingCount = 0;
    this.pendingRead = 0;
  }

  /** Push a sentinel return address and jump; the routine's RTS lands on it. */
  private enter(address: number): void {
    const cpu = this.cpu!;
    cpu.s = 0xff;
    cpu.push2(SENTINEL - 1);
    cpu.pc = address;
    cpu.fi = 1;
    this.cpuIdle = false;
  }

  // ---------------------------------------------------------------- running

  /**
   * Run the machine to its next event and clock everything for exactly that
   * long. Returns the clocks that passed.
   */
  private stepMachine(audible = true): number {
    const cpu = this.cpu!;
    const bus = this.bus!;

    // The interrupt controller decides which source is asking, and the CPU
    // takes its vector. An idle CPU is one whose entry routine has returned;
    // an interrupt is exactly what it is waiting for, so it goes back to work.
    if (bus.irqAsserted) {
      cpu.irqLine = true;
      cpu.irqVector = bus.irqVector;
      if (this.cpuIdle) {
        this.cpuIdle = false;
        // The routine that returned left interrupts masked on the way in; from
        // here the machine is running the driver's handler, which is what
        // playback consists of.
        cpu.fi = 0;
      }
    } else {
      cpu.irqLine = false;
    }

    let clocks: number;
    if (this.cpuIdle) {
      // Nothing to run until the next interrupt, so the wait is taken in one
      // step that ends exactly when the interrupt is due. Cutting it short - at
      // a fixed limit, or at the PSG's next edge - would leave the interrupt to
      // be noticed at the top of some later step instead, and a driver whose
      // tempo is its interrupt period would wander. The sound is not lost by
      // taking a long step: clockDevices splits it at the PSG's edges itself.
      let wait = Math.min(bus.timerEventIn(), this.clocksToVBlank);
      // Nothing is scheduled at all: a track that has fallen silent, or a
      // driver that never armed anything. Idle in slices rather than hang.
      if (!isFinite(wait)) wait = MAX_ADVANCE;
      // A skip lowers the limit near its target so it can land on the exact
      // sample; ordinary playback leaves it at the full span.
      if (wait > this.advanceLimit) wait = this.advanceLimit;
      clocks = Math.max(1, Math.ceil(wait));
    } else {
      // A CPU instruction can outlast the PSG's next edge too, but it cannot be
      // split, so the devices are clocked in pieces below instead.
      clocks = cpu.step() * this.cpuClockScale();
      // The display's request is cleared by reading a video controller that a
      // music rip does not have, so entering its handler clears it here - and
      // only then. Clearing it when the request was merely made loses every
      // interrupt the driver happened to be masking at that moment, which is
      // heard as a tempo that drops frames. The timer's request is cleared by
      // the driver writing to $1403, as on the hardware.
      if (cpu.irqTaken && cpu.irqVector === 0xfff8) bus.acknowledge(IRQ_VDC);
      // The sentinel is only ever reached by the entry routine's own RTS; the
      // driver's interrupt handler returns to whatever it interrupted.
      if (cpu.pc === SENTINEL) this.cpuIdle = true;
    }

    this.clockDevices(clocks, audible);
    return clocks;
  }

  /** Clocks per CPU cycle at the speed the CPU is currently running. */
  private cpuClockScale(): number {
    return this.cpu!.fast ? 1 : SLOW_CPU_MULTIPLIER;
  }

  private clockDevices(clocks: number, audible: boolean): void {
    const bus = this.bus!;
    const psg = bus.psg;

    bus.advanceTimer(clocks);

    this.clocksToVBlank -= clocks;
    if (this.clocksToVBlank <= 0) {
      this.clocksToVBlank += this.vblankPeriod;
      // The display's vertical blank, which most drivers run their music from.
      bus.raise(IRQ_VDC);
    }

    // The span is broken where the sound actually moves, so every run handed to
    // the filters carries a value that really is constant for its whole length.
    //
    // The PSG is asked when one of its channels next steps, but a step is only
    // a candidate: most of them leave the mix exactly where it was, and the run
    // is extended across those rather than cut. Only a step that moves the
    // output ends a run - which, on this hardware, is a small fraction of them.
    let remaining = clocks;
    let held = 0;
    while (remaining > 0) {
      const event = psg.cyclesToEvent();
      let step = remaining;
      if (event !== Infinity) {
        const untilEdge = event * PSG_DIVIDER - this.psgRemainder;
        if (untilEdge > 0 && untilEdge < step) step = untilEdge;
      }

      held += step;
      remaining -= step;

      // The mix's runs are cut only where the mix moves, but a single channel
      // can move inside one of those runs - two of them can change and cancel
      // out. So the waveform display is accumulated per step, before the step
      // is taken, rather than per run.
      if (this.channelCaptureEnabled) {
        const acc = this.chAcc;
        for (let c = 0; c < PSG_CHANNELS; c++) acc[c] += psg.channelOutput(c) * step;
        this.chAccCount += step;
      }

      this.psgRemainder += step;
      const psgClocks = (this.psgRemainder / PSG_DIVIDER) | 0;
      if (psgClocks > 0) {
        this.psgRemainder -= psgClocks * PSG_DIVIDER;
        psg.advance(psgClocks);
        // The run just ended carried the level the PSG had before this step, so
        // it is flushed here, after the step and before the new level is used.
        if (psg.changed) {
          this.feed(this.heldLeft, this.heldRight, held, audible);
          held = 0;
          this.heldLeft = psg.left;
          this.heldRight = psg.right;
        }
      }
    }
    if (held > 0) this.feed(this.heldLeft, this.heldRight, held, audible);

    this.clock += clocks;
  }

  /** Push a run of one output value through both chains. */
  private feed(l: number, r: number, count: number, audible: boolean): void {
    if (count <= 0) return;
    const capture = this.channelCaptureEnabled;

    // The two chains are fed the same run, so they produce the same number of
    // samples at the same instants.
    const left = this.left!;
    const right = this.right!;
    const n = left.push(l, count, audible);
    const m = right.push(r, count, audible);
    const ready = Math.min(n, m);
    if (ready === 0) return;

    if (!audible || this.discardOutput) {
      this.skippedSamples += ready;
      if (capture) this.chAccReset();
      return;
    }

    if (this.pendingCount + ready > this.pendingL.length) {
      const grown = Math.max(64, (this.pendingCount + ready) * 2);
      const gl = new Float64Array(grown);
      const gr = new Float64Array(grown);
      gl.set(this.pendingL);
      gr.set(this.pendingR);
      this.pendingL = gl;
      this.pendingR = gr;
    }
    for (let i = 0; i < ready; i++) {
      this.pendingL[this.pendingCount] = left.out[i];
      this.pendingR[this.pendingCount] = right.out[i];
      this.pendingCount++;
      if (capture) this.captureChannels();
    }
  }

  private chAccReset(): void {
    this.chAcc.fill(0);
    this.chAccCount = 0;
  }

  private captureChannels(): void {
    const need = (this.channelCaptureCount + 1) * PSG_CHANNELS;
    if (need > this.channelCaptureBuffer.length) {
      const grown = new Int16Array(
        Math.max(need, this.channelCaptureBuffer.length * 2, PSG_CHANNELS * 1024)
      );
      grown.set(this.channelCaptureBuffer);
      this.channelCaptureBuffer = grown;
    }
    const at = this.channelCaptureCount * PSG_CHANNELS;
    const n = this.chAccCount || 1;
    const coef = this.chHpCoef;
    for (let c = 0; c < PSG_CHANNELS; c++) {
      const raw = this.chAcc[c] / n;
      this.channelHp[c] = coef * this.channelHp[c] + (1 - coef) * raw;
      const v = (raw - this.channelHp[c]) * 24000;
      this.channelCaptureBuffer[at + c] = v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0;
    }
    this.channelCaptureCount++;
    this.chAccReset();
  }

  /** Per-channel output for the samples the last render produced. */
  get channelCapture(): Int16Array {
    return this.channelCaptureBuffer;
  }

  get channelCaptureLength(): number {
    return this.channelCaptureCount;
  }

  // -------------------------------------------------------------- rendering

  renderInto(left: Int16Array, right: Int16Array, offset: number, count: number): number {
    if (this.file == null) return 0;
    this.channelCaptureCount = 0;

    let produced = 0;
    while (produced < count) {
      while (this.pendingRead < this.pendingCount && produced < count) {
        const l = Math.round(this.pendingL[this.pendingRead] * MASTER_OUTPUT_LEVEL);
        const r = Math.round(this.pendingR[this.pendingRead] * MASTER_OUTPUT_LEVEL);
        this.pendingRead++;
        const cl = l > 32767 ? 32767 : l < -32768 ? -32768 : l;
        const cr = r > 32767 ? 32767 : r < -32768 ? -32768 : r;
        if (cl !== l || cr !== r) this.clippedSamples++;
        left[offset + produced] = cl;
        right[offset + produced] = cr;
        produced++;
      }
      if (this.pendingRead >= this.pendingCount) {
        this.pendingRead = 0;
        this.pendingCount = 0;
      }
      if (produced >= count) break;
      this.stepMachine();
    }

    this.applyFade(left, right, offset, count);
    this.outputSample += count;
    return count;
  }

  render(count: number): { left: Int16Array; right: Int16Array } {
    const left = new Int16Array(count);
    const right = new Int16Array(count);
    this.renderInto(left, right, 0, count);
    return { left, right };
  }

  /** Advance `count` output samples without producing audio. */
  skip(count: number): void {
    if (this.file == null || count <= 0) return;
    this.channelCaptureCount = 0;
    this.skippedSamples = 0;
    this.discardOutput = true;

    while (this.pendingRead < this.pendingCount && this.skippedSamples < count) {
      this.pendingRead++;
      this.skippedSamples++;
    }
    if (this.pendingRead >= this.pendingCount) {
      this.pendingRead = 0;
      this.pendingCount = 0;
    }

    const primeAt = this.filterPrimeOnSkip ? Math.max(0, count - FILTER_PRIME_SAMPLES) : count;
    while (this.skippedSamples < count) {
      this.advanceLimit =
        this.skippedSamples + this.maxSamplesPerAdvance >= primeAt ? 1 : MAX_ADVANCE;
      this.stepMachine(this.skippedSamples >= primeAt);
    }

    this.advanceLimit = MAX_ADVANCE;
    this.discardOutput = false;
    this.outputSample += count;
  }

  private applyFade(left: Int16Array, right: Int16Array, offset: number, count: number): void {
    const fade = this.fadeSeconds;
    if (fade <= 0) return;
    const fadeStart = this.playSeconds * this.sampleRate;
    const fadeLength = fade * this.sampleRate;
    if (this.outputSample + count <= fadeStart) return;
    for (let i = 0; i < count; i++) {
      const pos = this.outputSample + i - fadeStart;
      if (pos < 0) continue;
      const gain = pos >= fadeLength ? 0 : 1 - pos / fadeLength;
      left[offset + i] = (left[offset + i] * gain) | 0;
      right[offset + i] = (right[offset + i] * gain) | 0;
    }
  }

  // ----------------------------------------------------------------- timing

  private playOverride: { play: number; fade: number } | null = null;

  /** Override the track length; a HES file states none of its own. */
  setPlayLength(playSeconds: number, fadeSeconds?: number): void {
    this.playOverride = {
      play: Math.max(0, playSeconds),
      fade: Math.max(0, fadeSeconds ?? this.fadeSeconds),
    };
  }

  get playSeconds(): number {
    return this.playOverride?.play ?? this.options.defaultPlaySeconds;
  }

  get fadeSeconds(): number {
    return this.playOverride?.fade ?? this.options.defaultFadeSeconds;
  }

  get totalSeconds(): number {
    return this.playSeconds + this.fadeSeconds;
  }

  get currentTime(): number {
    return this.outputSample / this.sampleRate;
  }

  get clockCount(): number {
    return this.clock;
  }

  // ---------------------------------------------------------- channel state

  setChannelMask(mask: number): void {
    this.bus?.psg.setChannelMask(mask);
  }

  getChannelMask(): number {
    return this.bus?.psg.getChannelMask() ?? 0;
  }

  getChannelStatus(index: number): ChannelStatus {
    const psg = this.bus?.psg;
    const base: ChannelStatus = {
      index,
      active: false,
      level: 0,
      note: null,
      period: 0,
      mode: "wave",
      wave: null,
      keyOnCount: 0,
    };
    if (psg == null) return base;
    const ch = psg.channels[index];
    if (ch == null) return base;

    const lfo = index === 1 && psg.lfoActive;
    const mode = lfo ? "lfo" : ch.dda ? "dda" : ch.noiseEnabled ? "noise" : "wave";
    // Volume is an attenuation in 1.5 dB steps; a display wants it the other
    // way round.
    const level = ch.enabled && !lfo ? (0x1f - ch.volume) / 0x1f : 0;
    const period = ch.period === 0 ? 0x1000 : ch.period;
    // Thirty-two steps of the waveform to a cycle, at half the timebase.
    const freq = CLOCK / PSG_DIVIDER / (period * 32);

    return {
      index,
      active: ch.enabled && !lfo && level > 0,
      level,
      note: mode === "wave" || mode === "dda" ? 69 + 12 * Math.log2(freq / 440) : null,
      period: ch.period,
      mode,
      wave: mode === "wave" ? ch.wave : null,
      keyOnCount: ch.keyOnCount,
    };
  }

  getChannelStatusArray(): ChannelStatus[] {
    const out: ChannelStatus[] = [];
    for (let i = 0; i < PSG_CHANNELS; i++) out.push(this.getChannelStatus(i));
    return out;
  }

  // -------------------------------------------------------------------- state

  saveState(): HESPlayerState {
    return {
      cpu: this.cpu!.saveState(),
      bus: snapshot(this.bus),
      left: snapshot(this.left),
      right: snapshot(this.right),
      cpuIdle: this.cpuIdle,
      clocksToVBlank: this.clocksToVBlank,
      psgRemainder: this.psgRemainder,
      heldLeft: this.heldLeft,
      heldRight: this.heldRight,
      outputSample: this.outputSample,
      clock: this.clock,
      channelHp: this.channelHp.slice(),
      pending: {
        left: this.pendingL.slice(this.pendingRead, this.pendingCount),
        right: this.pendingR.slice(this.pendingRead, this.pendingCount),
        read: 0,
      },
    };
  }

  restoreState(state: HESPlayerState): void {
    this.cpu!.loadState(state.cpu);
    restore(this.bus, state.bus);
    restore(this.left, state.left);
    restore(this.right, state.right);
    this.cpuIdle = state.cpuIdle;
    this.clocksToVBlank = state.clocksToVBlank;
    this.psgRemainder = state.psgRemainder;
    this.heldLeft = state.heldLeft;
    this.heldRight = state.heldRight;
    this.outputSample = state.outputSample;
    this.clock = state.clock;
    this.channelHp.set(state.channelHp);
    const held = state.pending.left.length;
    if (held > this.pendingL.length) {
      this.pendingL = new Float64Array(held);
      this.pendingR = new Float64Array(held);
    }
    this.pendingL.set(state.pending.left);
    this.pendingR.set(state.pending.right);
    this.pendingCount = held;
    this.pendingRead = state.pending.read;
    this.chAccReset();
  }
}
