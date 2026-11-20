/**
 * Drum kits, synthesised once into sample buffers.
 *
 * Each sound is a strike (a short transient), a body (modal resonances with a pitch bend) and
 * a tail, built from physical numbers: membrane modes sit at the zeros of a Bessel function
 * (1, 1.59, 2.14, 2.30 times the fundamental), free bars at 1 : 2.76 : 5.40, plates and gongs
 * at no simple ratio at all. Every sound exists in three variants and in a plain and a bright
 * version (for accents). Rendering is deterministic: a seeded generator, no Math.random.
 */

import {
  Mode,
  addModes,
  biquad,
  comb,
  createRandom,
  decay,
  fadeIn,
  fadeOut,
  hashSeed,
  mixInto,
  noiseBurst,
  normalise,
  removeDc,
  saturate,
  whiteNoise,
} from './dsp';
import { DRUM_ROLES, DrumRole, KitId } from '../staircase/types';

/** Variants per sound, played round-robin so repeated hits do not machine-gun. */
export const VARIANTS = 3;
export const KIT_PEAK = 0.9;
/** Every buffer starts and ends in exactly zero: a hit never clicks, whatever it was cut from. */
const FADE_IN_SECONDS = 0.0003;
const FADE_OUT_SECONDS = 0.04;

export interface DrumHit {
  plain: Float32Array;
  /** The same hit struck harder: more transient and upper partials. Used on accents. */
  bright: Float32Array;
}

export type Kit = Record<DrumRole, DrumHit[]>;

/**
 * Level of each sound in dB. Every buffer is peak-normalised, which says little about how loud
 * it is: a click and a gong with the same peak are far apart. These bring the roles of a kit to
 * the same K-weighted energy over the whole hit, ring included: a kick that rings for half a
 * second is much louder than its first 250 ms, and four to six layers of it sound at once.
 * Snare and perc land on one level, the hat 3 dB below it (hats come in denser streams) and the
 * kick 3 dB above (it is the weight of the groove, which a small speaker does not play: the
 * tracks above it are what keep the groove audible there). Never boosted by more than 6 dB.
 */
export const KIT_LEVEL_DB: Record<KitId, Record<DrumRole, number>> = {
  troy: { kick: -4, snare: 0, hat: 1.5, perc: -6.5 },
  aphex: { kick: -6, snare: 1, hat: 1.5, perc: -9.5 },
  hand: { kick: 0.5, snare: 0.5, hat: -6, perc: -2 },
  pure: { kick: 5, snare: 2, hat: 3, perc: -4 },
};

interface Voice {
  sampleRate: number;
  rand: () => number;
  /** 0 for the plain version, 1 for the bright one. */
  bright: number;
}

type Recipe = (voice: Voice) => Float32Array;

/** 1 + a random amount within +-spread. */
function jitter(rand: () => number, spread: number): number {
  return 1 + (rand() * 2 - 1) * spread;
}

function modesAt(base: number, ratios: number[], gains: number[], t60s: number[], rand: () => number, spread = 0): Mode[] {
  return ratios.map((ratio, i) => ({
    hz: base * ratio * jitter(rand, spread),
    gain: gains[i],
    t60: t60s[i],
  }));
}

/** Two-operator FM with a decaying modulation index: bells, gongs and metallic glitches. */
function addFm(
  out: Float32Array,
  sampleRate: number,
  fm: { carrier: number; ratio: number; index: number; indexTau: number; gain: number; t60: number }
): void {
  const amp = Math.pow(0.001, 1 / (fm.t60 * sampleRate));
  const relax = Math.exp(-1 / (fm.indexTau * sampleRate));
  let env = fm.gain;
  let index = fm.index;
  const wc = (2 * Math.PI * fm.carrier) / sampleRate;
  const wm = wc * fm.ratio;
  const last = Math.min(out.length, Math.ceil(1.5 * fm.t60 * sampleRate));
  for (let i = 0; i < last; i++) {
    out[i] += env * Math.sin(wc * i + index * Math.sin(wm * i));
    env *= amp;
    index *= relax;
  }
}

/** Sampler grit of the mid-90s: hold every sample for 1 / holdHz seconds, then quantise to `bits`. */
export function grit(buf: Float32Array, bits: number, holdHz: number, sampleRate: number): Float32Array {
  const levels = Math.pow(2, bits - 1) - 1;
  const step = holdHz / sampleRate;
  let phase = 0;
  let held = 0;
  for (let i = 0; i < buf.length; i++) {
    if (phase <= 0) {
      held = Math.round(buf[i] * levels) / levels;
      phase += 1;
    }
    phase -= step;
    buf[i] = held;
  }
  return buf;
}

