/**
 * The HuC6280's built-in PSG: six wavetable channels, in stereo.
 *
 * Each channel plays a 32-step, 5-bit waveform the driver uploads, which is why
 * PC Engine music has a timbral range the square-wave machines do not. The last
 * two channels can switch to noise instead, and the second can be spent driving
 * the first as an LFO.
 *
 * Everything about the level is logarithmic and additive: the global balance,
 * the channel's own volume and its left/right balance are attenuations in the
 * same units, summed rather than multiplied, and the sum saturates into silence.
 * A step is 1.5 dB, so a channel's 5-bit volume spans 46.5 dB and each balance
 * nibble 22.5 dB.
 */

/** Channels, and which of them can do what. */
export const PSG_CHANNELS = 6;
/** Channels 5 and 6 (0-based 4 and 5) can generate noise. */
const FIRST_NOISE_CHANNEL = 4;

/** dB per step of every volume and balance field. */
const DB_PER_STEP = 1.5;

/**
 * Attenuation lookup, indexed by the summed step count. Beyond the point where
 * the sum exceeds what the DAC can express the entry is zero, which is what the
 * hardware's saturation amounts to.
 */
const ATTENUATION = (() => {
  // The three fields can sum to 31 + 15 + 15 = 61 steps.
  const t = new Float64Array(64);
  for (let i = 0; i < t.length; i++) {
    const db = -DB_PER_STEP * i;
    t[i] = db <= -60 ? 0 : Math.pow(10, db / 20);
  }
  return t;
})();

/** Waveform samples are unsigned 5-bit; this centres them. */
const WAVE_CENTRE = 16;

/** Peak of one channel's contribution, for normalising the mix. */
const CHANNEL_PEAK = 16;

class PSGChannel {
  /** 12-bit frequency divider. */
  period = 0;
  timer = 0;
  /** Position in the 32-step waveform. */
  phase = 0;
  /** The waveform itself, 32 unsigned 5-bit samples. */
  readonly wave = new Uint8Array(32);
  /** Where the next write to the waveform port lands. */
  writeIndex = 0;

  enabled = false;
  /** Direct D/A: the channel outputs written samples instead of its waveform. */
  dda = false;
  /** The sample DDA holds. */
  ddaSample = 0;
  /** 5-bit channel volume, as an attenuation in steps. */
  volume = 0;
  /** 4-bit left and right attenuations. */
  balanceLeft = 0;
  balanceRight = 0;

  /** Noise mode, on the last two channels only. */
  noiseEnabled = false;
  noisePeriod = 0;
  noiseTimer = 1;
  /** Eighteen-bit shift register; powers up holding one. */
  lfsr = 1;
  noiseOut = 0;

  keyOnCount = 0;

  /** Current sample, centred, -16..15. */
  get sample(): number {
    if (this.dda) return this.ddaSample - WAVE_CENTRE;
    // Full scale either way, which is what makes noise the loudest thing the
    // chip can do.
    if (this.noiseEnabled) return this.noiseOut ? 31 - WAVE_CENTRE : -WAVE_CENTRE;
    return this.wave[this.phase] - WAVE_CENTRE;
  }

  /**
   * Write to the waveform port.
   *
   * While the channel is running the write goes to the DDA latch instead - that
   * is how a driver plays samples through a channel - and the waveform can only
   * be filled while the channel is stopped.
   */
  writeWave(v: number): void {
    const sample = v & 0x1f;
    if (this.dda) {
      this.ddaSample = sample;
      return;
    }
    this.wave[this.writeIndex] = sample;
    this.writeIndex = (this.writeIndex + 1) & 0x1f;
    if (!this.enabled) {
      // A stopped channel keeps its playback position at the start, so the
      // waveform a driver has just uploaded is heard from its beginning.
      this.phase = 0;
    }
  }

  /** Write to the control register: enable, DDA and volume in one byte. */
  writeControl(v: number): void {
    const wasEnabled = this.enabled;
    const enabled = (v & 0x80) !== 0;
    const dda = (v & 0x40) !== 0;
    if (enabled && !wasEnabled) {
      this.keyOnCount++;
      // Turning a channel on resets where the next waveform write will land.
      this.writeIndex = 0;
    }
    if (!enabled) this.phase = 0;
    this.enabled = enabled;
    this.dda = dda;
    this.volume = 0x1f - (v & 0x1f);
  }

