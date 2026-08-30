/**
 * Fractional-ratio decimating resampler: a windowed-sinc kernel evaluated from
 * a precomputed phase table.
 *
 * The audio arrives already reduced to a few hundred kHz by the CIC stage, and
 * this brings it the rest of the way to the host's rate while cutting
 * everything above the output's Nyquist - the step that decides whether an NES
 * square wave sounds like a square wave or like a square wave plus a chorus of
 * aliases.
 */

export class Resampler {
  private readonly taps: number;
  private readonly phases: number;
  private readonly half: number;
  /** Kernel table: constant, and large, so it stays out of state snapshots. */
  readonly #table: Float32Array;

  /** Input samples per output sample. */
  private readonly step: number;

  private readonly hist: Float32Array;
  private readonly mask: number;
  /** Index of the newest input sample. */
  private n = -1;
  /** Input-sample time of the next output sample. */
  private outTime: number;

  /** The sample produced by the last `push` that returned true. */
  value = 0;

  constructor(inRate: number, outRate: number, taps = 192, phases = 128) {
    if (outRate > inRate) throw new Error("resampler: only decimation is supported");
    this.taps = taps;
    this.phases = phases;
    this.half = taps >> 1;
    this.step = inRate / outRate;

    let size = 1;
    while (size < taps + 2) size <<= 1;
    this.hist = new Float32Array(size);
    this.mask = size - 1;
    this.outTime = this.half;

    // Cut just below the output's Nyquist. A Blackman window over this many
    // taps puts the stopband far enough down that what folds back is inaudible.
    const cutoff = outRate * 0.45;
    const wc = (2 * Math.PI * cutoff) / inRate;
    this.#table = new Float32Array(taps * phases);
    for (let p = 0; p < phases; p++) {
      const frac = p / phases;
      let sum = 0;
      const off = p * taps;
      for (let j = 0; j < taps; j++) {
        const t = j - this.half + 1 - frac;
        const x = wc * t;
        const sinc = x === 0 ? 1 : Math.sin(x) / x;
        // Blackman window across the tap range.
        const w = (j + 1 - frac) / (taps + 1);
        const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w);
        const h = sinc * win;
        this.#table[off + j] = h;
        sum += h;
      }
      // Normalise each phase so that a constant input comes out unchanged.
      const g = 1 / sum;
      for (let j = 0; j < taps; j++) this.#table[off + j] *= g;
    }
  }

  /**
   * Feed one input sample; returns true when a sample position was reached, and
   * `value` holds it unless `compute` is false.
   *
   * Skipping the kernel while still filling the history is what lets a caller
   * fast-forward without an audible seam afterwards: the filter's memory stays
   * continuous, so the first sample computed after a skip is the same one
   * continuous playback would have produced.
   */
  push(x: number, compute = true): boolean {
    this.n++;
    this.hist[this.n & this.mask] = x;

    // An output sample needs the kernel's whole right half to have arrived.
    if (this.n < this.outTime + this.half) return false;

    if (!compute) {
      this.outTime += this.step;
      return true;
    }

    const i0 = Math.floor(this.outTime);
    const frac = this.outTime - i0;
    const off = ((frac * this.phases) | 0) * this.taps;
    const base = i0 - this.half + 1;

    const table = this.#table;
    const hist = this.hist;
    const mask = this.mask;
    let sum = 0;
    for (let j = 0; j < this.taps; j++) sum += table[off + j] * hist[(base + j) & mask];

    this.value = sum;
    this.outTime += this.step;
    return true;
  }

  /** Drop the filter's memory, as when seeking. */
  clear(): void {
    this.hist.fill(0);
    this.n = -1;
    this.outTime = this.half;
    this.value = 0;
  }
}