// ---------------------------------------------------------------------------------------------
// troy: bronze gongs, skin war drums, sheet metal, clicky frame percussion

const troyKick: Recipe = ({ sampleRate: sr, rand, bright }) => {
  const out = new Float32Array(Math.round(0.8 * sr));
  const f0 = 58 * jitter(rand, 0.05);
  const modes = modesAt(
    f0,
    [1, 1.59, 2.14, 2.3, 2.65, 2.92, 3.16, 3.6],
    [1, 0.6, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2],
    [0.5, 0.3, 0.22, 0.2, 0.17, 0.14, 0.12, 0.1],
    rand,
    0.01
  );
  modes.forEach((mode, i) => {
    mode.phase = Math.PI / 2;
    if (i > 0) mode.gain *= 0.8 + 0.5 * bright;
  });
  // the skin is stretched further by a hard stroke and relaxes within a few tens of milliseconds
  addModes(out, modes, sr, { amount: 0.8, tau: 0.035 });
  // the knock of the stick on the skin: the part of the stroke a small speaker can play
  mixInto(out, noiseBurst(Math.round(0.06 * sr), rand, sr, { kind: 'bandpass', hz: 420, q: 0.8, t60: 0.05 }), 1.2, 0, sr);
  mixInto(out, noiseBurst(Math.round(0.02 * sr), rand, sr, { kind: 'highpass', hz: 2200, q: 0.7, t60: 0.012 }), 0.6 + 0.6 * bright, 0, sr);
  return saturate(out, 1.6);
};

const troySnare: Recipe = ({ sampleRate: sr, rand, bright }) => {
  const out = new Float32Array(Math.round(0.75 * sr));
  const base = 310 * jitter(rand, 0.06);
  const plate = modesAt(
    base,
    [1, 1.47, 2.09, 2.76, 3.52, 4.43, 5.8, 7.4],
    [0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.2],
    [0.55, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15],
    rand,
    0.03
  );
  plate.forEach((mode, i) => {
    mode.phase = rand() * Math.PI * 2;
    if (i > 3) mode.gain *= 0.6 + 0.8 * bright;
  });
  addModes(out, plate, sr);
  // the thwack of the stroke, then the sheet being scraped: noise roughened by a slow shudder
  addModes(out, [{ hz: 190, gain: 0.8, t60: 0.06, phase: Math.PI / 2 }], sr, { amount: 0.5, tau: 0.02 });
  const scrape = noiseBurst(Math.round(0.35 * sr), rand, sr, { kind: 'bandpass', hz: 5500, q: 0.7, t60: 0.22 });
  const shudder = 28 * jitter(rand, 0.2);
  for (let i = 0; i < scrape.length; i++) {
    scrape[i] *= 0.55 + 0.45 * Math.sin((2 * Math.PI * shudder * i) / sr);
  }
  mixInto(out, scrape, 1.6 + 0.8 * bright, 0, sr);
  mixInto(out, noiseBurst(Math.round(0.02 * sr), rand, sr, { kind: 'highpass', hz: 3000, q: 0.7, t60: 0.012 }), 1.2 + 0.8 * bright, 0, sr);
  return out;
};

const troyHat: Recipe = ({ sampleRate: sr, rand, bright }) => {
  const out = new Float32Array(Math.round(0.16 * sr));
  // a wooden frame rattled: a few small knocks a few milliseconds apart, each ringing the wood
  const knocks = 3 + Math.floor(rand() * 2);
  let at = 0;
  for (let k = 0; k < knocks; k++) {
    const level = Math.pow(0.65, k) * (0.8 + 0.4 * rand());
    const hz = 2900 * jitter(rand, 0.12);
    mixInto(out, noiseBurst(Math.round(0.03 * sr), rand, sr, { kind: 'bandpass', hz, q: 3, t60: 0.014 }), level, at, sr);
    const ring = new Float32Array(Math.round(0.05 * sr));
    addModes(ring, [
      { hz: 1900 * jitter(rand, 0.05), gain: 0.5, t60: 0.035 },
      { hz: 3350 * jitter(rand, 0.05), gain: 0.4 + 0.3 * bright, t60: 0.022 },
    ], sr);
    mixInto(out, ring, level, at, sr);
    at += 0.0035 + 0.004 * rand();
  }
  return out;
};

