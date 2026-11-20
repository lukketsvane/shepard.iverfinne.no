/**
 * Small offline-DSP toolbox shared by the drum kits, the plucked string and the reverb.
 * Everything works on plain Float32Arrays and is deterministic for a given seed.
 */

/** Gives the main thread back for a moment, so that long synthesis can be done in pieces between more urgent work. */
export function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Seeded generator (mulberry32) returning numbers in [0, 1). */
export function createRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a few labels, to give every sound its own seed. */
export function hashSeed(...parts: Array<string | number>): number {
  let h = 2166136261;
  for (const ch of parts.join('|')) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  }
  return h >>> 0;
}

export function whiteNoise(length: number, rand: () => number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = rand() * 2 - 1;
  return out;
}

export type FilterKind = 'lowpass' | 'highpass' | 'bandpass';

/** RBJ biquad (bandpass with constant 0 dB peak gain) run over a copy of the input. */
export function biquad(input: Float32Array, kind: FilterKind, hz: number, q: number, sampleRate: number): Float32Array {
  const w = (2 * Math.PI * Math.min(hz, sampleRate * 0.45)) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0: number;
  let b1: number;
  let b2: number;
  if (kind === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = b0;
  } else if (kind === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = b0;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;

  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/** Adds `src` into `out` starting at `offsetSec`, scaled by `gain`. */
export function mixInto(out: Float32Array, src: Float32Array, gain: number, offsetSec: number, sampleRate: number): void {
  const start = Math.round(offsetSec * sampleRate);
  const end = Math.min(out.length, start + src.length);
  for (let i = start; i < end; i++) out[i] += gain * src[i - start];
}

/** Multiplies by an exponential decay that falls 60 dB in `t60` seconds. */
export function decay(buf: Float32Array, t60: number, sampleRate: number): Float32Array {
  const per = Math.pow(0.001, 1 / (t60 * sampleRate));
  let amp = 1;
  for (let i = 0; i < buf.length; i++) {
    buf[i] *= amp;
    amp *= per;
  }
  return buf;
}

/** Feedback comb: rings at sampleRate / delay and its multiples, the sound of resonating sheet metal. */
export function comb(input: Float32Array, delay: number, feedback: number): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = input[i] + (i >= delay ? feedback * out[i - delay] : 0);
  }
  return out;
}

/**
 * A burst of filtered noise with an exponential decay, scaled to a peak of 1 so that callers
 * set levels directly: the building block of clicks, snaps and scrapes.
 */
export function noiseBurst(
  length: number,
  rand: () => number,
  sampleRate: number,
  shape: { kind: FilterKind; hz: number; q: number; t60: number }
): Float32Array {
  const filtered = biquad(whiteNoise(length, rand), shape.kind, shape.hz, shape.q, sampleRate);
  return normalise(decay(filtered, shape.t60, sampleRate), 1);
}

export interface Mode {
  hz: number;
  gain: number;
  /** Seconds to fall 60 dB. */
  t60: number;
  /** Start phase in radians; 0 gives a sharp, sine-started strike. */
  phase?: number;
}

/**
 * Sums decaying sinusoids into `out`. `drop` bends every mode down from (1 + amount) times its
 * frequency with time constant `tau`, as a struck membrane relaxes after the stroke.
 * Modes without a bend run as rotating phasors, which costs one multiply-add per sample.
 */
export function addModes(
  out: Float32Array,
  modes: Mode[],
  sampleRate: number,
  drop?: { amount: number; tau: number }
): void {
  for (const mode of modes) {
    if (mode.hz >= sampleRate * 0.45) continue;
    const amp = Math.pow(0.001, 1 / (mode.t60 * sampleRate));
    // No need to run on after the mode is 90 dB down.
    const last = Math.min(out.length, Math.ceil(1.5 * mode.t60 * sampleRate));
    const phase = mode.phase ?? 0;
    if (drop) {
      const relax = Math.exp(-1 / (drop.tau * sampleRate));
      let bend = drop.amount;
      let env = mode.gain;
      let theta = phase;
      for (let i = 0; i < last; i++) {
        out[i] += env * Math.sin(theta);
        theta += (2 * Math.PI * mode.hz * (1 + bend)) / sampleRate;
        bend *= relax;
        env *= amp;
      }
    } else {
      const w = (2 * Math.PI * mode.hz) / sampleRate;
      const rotRe = amp * Math.cos(w);
      const rotIm = amp * Math.sin(w);
      let re = mode.gain * Math.sin(phase);
      let im = mode.gain * Math.cos(phase);
      for (let i = 0; i < last; i++) {
        out[i] += re;
        const next = re * rotRe + im * rotIm;
        im = im * rotRe - re * rotIm;
        re = next;
      }
    }
  }
}

