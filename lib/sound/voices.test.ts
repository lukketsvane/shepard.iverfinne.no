import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_ENVELOPE,
  loudness,
  nearestPluckRef,
  pitchClassStep,
  pluckCopies,
  pluckRefHz,
  renderPluck,
} from './voices';
import { foldToFloor, shepardWavetable } from '../staircase/pitch';
import { PitchedRole } from '../staircase/types';

const SAMPLE_RATE = 48000;
const ROLES = Object.keys(VOICE_ENVELOPE) as PitchedRole[];

test('pitch class steps are octave-invariant and land within 2.5 cents of the table', () => {
  for (let hz = 20; hz < 4000; hz *= 1.0137) {
    const step = pitchClassStep(hz);
    assert.equal(pitchClassStep(hz * 2).index, step.index);
    assert.ok(step.index >= 0 && step.index < 240);
    assert.ok(Math.abs(Math.log2(step.ratio)) * 1200 <= 2.5 + 1e-6);
    // the oscillator, run at the table's fundamental times the ratio, is exactly the pitch class
    const table = shepardWavetable(Math.pow(2, step.index / 240), VOICE_ENVELOPE.keys, 'organ');
    assert.ok(Math.abs(table.fundamentalHz * step.ratio / foldToFloor(hz) - 1) < 1e-9, `hz ${hz}`);
  }
});

/** Amplitude of every harmonic of a wavetable, keyed by its frequency in Hz (rounded to 0.1). */
function spectrum(pitchHz: number, role: PitchedRole): Map<number, number> {
  const { fundamentalHz, real, imag } = shepardWavetable(pitchHz, VOICE_ENVELOPE[role], 'glass');
  const partials = new Map<number, number>();
  for (let n = 1; n < real.length; n++) {
    const amp = Math.hypot(real[n], imag[n]);
    if (amp > 0) partials.set(Math.round(n * fundamentalHz * 10) / 10, amp);
  }
  return partials;
}

test('wavetables on either side of the octave seam differ only by a barely audible partial at the floor', () => {
  for (const role of ROLES) {
    const below = spectrum(43.99, role);
    const above = spectrum(44.01, role);
    let diff = 0;
    let power = 0;
    // 0.2 Hz of tolerance in the keys, because the stacks are at 43.99 x 2^k and 22.005 x 2^k
    for (const [hz, amp] of above) {
      const match = [...below].find(([other]) => Math.abs(other / hz - 1) < 0.001);
      diff += (amp - (match?.[1] ?? 0)) ** 2;
      power += amp * amp;
    }
    assert.ok(diff / power < 0.03, `${role}: ${(100 * diff) / power} % of the power changes at the seam`);
  }
});

test('pluck copies are octave-invariant, power-normalised and span one to three octaves', () => {
  for (const role of ROLES) {
    const env = VOICE_ENVELOPE[role];
    for (let hz = 30; hz < 60; hz *= 1.01) {
      const copies = pluckCopies(hz, env);
      const again = pluckCopies(hz * 4, env);
      assert.deepEqual(
        copies.map((c) => [Math.round(c.hz * 100), c.weight.toFixed(9)]),
        again.map((c) => [Math.round(c.hz * 100), c.weight.toFixed(9)])
      );
      assert.ok(copies.length >= 1 && copies.length <= 3, `${role}: ${copies.length} copies`);
      assert.ok(copies.every((c) => c.weight > 0));
      assert.ok(Math.abs(copies.reduce((sum, c) => sum + c.weight ** 2, 0) - 1) < 1e-9);
      for (const copy of copies) {
        assert.ok(Math.abs(Math.log2(copy.hz / env.centerHz)) < 1.25 + 1e-9, 'copy outside the reach');
      }
    }
  }
});

