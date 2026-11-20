import test from 'node:test';
import assert from 'node:assert/strict';
import { KIT_LEVEL_DB, KIT_PEAK, VARIANTS, grit, renderDrum, renderKit } from './kits';
import { DRUM_ROLES, DrumRole, KitId } from '../staircase/types';

const SAMPLE_RATE = 48000;
const KITS: KitId[] = ['troy', 'aphex', 'hand', 'pure'];

function peak(buf: Float32Array): number {
  return buf.reduce((p, x) => Math.max(p, Math.abs(x)), 0);
}

/** Power-weighted mean frequency from a naive DFT on a thinned frequency grid. */
function centroid(buf: Float32Array): number {
  const n = Math.min(buf.length, 8192);
  let num = 0;
  let den = 0;
  for (let hz = 40; hz < 20000; hz *= 1.03) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * hz) / SAMPLE_RATE;
    for (let i = 0; i < n; i++) {
      re += buf[i] * Math.cos(w * i);
      im += buf[i] * Math.sin(w * i);
    }
    // each grid point stands for a log-spaced band, so weight by its width
    const power = (re * re + im * im) * hz;
    num += power * hz;
    den += power;
  }
  return num / den;
}

test('every drum sound is finite, peak-normalised and starts and ends in silence', () => {
  for (const kit of KITS) {
    const rendered = renderKit(kit, SAMPLE_RATE);
    for (const role of DRUM_ROLES) {
      assert.equal(rendered[role].length, VARIANTS);
      for (const hit of rendered[role]) {
        for (const buf of [hit.plain, hit.bright]) {
          const label = `${kit}/${role}`;
          assert.ok(buf.every(Number.isFinite), `${label} has NaN or Infinity`);
          assert.ok(peak(buf) <= KIT_PEAK + 1e-6 && peak(buf) > KIT_PEAK - 0.02, `${label} peak ${peak(buf)}`);
          assert.ok(Math.abs(buf[0]) < 0.01, `${label} starts with a step`);
          const tail = buf.subarray(buf.length - Math.round(0.005 * SAMPLE_RATE));
          // -60 dB relative to the 0.9 peak
          assert.ok(peak(tail) < KIT_PEAK * 0.001, `${label} does not decay to silence (${peak(tail)})`);
        }
      }
    }
  }
});

test('rendering is deterministic, variants differ, bright differs from plain', () => {
  for (const kit of KITS) {
    for (const role of DRUM_ROLES) {
      const a = renderDrum(kit, role, 0, false, SAMPLE_RATE);
      const again = renderDrum(kit, role, 0, false, SAMPLE_RATE);
      assert.deepEqual(a, again, `${kit}/${role} is not deterministic`);
      const other = renderDrum(kit, role, 1, false, SAMPLE_RATE);
      const bright = renderDrum(kit, role, 0, true, SAMPLE_RATE);
      // compare the strike: the first 100 ms
      const length = Math.min(Math.round(0.1 * SAMPLE_RATE), a.length, other.length, bright.length);
      const distance = (x: Float32Array, y: Float32Array) => {
        let sum = 0;
        for (let i = 0; i < length; i++) sum += (x[i] - y[i]) ** 2;
        return Math.sqrt(sum / length);
      };
      assert.ok(distance(a, other) > 0.005, `${kit}/${role} variants are alike`);
      assert.ok(distance(a, bright) > 0.002, `${kit}/${role} bright version is alike`);
    }
  }
});

test('roles keep their place in the spectrum in every kit', () => {
  const centroids = new Map<string, number>();
  for (const kit of KITS) {
    for (const role of DRUM_ROLES) {
      centroids.set(`${kit}/${role}`, centroid(renderDrum(kit, role, 0, false, SAMPLE_RATE)));
    }
    const c = (role: DrumRole) => centroids.get(`${kit}/${role}`)!;
    assert.ok(c('kick') < 400, `${kit} kick centroid ${c('kick')}`);
    assert.ok(c('hat') > 2000, `${kit} hat centroid ${c('hat')}`);
    assert.ok(c('kick') < c('snare') && c('snare') < c('hat'), `${kit} kick < snare < hat`);
  }
});

test('bright hits carry more high-frequency energy than plain ones, on average', () => {
  let ratio = 0;
  let count = 0;
  for (const kit of KITS) {
    for (const role of DRUM_ROLES) {
      ratio += centroid(renderDrum(kit, role, 0, true, SAMPLE_RATE)) / centroid(renderDrum(kit, role, 0, false, SAMPLE_RATE));
      count++;
    }
  }
  assert.ok(ratio / count > 1.03, `mean centroid ratio ${ratio / count}`);
});

test('grit holds samples and quantises them to the given depth', () => {
  const ramp = Float32Array.from({ length: 4800 }, (_, i) => (i / 4800) * 0.9);
  const crushed = grit(ramp.slice(), 12, 24000, SAMPLE_RATE);
  // 24 kHz out of 48 kHz: every pair of samples is equal
  for (let i = 0; i < crushed.length - 1; i += 2) assert.equal(crushed[i], crushed[i + 1]);
  // after normalising the peak the quantisation steps are 1/2047 of the original scale
  const steps = new Set(Array.from(crushed, (x) => Math.round(x * 2047)));
  for (const x of crushed) assert.ok(Math.abs(x * 2047 - Math.round(x * 2047)) < 1e-3);
  assert.ok(steps.size <= 1844, `${steps.size} distinct levels for a ramp to 0.9 at 12 bits`);
});

/** K-weighting of ITU-R BS.1770 at 48 kHz: a high shelf, then a high-pass at 38 Hz. */
function kWeighted(buf: Float32Array): Float64Array {
  const stages = [
    { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] },
    { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] },
  ];
  let signal = Float64Array.from(buf);
  for (const { b, a } of stages) {
    const next = new Float64Array(signal.length);
    for (let i = 0; i < signal.length; i++) {
      next[i] =
        b[0] * signal[i] +
        b[1] * (signal[i - 1] ?? 0) +
        b[2] * (signal[i - 2] ?? 0) -
        a[0] * (next[i - 1] ?? 0) -
        a[1] * (next[i - 2] ?? 0);
    }
    signal = next;
  }
  return signal;
}

/** K-weighted energy (dB) of the whole hit, ring included, averaged over the three variants. */
function hitEnergyDb(kit: KitId, role: DrumRole): number {
  const energies = [0, 1, 2].map((variant) =>
    kWeighted(renderDrum(kit, role, variant, false, SAMPLE_RATE)).reduce((sum, x) => sum + x * x, 0)
  );
  return 10 * Math.log10(energies.reduce((a, b) => a + b) / energies.length);
}

/** Where each role lands once levelled: snare and perc on one level, the hat 3 dB below, the kick 3 dB above. */
const ROLE_ENERGY_DB: Record<DrumRole, number> = { kick: 25, snare: 22, hat: 19, perc: 22 };

test('kit levels bring every hit of a kit to its role\'s K-weighted energy over the whole ring, as far as 6 dB of boost allows', () => {
  for (const kit of KITS) {
    for (const role of DRUM_ROLES) {
      const level = KIT_LEVEL_DB[kit][role];
      assert.ok(level <= 6, `${kit}/${role} is boosted by ${level} dB`);
      const leveled = hitEnergyDb(kit, role) + level;
      assert.ok(Math.abs(leveled - ROLE_ENERGY_DB[role]) <= 1, `${kit}/${role}: ${leveled.toFixed(1)} dB, wanted ${ROLE_ENERGY_DB[role]}`);
    }
  }
});