/** Soft saturation: tanh with the small-signal gain divided out, so `drive` only adds weight and harmonics. */
export function saturate(buf: Float32Array, drive: number): Float32Array {
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive) / drive;
  return buf;
}

/** Raised-cosine fade over the first `seconds`: takes the step out of a strike that starts at full displacement. */
export function fadeIn(buf: Float32Array, seconds: number, sampleRate: number): Float32Array {
  const n = Math.min(buf.length, Math.round(seconds * sampleRate));
  for (let i = 0; i < n; i++) buf[i] *= 0.5 * (1 - Math.cos((Math.PI * i) / n));
  return buf;
}

/** Raised-cosine fade over the last `seconds`, so a buffer always ends at exactly zero. */
export function fadeOut(buf: Float32Array, seconds: number, sampleRate: number): Float32Array {
  const n = Math.min(buf.length, Math.round(seconds * sampleRate));
  for (let i = 0; i < n; i++) {
    buf[buf.length - 1 - i] *= 0.5 * (1 - Math.cos((Math.PI * i) / n));
  }
  return buf;
}

export function peakOf(buf: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  return peak;
}

/** Removes the mean, so noise-driven sounds do not push the speaker cone off centre. */
export function removeDc(buf: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  const mean = sum / buf.length;
  for (let i = 0; i < buf.length; i++) buf[i] -= mean;
  return buf;
}

export function normalise(buf: Float32Array, peak: number): Float32Array {
  const current = peakOf(buf);
  if (current === 0) return buf;
  const scale = peak / current;
  for (let i = 0; i < buf.length; i++) buf[i] *= scale;
  return buf;
}

/**
 * Pink-ish noise (Kellet's filter) that loops without a seam: the tail is crossfaded into the
 * head with equal power, so the last sample runs straight on into the first.
 */
export function pinkNoiseLoop(length: number, rand: () => number): Float32Array {
  const fade = Math.round(length / 8);
  const raw = new Float32Array(length + fade);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < raw.length; i++) {
    const white = rand() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    raw[i] = 0.11 * (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362);
    b6 = white * 0.115926;
  }
  const out = raw.slice(0, length);
  for (let i = 0; i < fade; i++) {
    const w = (Math.PI / 2) * (i / fade);
    out[i] = raw[i] * Math.sin(w) + raw[length + i] * Math.cos(w);
  }
  return out;
}

/**
 * Stereo impulse response of a dark hall: a handful of early reflections, then a decorrelated
 * noise tail whose lowpass closes as it decays (air and walls take the highs first).
 */
export function renderHall(sampleRate: number, seconds: number, t60: number, seed: number): Float32Array[] {
  const length = Math.round(seconds * sampleRate);
  const preDelay = Math.round(0.012 * sampleRate);
  const reflections = [0.011, 0.017, 0.023, 0.031, 0.041, 0.053];
  return [0, 1].map((channel) => {
    const rand = createRandom(hashSeed('hall', seed, channel));
    const out = new Float32Array(length);
    let smooth = 0;
    for (let i = preDelay; i < length; i++) {
      const t = (i - preDelay) / sampleRate;
      const openness = 0.08 + 0.77 * Math.exp(-t / 0.5);
      smooth += openness * (rand() * 2 - 1 - smooth);
      // a short rise keeps the tail from starting with a click
      const rise = Math.min(1, t / 0.02);
      out[i] = smooth * rise * Math.exp((-Math.log(1000) * t) / t60);
    }
    reflections.forEach((at, k) => {
      const index = Math.round((at + 0.003 * rand()) * sampleRate);
      out[index] += (rand() < 0.5 ? -1 : 1) * 0.9 * Math.pow(0.8, k);
    });
    return out;
  });
}
