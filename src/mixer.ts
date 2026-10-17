/**
 * From 1.79 MHz to something a sound card can take, and the analogue end of the
 * NES's audio path.
 *
 * The channels are evaluated once per CPU cycle, so the raw stream carries
 * energy far above any output rate. Dropping straight to 44.1 kHz would fold
 * all of it back into the audible band, so the rate comes down in two stages: a
 * cheap cascaded-integrator decimator that runs at the full cycle rate, then a
 * proper windowed-sinc resampler on the much slower stream that leaves.
 */

/**
 * Decimation factor of the first stage.
 *
 * Chosen against this machine's clock: a third of the master 21.48 MHz is
 * 7.16 MHz, and 32 brings that to 223.7 kHz - low enough that one half-band
 * stage reaches the resampler's working rate, high enough that the second-order
 * response still puts the worst fold-back 40 dB down. Halving it would buy
 * 12 dB there and cost another half-band stage and twice the work in this one,
 * which is the stage every clock passes through.
 */
export const CIC_RATIO = 32;

/**
 * Two cascaded box filters, decimating by a power of two.
 *
 * A single box would leave its first sidelobe only 13 dB down, which is audible
 * as grit on high square waves; two puts it near 26 dB while costing a handful
 * of adds per CPU cycle. Running sums are used rather than integrators so that
 * nothing accumulates without bound over a long track.
 */
export class CicDecimator {
  private readonly mask: number;
  private readonly r: number;
  private buf1: Float64Array;
  private buf2: Float64Array;
  private i1 = 0;
  private i2 = 0;
  private sum1 = 0;
  private sum2 = 0;
  private count = 0;
  /** The last value pushed, and how many times in a row it has been pushed. */
  private lastX = NaN;
  private sameRun = 0;

  value = 0;

  /** Inputs taken since the last decimated output, 0..R-1. */
  get phase(): number {
    return this.count;
  }

  /** Decimation factor. */
  get ratio(): number {
    return this.r;
  }

  constructor(ratio = CIC_RATIO) {
    if ((ratio & (ratio - 1)) !== 0) throw new Error("cic: ratio must be a power of two");
    this.r = ratio;
    this.mask = ratio - 1;
    this.buf1 = new Float64Array(ratio);
    this.buf2 = new Float64Array(ratio);
  }

  /**
   * Feed `count` copies of one sample and collect the decimated outputs in
   * `out`. Returns how many were written.
   *
   * Held at one value, both box filters settle after 2R pushes and every output
   * from then on is that value exactly - so a long run costs a division instead
   * of thousands of adds. This is what makes an event-driven caller pay for
   * changes rather than for cycles.
   */
  pushRun(x: number, count: number, out: Float64Array): number {
    if (count <= 0) return 0;
    if (x !== this.lastX) {
      this.lastX = x;
      this.sameRun = 0;
    }

    let n = 0;
    const r = this.r;
    const mask = this.mask;
    const buf1 = this.buf1;
    const buf2 = this.buf2;
    const scale = 1 / (r * r);

    // Held at one value long enough for both box filters to fill, every output
    // is that value exactly, and the run can be finished with a division. Below
    // that the filters are still remembering older samples, so their taps have
    // to be walked - but even then the work is inlined here rather than paid as
    // a call per sample, because at this hardware's event rate almost every run
    // is a short one and this is the path they all take.
    const settled = r * 2;
    let left = count;
    while (left > 0 && this.sameRun < settled) {
      const i1 = this.i1;
      this.sum1 += x - buf1[i1];
      buf1[i1] = x;
      this.i1 = (i1 + 1) & mask;

      const s1 = this.sum1;
      const i2 = this.i2;
      this.sum2 += s1 - buf2[i2];
      buf2[i2] = s1;
      this.i2 = (i2 + 1) & mask;

      this.sameRun++;
      left--;
      if (++this.count >= r) {
        this.count = 0;
        this.value = this.sum2 * scale;
        out[n++] = this.value;
      }
    }

    if (left > 0) {
      const total = this.count + left;
      const outs = (total / r) | 0;
      this.count = total - outs * r;
      this.sameRun += left;
      for (let i = 0; i < outs; i++) out[n++] = x;
      if (outs > 0) this.value = x;
    }
    return n;
  }

  /** Feed one sample; returns true when `value` holds a decimated output. */
  push(x: number): boolean {
    this.sum1 += x - this.buf1[this.i1];
    this.buf1[this.i1] = x;
    this.i1 = (this.i1 + 1) & this.mask;

    const s1 = this.sum1;
    this.sum2 += s1 - this.buf2[this.i2];
    this.buf2[this.i2] = s1;
    this.i2 = (this.i2 + 1) & this.mask;

    if (++this.count < this.r) return false;
    this.count = 0;
    this.value = this.sum2 / (this.r * this.r);
    return true;
  }

  clear(): void {
    this.buf1.fill(0);
    this.buf2.fill(0);
    this.sum1 = 0;
    this.sum2 = 0;
    this.i1 = 0;
    this.i2 = 0;
    this.count = 0;
    this.value = 0;
    this.lastX = NaN;
    this.sameRun = 0;
  }
}

