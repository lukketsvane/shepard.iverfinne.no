import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeTaper, padFrequency, padGain, ringPositions, sweepFrequency, sweepGain } from './drone';
import { foldToFloor, midiToHz, shepardPartials } from '../staircase/pitch';

const PAD_SLOTS = 9;
const SWEEP_SLOTS = 7;

test('a ring one octave apart reproduces itself after a turn of one octave', () => {
  for (const size of [PAD_SLOTS, SWEEP_SLOTS]) {
    const sorted = (turn: number) => ringPositions(turn, size).sort((a, b) => a - b);
    sorted(0.37).forEach((p, i) => assert.ok(Math.abs(p - sorted(1.37)[i]) < 1e-9));
    assert.equal(ringPositions(0.2, size).length, size);
    assert.ok(ringPositions(5.9, size).every((p) => p >= 0 && p < size));
  }
});

test('edge taper is zero at both edges, one inside, and monotone', () => {
  assert.equal(edgeTaper(0, 9), 0);
  assert.equal(edgeTaper(9, 9), 0);
  assert.equal(edgeTaper(1, 9), 1);
  assert.equal(edgeTaper(4.5, 9), 1);
  for (let p = 0; p < 1; p += 0.01) assert.ok(edgeTaper(p + 0.01, 9) >= edgeTaper(p, 9));
});

test('a slot is recycled from one edge to the other only while its gain is zero', () => {
  const rings: Array<{ size: number; gain: (turn: number, slot: number, p: number) => number }> = [
    { size: PAD_SLOTS, gain: (_t, _s, p) => padGain(padFrequency(foldToFloor(midiToHz(45)), p), p) },
    { size: SWEEP_SLOTS, gain: (_t, _s, p) => sweepGain(p) },
  ];
  for (const { size, gain } of rings) {
    for (const direction of [1, -1]) {
      let wraps = 0;
      let before = ringPositions(direction > 0 ? 0 : 20, size);
      for (let step = 1; step <= 4000; step++) {
        const turn = (direction > 0 ? 0 : 20) + (direction * step) / 1000;
        const after = ringPositions(turn, size);
        after.forEach((p, slot) => {
          if (Math.abs(p - before[slot]) > size / 2) {
            wraps++;
            assert.ok(gain(turn, slot, before[slot]) < 1e-3, `ring of ${size} loses ${gain(turn, slot, before[slot])} at the top`);
            assert.ok(gain(turn, slot, p) < 1e-3, `ring of ${size} gains ${gain(turn, slot, p)} at the bottom`);
          }
        });
        before = after;
      }
      assert.ok(wraps >= 4, 'the test must cross the seam');
    }
  }
});

test('pad components are the partials of the octave-stacked tone, to the cent and the decibel', () => {
  for (const midi of [45, 52, 57.5]) {
    for (const q of [0, 0.25, 0.6, 0.93]) {
      const base = foldToFloor(midiToHz(midi));
      const ring = ringPositions(q, PAD_SLOTS).map((p) => ({ hz: padFrequency(base, p), gain: padGain(padFrequency(base, p), p) }));
      // above the lowest octave of the ring, where it tapers, the bell is the one of the contract
      for (const partial of shepardPartials(midi, q).filter((x) => Math.log2(x.hz / base) >= 1 && x.hz < 5000)) {
        const match = ring.find((c) => Math.abs(Math.log2(c.hz / partial.hz)) < 1e-9);
        assert.ok(match, `no component at ${partial.hz} Hz`);
        assert.ok(Math.abs(match.gain - partial.gain) < 1e-9);
      }
    }
  }
});

test('the sweep reaches zero at both ends, peaks in the middle and covers 60 Hz to 7.7 kHz', () => {
  assert.equal(sweepGain(0), 0);
  assert.equal(sweepGain(SWEEP_SLOTS), 0);
  assert.ok(sweepGain(SWEEP_SLOTS / 2) > 0.999);
  for (let p = 0; p < SWEEP_SLOTS; p += 0.05) assert.ok(sweepGain(p) >= 0 && sweepGain(p) <= 1);
  assert.equal(sweepFrequency(0), 60);
  assert.ok(Math.abs(sweepFrequency(SWEEP_SLOTS) - 7680) < 1e-6);
});