const troyPerc: Recipe = ({ sampleRate: sr, rand, bright }) => {
  const out = new Float32Array(Math.round(2.1 * sr));
  const base = 150 * jitter(rand, 0.05);
  const ratios = [1, 1.51, 2.04, 2.67, 3.28, 4.1, 5.3, 6.9, 8.6, 11.2];
  const gains = [1, 0.8, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2];
  const t60s = [1.7, 1.5, 1.3, 1.1, 1.0, 0.9, 0.8, 0.7, 0.6, 0.5];
  const gong = modesAt(base, ratios, gains, t60s, rand, 0.01);
  // every mode comes as a slightly detuned pair: the beating is the shimmer of bronze
  const pairs = gong.flatMap((mode, i) => [
    { ...mode, phase: rand() * Math.PI * 2, gain: mode.gain * (i > 4 ? 0.6 + 0.8 * bright : 1) },
    { ...mode, hz: mode.hz * 1.0035, phase: rand() * Math.PI * 2, gain: mode.gain * 0.7 },
  ]);
  addModes(out, pairs, sr);
  addFm(out, sr, { carrier: 590 * jitter(rand, 0.04), ratio: 1.414, index: 2.5, indexTau: 0.5, gain: 0.25, t60: 1.2 });
  mixInto(out, noiseBurst(Math.round(0.05 * sr), rand, sr, { kind: 'bandpass', hz: 3200, q: 1, t60: 0.025 }), 0.4 + 0.3 * bright, 0, sr);
  // the wash of a gong: bright noise that swells for a tenth of a second before it fades
  const wash = noiseBurst(Math.round(1.6 * sr), rand, sr, { kind: 'bandpass', hz: 3800, q: 0.6, t60: 1.3 });
  for (let i = 0; i < wash.length; i++) wash[i] *= Math.min(1, i / (0.1 * sr));
  mixInto(out, wash, 0.6 + 0.4 * bright, 0, sr);
  return fadeIn(out, 0.004, sr);
};

// ---------------------------------------------------------------------------------------------
// aphex: sampled in 12 bits at 26 kHz, then pushed

const SAMPLER_BITS = 12;
const SAMPLER_HOLD_HZ = 26000;

const aphexKick: Recipe = ({ sampleRate: sr, rand, bright }) => {
  const out = new Float32Array(Math.round(0.6 * sr));
  const f0 = 50 * jitter(rand, 0.04);
  addModes(out, [
    { hz: f0, gain: 1, t60: 0.38, phase: Math.PI / 2 },
    { hz: f0 * 2.02, gain: 0.25, t60: 0.15, phase: Math.PI / 2 },
  ], sr, { amount: 3, tau: 0.022 });
  mixInto(out, noiseBurst(Math.round(0.03 * sr), rand, sr, { kind: 'bandpass', hz: 900, q: 0.8, t60: 0.02 }), 0.7, 0, sr);
  mixInto(out, noiseBurst(Math.round(0.01 * sr), rand, sr, { kind: 'highpass', hz: 1800, q: 0.7, t60: 0.006 }), 0.7 + 0.6 * bright, 0, sr);
  return saturate(out, 3);
};

const aphexSnare: Recipe = ({ sampleRate: sr, rand, bright }) => {
  const out = new Float32Array(Math.round(0.4 * sr));
  // noise through a short feedback comb rings like a struck sheet of metal being dragged
  const delay = Math.round(sr * (0.0013 + 0.0012 * rand()));
  const ringing = biquad(comb(whiteNoise(out.length, rand), delay, 0.78), 'bandpass', 2400, 0.6, sr);
  mixInto(out, decay(normalise(ringing, 1), 0.22, sr), 1.4, 0, sr);
  addModes(out, modesAt(330 * jitter(rand, 0.05), [1, 1.44, 2.55, 3.85], [0.45, 0.35, 0.3, 0.25], [0.14, 0.1, 0.08, 0.06], rand), sr);
  mixInto(out, noiseBurst(Math.round(0.05 * sr), rand, sr, { kind: 'highpass', hz: 6000, q: 0.7, t60: 0.03 }), 0.4 + 0.5 * bright, 0, sr);
  return out;
};