  writeBalance(v: number): void {
    this.balanceLeft = 0x0f - ((v >> 4) & 0x0f);
    this.balanceRight = 0x0f - (v & 0x0f);
  }

  /**
   * Period of the noise divider, in PSG clocks.
   *
   * The five-bit register counts down from its complement, and the all-ones
   * setting is not the longest period but a very short one - the two are not
   * on the same scale at all.
   */
  private noiseDivider(): number {
    const freq = 0x1f - (this.noisePeriod & 0x1f);
    return freq === 0 ? 0x20 : freq << 6;
  }

  /** CPU cycles until the waveform position could move, in PSG clocks. */
  eventIn(): number {
    if (!this.enabled || this.dda) return Infinity;
    if (this.noiseEnabled) return this.noiseTimer;
    return this.timer + 1;
  }

  /** Advance by `clocks` PSG clocks. */
  advance(clocks: number): void {
    if (!this.enabled || this.dda) return;

    if (this.noiseEnabled) {
      const period = this.noiseDivider();
      this.noiseTimer -= clocks;
      while (this.noiseTimer <= 0) {
        // Eighteen bits, tapped at 0, 1, 11, 12 and 17. Fewer taps than that -
        // the two-tap register a shorter machine would use - gives a sequence
        // so short that plain noise comes out sounding like the periodic kind.
        const bit =
          ((this.lfsr >> 0) ^ (this.lfsr >> 1) ^ (this.lfsr >> 11) ^ (this.lfsr >> 12) ^
            (this.lfsr >> 17)) &
          1;
        this.lfsr = ((this.lfsr >>> 1) | (bit << 17)) & 0x3ffff;
        this.noiseOut = this.lfsr & 1;
        this.noiseTimer += period;
      }
      return;
    }

    if (clocks <= this.timer) {
      this.timer -= clocks;
      return;
    }
    // A period of zero is the longest one, not the shortest: the divider is
    // reloaded with the register value and counts down through it.
    const period = this.period === 0 ? 0x1000 : this.period;
    let left = clocks - (this.timer + 1);
    const steps = 1 + Math.floor(left / period);
    left %= period;
    this.timer = period - 1 - left;
    this.phase = (this.phase + steps) & 0x1f;
  }
}

export class PSG {
  readonly channels: PSGChannel[] = [];
  /** Which channel registers $0802-$0807 currently reach. */
  private selected = 0;
  /** Global balance, as attenuations in steps. */
  private globalLeft = 0;
  private globalRight = 0;

  /** LFO on channel 2 driving channel 1, when the driver spends it that way. */
  private lfoFrequency = 0;
  private lfoEnabled = false;
  private lfoShift = 0;

  /** Bit per channel: 1 = left out of the mix. Emulation is unaffected. */
  private channelMask = 0;

  /** Latest stereo output, each roughly -1..1. */
  left = 0;
  right = 0;

  /**
   * True when the last {@link advance} moved the output.
   *
   * A channel stepping to the next entry of its waveform is not the same thing
   * as the sound changing: neighbouring entries are often equal, a silent
   * channel contributes nothing whatever it is playing, and most steps happen
   * while the mix as a whole stands still. A caller that splits its work at
   * every step does far more of it than the sound requires; this lets it split
   * only where the sound really moves.
   */
  changed = false;

  constructor() {
    for (let i = 0; i < PSG_CHANNELS; i++) this.channels.push(new PSGChannel());
  }