/**
 * Half-band decimator: halves the rate with a filter whose every other
 * coefficient is zero, so it costs half of what its length suggests.
 *
 * It sits between the two existing stages to buy the last one room. On its own
 * the windowed-sinc resampler has to go from 223 kHz to 44.1 kHz in one step,
 * and at a length that can run in real time its transition band is 6 kHz wide -
 * wider than the gap between the audible top and Nyquist, so it never reaches
 * its stopband before the fold point and passes what belongs above it. Halving
 * the rate first halves the transition width in Hz, which puts the stopband
 * where it needs to be.
 */
export class HalfBand {
  /** Only the coefficients that are not zero, and where each one reads from. */
  readonly #taps: Float64Array;
  readonly #offsets: Int32Array;
  readonly #length: number;
  private hist: Float64Array;
  private pos = 0;
  private odd = false;

  value = 0;

  constructor(length = 31) {
    // Odd length, symmetric, cutoff at a quarter of the input rate: the
    // definition of a half-band, and what makes the odd taps vanish.
    const n = length | 1;
    const half = (n - 1) >> 1;
    const h = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const t = i - half;
      const x = (Math.PI * t) / 2;
      const sinc = t === 0 ? 1 : Math.sin(x) / x;
      const w = i / (n - 1);
      const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w);
      h[i] = sinc * win;
      sum += h[i];
    }
    for (let i = 0; i < n; i++) h[i] /= sum;

    // Every coefficient at an even distance from the centre is zero, which is
    // half of them; keeping only the rest halves the work per output.
    const keep: number[] = [];
    for (let i = 0; i < n; i++) if (h[i] !== 0) keep.push(i);
    this.#taps = new Float64Array(keep.map((i) => h[i]));
    this.#offsets = new Int32Array(keep);
    this.#length = n;
    this.hist = new Float64Array(n);
  }

  /** Feed one sample; returns true on every second one, with `value` set. */
  push(x: number): boolean {
    const n = this.#length;
    this.hist[this.pos] = x;
    this.pos = this.pos + 1 === n ? 0 : this.pos + 1;
    this.odd = !this.odd;
    if (this.odd) return false;

    const taps = this.#taps;
    const offsets = this.#offsets;
    const hist = this.hist;
    const base = this.pos;
    let acc = 0;
    for (let i = 0; i < taps.length; i++) {
      let k = base + offsets[i];
      if (k >= n) k -= n;
      acc += taps[i] * hist[k];
    }
    this.value = acc;
    return true;
  }

  clear(): void {
    this.hist.fill(0);
    this.pos = 0;
    this.odd = false;
    this.value = 0;
  }
}

/**
 * The console's analogue response: two high passes and a low pass, at the
 * corner frequencies measured on hardware. The high passes are what remove the
 * standing offset a DMC sample or an FDS wavetable leaves behind, so they earn
 * their place rather than being cosmetic.
 */
export class NesFilter {
  private hp1 = 0;
  private hp2 = 0;
  private lp = 0;
  private readonly a1: number;
  private readonly a2: number;
  private readonly b: number;

  constructor(sampleRate: number) {
    this.a1 = Math.exp((-2 * Math.PI * 90) / sampleRate);
    this.a2 = Math.exp((-2 * Math.PI * 440) / sampleRate);
    this.b = 1 - Math.exp((-2 * Math.PI * 14000) / sampleRate);
  }

  process(x: number): number {
    // Each high pass is a one-pole low pass subtracted from the signal.
    this.hp1 = this.a1 * this.hp1 + (1 - this.a1) * x;
    let y = x - this.hp1;
    this.hp2 = this.a2 * this.hp2 + (1 - this.a2) * y;
    y = y - this.hp2;
    this.lp += this.b * (y - this.lp);
    return this.lp;
  }

  clear(): void {
    this.hp1 = 0;
    this.hp2 = 0;
    this.lp = 0;
  }
}

/**
 * Level the FDS channel is mixed in at, relative to the APU's own output.
 *
 * The two chips meet on an analogue summing point outside both of them, so
 * there is no register-level truth to appeal to here; this is set so that an FDS
 * track sits at the same loudness as a 2A03 one.
 */
export const FDS_MIX_LEVEL = 0.28;

/**
 * Scale from the mixer's 0..1 output to int16.
 *
 * The DAC's theoretical maximum needs every channel at full level with the DMC
 * blasting, which music never does; this is set from what real tracks actually
 * peak at, so a loud one lands near full scale rather than at a third of it.
 */
export const MASTER_OUTPUT_LEVEL = 56000;

/**
 * Level the VRC6 is mixed in at, relative to the APU's own output.
 *
 * Like the FDS, the two chips meet on an analogue summing point outside both of
 * them, so there is no register-level truth here. This is set so that a VRC6
 * pulse at full volume sits about where a 2A03 pulse at full volume does, which
 * is what the cartridge sounds like.
 */
export const VRC6_MIX_LEVEL = 0.62;