/** 909-style metallic hat: six detuned square waves, high-passed. */
const aphexHat: Recipe = ({ sampleRate: sr, rand, bright }) => {
  const out = new Float32Array(Math.round(0.09 * sr));
  const base = 205.3 * jitter(rand, 0.03);
  for (const ratio of [1, 1.483, 1.8, 2.546, 2.63, 3.897]) {
    const w = (2 * Math.PI * base * ratio) / sr;
    for (let i = 0; i < out.length; i++) out[i] += Math.sin(w * i) >= 0 ? 1 : -1;
  }
  const metal = biquad(biquad(out, 'bandpass', 9500, 0.5, sr), 'highpass', 6500, 0.7, sr);
  return decay(normalise(metal, 1), 0.04 + 0.03 * bright, sr);
};

const aphexPerc: Recipe = ({ sampleRate: sr, rand, bright }) => {
  const out = new Float32Array(Math.round(0.5 * sr));
  const carrier = 660 * jitter(rand, 0.08);
  addFm(out, sr, { carrier, ratio: 2.76, index: 4 + 2 * bright, indexTau: 0.09, gain: 1, t60: 0.4 });
  // a glitch: the first few milliseconds stutter back, quieter each time
  const grain = out.slice(0, Math.round(0.016 * sr));
  mixInto(out, grain, 0.5, 0.11, sr);
  mixInto(out, grain, 0.3, 0.15, sr);
  return out;
};

// ---------------------------------------------------------------------------------------------
// hand: cajón, palmas, shaker, conga

const handKick: Recipe = ({ sampleRate: sr, rand, bright }) => {
  const out = new Float32Array(Math.round(0.4 * sr));
  const f0 = 78 * jitter(rand, 0.05);
  addModes(out, [
    { hz: f0, gain: 1, t60: 0.2, phase: Math.PI / 2 },
    { hz: f0 * 2.1, gain: 0.3, t60: 0.1, phase: Math.PI / 2 },
  ], sr, { amount: 0.45, tau: 0.018 });
  mixInto(out, noiseBurst(Math.round(0.02 * sr), rand, sr, { kind: 'bandpass', hz: 1200, q: 1.5, t60: 0.01 }), 0.8 + 0.5 * bright, 0, sr);
  return saturate(out, 1.3);
};

/** Palmas: several hands, a few milliseconds apart, on top of the cajón's slap. */
const handSnare: Recipe = ({ sampleRate: sr, rand, bright }) => {
  const out = new Float32Array(Math.round(0.3 * sr));
  const claps = 4;
  let at = 0;
  for (let k = 0; k < claps; k++) {
    const last = k === claps - 1;
    const burst = noiseBurst(Math.round(0.1 * sr), rand, sr, {
      kind: 'bandpass',
      hz: 1500 * jitter(rand, 0.15),
      q: 1.2,
      t60: last ? 0.07 : 0.012,
    });
    mixInto(out, burst, last ? 1 : 0.6 + 0.3 * rand(), at, sr);
    at += 0.010 + 0.005 * rand();
  }
  addModes(out, [{ hz: 190 * jitter(rand, 0.05), gain: 0.6, t60: 0.07, phase: Math.PI / 2 }], sr);
  // the snare wires of the cajón buzzing against the slap
  mixInto(out, noiseBurst(Math.round(0.2 * sr), rand, sr, { kind: 'highpass', hz: 5000, q: 0.7, t60: 0.1 }), 0.35 + 0.4 * bright, 0.004, sr);
  return out;
};

const handHat: Recipe = ({ sampleRate: sr, rand, bright }) => {
  const out = new Float32Array(Math.round(0.16 * sr));
  const rise = (0.026 - 0.012 * bright) * jitter(rand, 0.15);
  const grains = biquad(biquad(whiteNoise(out.length, rand), 'highpass', 3500, 0.7, sr), 'bandpass', 7500, 0.5, sr);
  const per = Math.pow(0.001, 1 / (0.1 * sr));
  let tail = 1;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    out[i] = grains[i] * (t < rise ? Math.sin((Math.PI / 2) * (t / rise)) : tail);
    if (t >= rise) tail *= per;
  }
  return out;
};

const handPerc: Recipe = ({ sampleRate: sr, rand, bright }) => {
  const out = new Float32Array(Math.round(0.6 * sr));
  const f0 = 250 * jitter(rand, 0.06);
  const modes = modesAt(f0, [1, 1.59, 2.14], [1, 0.25 + 0.15 * bright, 0.1], [0.38, 0.16, 0.1], rand);
  modes.forEach((mode) => (mode.phase = Math.PI / 2));
  addModes(out, modes, sr, { amount: 0.12, tau: 0.012 });
  // the slap of the fingers on the rim, and the palm's thud
  mixInto(out, noiseBurst(Math.round(0.02 * sr), rand, sr, { kind: 'bandpass', hz: 3200, q: 1.5, t60: 0.008 }), 0.8 + 0.6 * bright, 0, sr);
  mixInto(out, noiseBurst(Math.round(0.04 * sr), rand, sr, { kind: 'lowpass', hz: 450, q: 0.7, t60: 0.02 }), 0.5, 0, sr);
  return out;
};

