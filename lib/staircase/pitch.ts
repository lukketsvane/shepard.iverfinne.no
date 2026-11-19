/**
 * The pitch staircase.
 *
 * Every pitched sound is built from partials one octave apart under a fixed bell over
 * log-frequency. Such a tone has a pitch class but no definite octave, so moving it up by
 * an octave returns the same tone and any pitch trajectory can continue forever.
 */

import { positiveMod } from './meter';
import { SpectralPartial, TimbreId } from './types';

export interface SpectralEnvelope {
  /** Frequency at which partials are loudest. */
  centerHz: number;
  /** Standard deviation in octaves. */
  sigmaOct: number;
}

export const PAD_ENVELOPE: SpectralEnvelope = { centerHz: 240, sigmaOct: 1.5 };

/** Lowest partial sits in [FLOOR_HZ, 2 * FLOOR_HZ). */
const FLOOR_HZ = 22;
const CEILING_HZ = 9000;

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function envelopeGain(hz: number, env: SpectralEnvelope): number {
  const z = Math.log2(hz / env.centerHz) / env.sigmaOct;
  return Math.exp(-0.5 * z * z);
}

/** Lowest octave of a frequency's pitch class that is still above the floor. */
export function foldToFloor(hz: number): number {
  return FLOOR_HZ * Math.pow(2, positiveMod(Math.log2(hz / FLOOR_HZ), 1));
}

/** Partials of the octave-stacked tone on the pitch class of `midi`, raised by `pitchOct` octaves. */
export function shepardPartials(
  midi: number,
  pitchOct: number,
  env: SpectralEnvelope = PAD_ENVELOPE
): SpectralPartial[] {
  const partials: SpectralPartial[] = [];
  for (let hz = foldToFloor(midiToHz(midi) * Math.pow(2, pitchOct)); hz < CEILING_HZ; hz *= 2) {
    partials.push({ hz, gain: envelopeGain(hz, env) });
  }
  return partials;
}

/** Timbres built as one octave-stacked wavetable (the pluck is a physical model instead). */
export type WavetableTimbre = Exclude<TimbreId, 'pluck'>;

/** Harmonic numbers (relative to a 2^k octave stack) and levels that colour each timbre. */
const TIMBRE_HARMONICS: Record<WavetableTimbre, Array<{ multiple: number; level: number }>> = {
  glass: [{ multiple: 1, level: 1 }],
  organ: [
    { multiple: 1, level: 1 },
    { multiple: 3, level: 0.35 },
  ],
  reed: [
    { multiple: 1, level: 1 },
    { multiple: 3, level: 0.5 },
    { multiple: 5, level: 0.12 },
    { multiple: 7, level: 0.08 },
  ],
};

/** Fixed pseudo-random phase per harmonic, so the summed waveform is not a spike. */
function harmonicPhase(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return 2 * Math.PI * (x - Math.floor(x));
}

/**
 * Fourier coefficients of one period of an octave-stacked tone, for a PeriodicWave played at
 * `fundamentalHz`. Every set of harmonics used ({2^k}, {3 * 2^k}, ...) is closed under
 * doubling, so the tone stays octave-ambiguous. Coefficients are scaled to unit power; create
 * the PeriodicWave with normalization disabled so all pitch classes are equally loud.
 */
export function shepardWavetable(
  pitchHz: number,
  env: SpectralEnvelope,
  timbre: WavetableTimbre
): { fundamentalHz: number; real: Float32Array; imag: Float32Array } {
  const fundamentalHz = foldToFloor(pitchHz);
  const maxHarmonic = Math.floor(CEILING_HZ / fundamentalHz);
  const real = new Float32Array(maxHarmonic + 1);
  const imag = new Float32Array(maxHarmonic + 1);
  let power = 0;
  for (const { multiple, level } of TIMBRE_HARMONICS[timbre]) {
    for (let n = multiple; n <= maxHarmonic; n *= 2) {
      const amp = level * envelopeGain(n * fundamentalHz, env);
      const phase = harmonicPhase(n);
      real[n] = amp * Math.cos(phase);
      imag[n] = amp * Math.sin(phase);
      power += 0.5 * amp * amp;
    }
  }
  const scale = power > 0 ? 1 / Math.sqrt(power) : 0;
  for (let n = 0; n <= maxHarmonic; n++) {
    real[n] *= scale;
    imag[n] *= scale;
  }
  return { fundamentalHz, real, imag };
}
