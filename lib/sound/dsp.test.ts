import test from 'node:test';
import assert from 'node:assert/strict';
import { addModes, biquad, createRandom, hashSeed, pinkNoiseLoop, renderHall, whiteNoise } from './dsp';

const SAMPLE_RATE = 48000;

/** Magnitude of the DFT at one frequency. */
function magnitude(buf: Float32Array, hz: number, from = 0, to = buf.length): number {
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * hz) / SAMPLE_RATE;
  for (let i = from; i < to; i++) {
    re += buf[i] * Math.cos(w * i);
    im += buf[i] * Math.sin(w * i);
  }
  return Math.hypot(re, im);
}

test('the generator is deterministic, uniform and seeded apart', () => {
  const a = createRandom(hashSeed('a'));
  const b = createRandom(hashSeed('a'));
  const c = createRandom(hashSeed('b'));
  const xs = Array.from({ length: 2000 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 2000 }, () => b()));
  assert.notDeepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => c()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(Math.abs(xs.reduce((s, x) => s + x) / xs.length - 0.5) < 0.03);
});

test('biquads pass their band and stop the rest', () => {
  const noise = whiteNoise(SAMPLE_RATE, createRandom(1));
  const low = biquad(noise, 'lowpass', 500, 0.7, SAMPLE_RATE);
  const high = biquad(noise, 'highpass', 5000, 0.7, SAMPLE_RATE);
  const band = biquad(noise, 'bandpass', 2000, 4, SAMPLE_RATE);
  assert.ok(magnitude(low, 100) > 5 * magnitude(low, 5000));
  assert.ok(magnitude(high, 12000) > 5 * magnitude(high, 500));
  assert.ok(magnitude(band, 2000) > 5 * magnitude(band, 6000));
  assert.ok(magnitude(band, 2000) > 5 * magnitude(band, 600));
});

test('modes ring at their frequency, fall 60 dB in t60 seconds, and bend down after the stroke', () => {
  const out = new Float32Array(SAMPLE_RATE);
  addModes(out, [{ hz: 1000, gain: 1, t60: 0.4, phase: Math.PI / 2 }], SAMPLE_RATE);
  assert.ok(Math.abs(out[0] - 1) < 1e-6);
  const at = (seconds: number) => Math.max(...out.subarray(Math.round(seconds * SAMPLE_RATE), Math.round(seconds * SAMPLE_RATE) + 48).map(Math.abs));
  assert.ok(Math.abs(at(0.4) - 0.001) < 0.0002, `${at(0.4)} after t60`);
  assert.ok(magnitude(out, 1000) > 20 * magnitude(out, 1100));

  const bent = new Float32Array(SAMPLE_RATE);
  addModes(bent, [{ hz: 100, gain: 1, t60: 0.8 }], SAMPLE_RATE, { amount: 1, tau: 0.02 });
  // the first 20 ms hold twice the frequency, the last 200 ms the settled one
  assert.ok(magnitude(bent, 200, 0, 960) > magnitude(bent, 100, 0, 960));
  assert.ok(magnitude(bent, 100, 24000, 33600) > 3 * magnitude(bent, 200, 24000, 33600));
});

test('the hall decays, starts after its pre-delay, and is wide and darker in the tail', () => {
  const [left, right] = renderHall(SAMPLE_RATE, 2.4, 2.2, 1);
  assert.equal(left.length, Math.round(2.4 * SAMPLE_RATE));
  assert.ok(left.every(Number.isFinite) && right.every(Number.isFinite));
  assert.ok(left.subarray(0, Math.round(0.01 * SAMPLE_RATE)).every((x) => x === 0), 'pre-delay');

  // Schroeder backward integration of the energy: time to fall 60 dB
  let total = 0;
  for (const x of left) total += x * x;
  let remaining = total;
  let rt60 = 0;
  for (let i = 0; i < left.length; i++) {
    remaining -= left[i] * left[i];
    if (10 * Math.log10(Math.max(remaining, 1e-30) / total) < -30) {
      rt60 = (2 * i) / SAMPLE_RATE;
      break;
    }
  }
  assert.ok(rt60 > 1.2 && rt60 < 2.6, `RT60 ${rt60}`);

  let cross = 0;
  let energyL = 0;
  let energyR = 0;
  for (let i = 0; i < left.length; i++) {
    cross += left[i] * right[i];
    energyL += left[i] ** 2;
    energyR += right[i] ** 2;
  }
  assert.ok(Math.abs(cross / Math.sqrt(energyL * energyR)) < 0.1, 'channels should be decorrelated');

  const ratio = (from: number, to: number) =>
    magnitude(left, 6000, Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE)) /
    magnitude(left, 600, Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE));
  assert.ok(ratio(1.5, 2) < 0.5 * ratio(0.05, 0.4), 'the tail should be darker than the start');
});

test('pink noise loops without a seam and falls with frequency', () => {
  const loop = pinkNoiseLoop(SAMPLE_RATE, createRandom(7));
  let step = 0;
  for (let i = 1; i < loop.length; i++) step += Math.abs(loop[i] - loop[i - 1]);
  step /= loop.length - 1;
  assert.ok(Math.abs(loop[0] - loop[loop.length - 1]) < 6 * step, 'seam');
  // equal energy per octave: a 100 Hz-wide band at 200 Hz carries more than one at 6.4 kHz
  const band = (hz: number) => magnitude(loop, hz) ** 2;
  assert.ok(band(200) > 4 * band(6400));
});