test('pluck weights change continuously as the pitch class climbs through the octave', () => {
  for (const role of ROLES) {
    const env = VOICE_ENVELOPE[role];
    const tracked = (hz: number) =>
      Array.from({ length: 14 }, (_, k) => {
        const f = hz * Math.pow(2, k - 1);
        return pluckCopies(hz, env).find((c) => Math.abs(c.hz / f - 1) < 1e-6)?.weight ?? 0;
      });
    let previous = tracked(22);
    for (let cents = 1; cents <= 1200; cents++) {
      const now = tracked(22 * Math.pow(2, cents / 1200));
      now.forEach((w, k) => assert.ok(Math.abs(w - previous[k]) < 0.02, `${role}: copy ${k} jumps at ${cents} cents`));
      previous = now;
    }
  }
});

test('reference strings cover the roles and a note is resampled by less than a quarter octave', () => {
  for (const role of ROLES) {
    const env = VOICE_ENVELOPE[role];
    for (let hz = 30; hz < 60; hz *= 1.05) {
      for (const copy of pluckCopies(hz, env)) {
        const index = nearestPluckRef(copy.hz);
        assert.ok(index >= 0 && index < 14);
        assert.ok(Math.abs(Math.log2(copy.hz / pluckRefHz(index))) <= 0.25 + 1e-9, `${role} ${copy.hz} Hz`);
      }
    }
  }
});

function energy(buf: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = Math.round(from * SAMPLE_RATE); i < Math.round(to * SAMPLE_RATE); i++) sum += buf[i] ** 2;
  return sum;
}

/** Fundamental from the strongest autocorrelation lag within a quarter octave of the expected one. */
function estimateHz(buf: Float32Array, expected: number): number {
  const span = Math.round(0.4 * SAMPLE_RATE);
  let best = 0;
  let bestLag = 0;
  const lo = Math.floor(SAMPLE_RATE / (expected * 1.19));
  const hi = Math.ceil(SAMPLE_RATE / (expected / 1.19));
  for (let lag = lo; lag <= hi; lag++) {
    let sum = 0;
    for (let i = 0; i < span; i++) sum += buf[i] * buf[i + lag];
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  // parabolic refinement of the peak
  const at = (lag: number) => {
    let sum = 0;
    for (let i = 0; i < span; i++) sum += buf[i] * buf[i + lag];
    return sum;
  };
  const [a, b, c] = [at(bestLag - 1), at(bestLag), at(bestLag + 1)];
  const offset = (0.5 * (a - c)) / (a - 2 * b + c);
  return SAMPLE_RATE / (bestLag + offset);
}

test('a plucked string is deterministic, in tune, and dies away to silence', () => {
  for (const hz of [55, 110, 233.08, 440, 880, 1760]) {
    const string = renderPluck(hz, SAMPLE_RATE, 1);
    assert.deepEqual(string, renderPluck(hz, SAMPLE_RATE, 1));
    assert.notDeepEqual(string, renderPluck(hz, SAMPLE_RATE, 2));
    assert.ok(string.every(Number.isFinite));
    assert.ok(Math.abs(string.reduce((p, x) => Math.max(p, Math.abs(x)), 0) - 0.9) < 1e-6);
    const found = estimateHz(string, hz);
    assert.ok(Math.abs(Math.log2(found / hz)) * 1200 < 8, `${hz} Hz string sounds at ${found}`);
    const seconds = string.length / SAMPLE_RATE;
    assert.ok(energy(string, 0.5, 0.6) < energy(string, 0, 0.1), 'the string does not decay');
    assert.ok(energy(string, seconds - 0.05, seconds) < 1e-6 * energy(string, 0, 0.1), 'the tail is not silent');
    assert.ok(Math.abs(string[string.length - 1]) < 1e-9);
  }
});

test('higher strings die away faster', () => {
  const low = renderPluck(110, SAMPLE_RATE, 1);
  const high = renderPluck(1760, SAMPLE_RATE, 1);
  const ratio = (buf: Float32Array) => energy(buf, 0.9, 1) / energy(buf, 0, 0.1);
  assert.ok(ratio(high) < ratio(low) * 0.1);
});

test('loudness curve keeps unity and lets quiet notes fall faster than linear', () => {
  assert.equal(loudness(1), 1);
  assert.equal(loudness(0), 0);
  assert.ok(loudness(0.5) < 0.5);
});