// ---------------------------------------------------------------------------------------------
// pure: clicks and woodblocks, as in Risset's demonstrations

/** Free bar (wood block, clave): partials at 1 : 2.76 : 5.40, with the levels of the upper two as `upper`. */
function woodBlock(
  sr: number,
  hz: number,
  t60: number,
  seconds: number,
  drop: number,
  tick: number,
  rand: () => number,
  upper: [number, number] = [0.25, 0.08]
): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  const modes = [1, 2.76, 5.4].map((ratio, i) => ({
    hz: hz * ratio,
    gain: [1, ...upper][i],
    t60: t60 / (1 + i),
    phase: Math.PI / 2,
  }));
  addModes(out, modes, sr, drop > 0 ? { amount: drop, tau: 0.006 } : undefined);
  if (tick > 0) {
    mixInto(out, noiseBurst(Math.round(0.006 * sr), rand, sr, { kind: 'highpass', hz: 3000, q: 0.7, t60: 0.003 }), tick, 0, sr);
  }
  return out;
}

/** The lowest block of the set, with its upper partials strong enough to carry it on a small speaker. */
const pureKick: Recipe = ({ sampleRate: sr, rand, bright }) =>
  woodBlock(sr, 170 * jitter(rand, 0.03), 0.13, 0.25, 0.1, 0.3 + 0.3 * bright, rand, [0.7, 0.3]);

const pureSnare: Recipe = ({ sampleRate: sr, rand, bright }) =>
  woodBlock(sr, 620 * jitter(rand, 0.03), 0.09, 0.2, 0, 0.15 + 0.25 * bright, rand);

const pureHat: Recipe = ({ sampleRate: sr, rand, bright }) => {
  const out = new Float32Array(Math.round(0.05 * sr));
  const hz = 4300 * jitter(rand, 0.03);
  addModes(out, [
    { hz, gain: 1, t60: 0.014, phase: Math.PI / 2 },
    { hz: hz * 1.42, gain: 0.5 + 0.3 * bright, t60: 0.009, phase: Math.PI / 2 },
  ], sr);
  return out;
};

const pureClave: Recipe = ({ sampleRate: sr, rand, bright }) =>
  woodBlock(sr, 2500 * jitter(rand, 0.02), 0.16, 0.3, 0, 0.05 + 0.15 * bright, rand);

const RECIPES: Record<KitId, Record<DrumRole, Recipe>> = {
  troy: { kick: troyKick, snare: troySnare, hat: troyHat, perc: troyPerc },
  aphex: { kick: aphexKick, snare: aphexSnare, hat: aphexHat, perc: aphexPerc },
  hand: { kick: handKick, snare: handSnare, hat: handHat, perc: handPerc },
  pure: { kick: pureKick, snare: pureSnare, hat: pureHat, perc: pureClave },
};

/** One drum sound, peak-normalised, ending in exactly zero. */
export function renderDrum(kit: KitId, role: DrumRole, variant: number, bright: boolean, sampleRate: number): Float32Array {
  const rand = createRandom(hashSeed(kit, role, variant));
  const raw = RECIPES[kit][role]({ sampleRate, rand, bright: bright ? 1 : 0 });
  const out = normalise(fadeOut(fadeIn(removeDc(raw), FADE_IN_SECONDS, sampleRate), FADE_OUT_SECONDS, sampleRate), KIT_PEAK);
  // holding samples can skip the peak, so the sampler's grit is followed by a second normalisation
  return kit === 'aphex' ? normalise(grit(out, SAMPLER_BITS, SAMPLER_HOLD_HZ, sampleRate), KIT_PEAK) : out;
}

export function renderKit(kit: KitId, sampleRate: number): Kit {
  const result = {} as Kit;
  for (const role of DRUM_ROLES) {
    result[role] = Array.from({ length: VARIANTS }, (_, variant) => ({
      plain: renderDrum(kit, role, variant, false, sampleRate),
      bright: renderDrum(kit, role, variant, true, sampleRate),
    }));
  }
  return result;
}