  write(addr: number, v: number): void {
    switch (addr & 0x0f) {
      case 0x00:
        this.selected = v & 0x07;
        break;
      case 0x01:
        this.globalLeft = 0x0f - ((v >> 4) & 0x0f);
        this.globalRight = 0x0f - (v & 0x0f);
        break;
      case 0x02: {
        const ch = this.channels[this.selected];
        if (ch != null) ch.period = (ch.period & 0xf00) | v;
        break;
      }
      case 0x03: {
        const ch = this.channels[this.selected];
        if (ch != null) ch.period = (ch.period & 0x0ff) | ((v & 0x0f) << 8);
        break;
      }
      case 0x04:
        this.channels[this.selected]?.writeControl(v);
        break;
      case 0x05:
        this.channels[this.selected]?.writeBalance(v);
        break;
      case 0x06:
        this.channels[this.selected]?.writeWave(v);
        break;
      case 0x07: {
        // Noise, and only on the channels that have it.
        const ch = this.channels[this.selected];
        if (ch != null && this.selected >= FIRST_NOISE_CHANNEL) {
          ch.noiseEnabled = (v & 0x80) !== 0;
          ch.noisePeriod = v & 0x1f;
          if (ch.noiseTimer <= 0) ch.noiseTimer = 1;
        }
        break;
      }
      case 0x08:
        this.lfoFrequency = v;
        break;
      case 0x09:
        // Bit 7 holds the LFO; the low bits scale how far it bends channel 1.
        this.lfoEnabled = (v & 0x80) === 0 && (v & 0x03) !== 0;
        this.lfoShift = [0, 0, 4, 8][v & 0x03];
        break;
    }
  }

  /** PSG clocks until any channel could change its output. */
  cyclesToEvent(): number {
    let n = Infinity;
    for (let i = 0; i < PSG_CHANNELS; i++) {
      const e = this.channels[i].eventIn();
      if (e < n) n = e;
    }
    return n;
  }

  /**
   * Advance by `clocks` PSG clocks and recompute the output.
   *
   * The LFO is applied here rather than inside the channel: it is channel 2's
   * current sample that bends channel 1's divider, so the two have to be looked
   * at together.
   */
  advance(clocks: number): void {
    const ch1 = this.channels[0];
    const ch2 = this.channels[1];

    if (this.lfoEnabled) {
      // Channel 2 runs at its own rate, scaled by the LFO frequency register,
      // and what it plays is added to channel 1's period.
      ch2.period = this.lfoFrequency === 0 ? 0x1000 : this.lfoFrequency;
      const base = ch1.period;
      const bend = ch2.sample << this.lfoShift;
      ch1.period = (base + bend) & 0xfff;
      for (let i = 0; i < PSG_CHANNELS; i++) this.channels[i].advance(clocks);
      ch1.period = base;
    } else {
      for (let i = 0; i < PSG_CHANNELS; i++) this.channels[i].advance(clocks);
    }

    this.updateOutput();
  }

  private updateOutput(): void {
    const wasL = this.left;
    const wasR = this.right;
    let l = 0;
    let r = 0;
    for (let i = 0; i < PSG_CHANNELS; i++) {
      if (this.channelMask & (1 << i)) continue;
      const ch = this.channels[i];
      if (!ch.enabled) continue;
      // Channel 2 spent as an LFO is not heard in its own right.
      if (i === 1 && this.lfoEnabled) continue;
      const s = ch.sample;
      l += s * ATTENUATION[ch.volume + ch.balanceLeft + this.globalLeft];
      r += s * ATTENUATION[ch.volume + ch.balanceRight + this.globalRight];
    }
    const scale = 1 / (CHANNEL_PEAK * PSG_CHANNELS);
    this.left = l * scale;
    this.right = r * scale;
    this.changed = this.left !== wasL || this.right !== wasR;
  }

  setChannelMask(mask: number): void {
    this.channelMask = mask & 0x3f;
    this.updateOutput();
  }

  getChannelMask(): number {
    return this.channelMask;
  }

  /** One channel's own contribution, for a visualiser. */
  channelOutput(index: number): number {
    const ch = this.channels[index];
    if (ch == null || !ch.enabled) return 0;
    if (index === 1 && this.lfoEnabled) return 0;
    const att = ATTENUATION[ch.volume + Math.min(ch.balanceLeft, ch.balanceRight) + this.globalLeft];
    return (ch.sample * att) / CHANNEL_PEAK;
  }

  /** True while channel 2 is being spent on modulating channel 1. */
  get lfoActive(): boolean {
    return this.lfoEnabled;
  }
}
