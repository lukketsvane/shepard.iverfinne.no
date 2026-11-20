import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeLayers,
  advanceState,
  ceilingGain,
  createState,
  layerWindow,
  loopSpec,
  pickSoloLayer,
  scheduleSegment,
  steppedPitch,
  windowNorm,
  WINDOW_SIGMAS,
} from './core';
import { annotateTrack, metricRate } from './meter';
import { appliedSlopes, createSlopeMotion, stepSlopes } from './control';
import { PAD_ENVELOPE, shepardPartials, shepardWavetable } from './pitch';
import { LayerRatio, Meter, StairEvent, StairParams, StairState, Track } from './types';

const FOUR_FOUR: Meter = { label: '4/4', beatsPerBar: 4, divisions: [2, 2, 2, 2] };
const SIX_EIGHT: Meter = { label: '6/8', beatsPerBar: 2, divisions: [2, 3, 2] };
/** The same bar as SIX_EIGHT felt in three. */
const HEMIOLA: Meter = { label: '3 over 2', beatsPerBar: 2, divisions: [3, 2, 2] };
const RATIOS: LayerRatio[] = [2, 1.5, 3];

function params(patch: Partial<StairParams> = {}): StairParams {
  return {
    focusBpm: 120,
    tempoSlope: 2,
    pitchSlope: 0,
    pitchLink: false,
    pitchStep: 0,
    ratio: 2,
    spread: 0.85,
    flutterHz: 12,
    levels: { drums: 1, melody: 1, pad: 0, sweep: 0, tape: 0, reverb: 0 },
    master: 1,
    solo: false,
    ...patch,
  };
}

/** One bar of sixteenth-note hats in 4/4. */
function hatTrack(): Track {
  const notes = Array.from({ length: 16 }, (_, i) => ({ beat: i / 4, dur: 0.1, midi: 0, vel: 1, rate: 0 }));
  return annotateTrack(
    { id: 'hat', role: 'hat', lengthBeats: 4, notes, gain: 1, center: 0, maxHz: 13 },
    FOUR_FOUR
  );
}

function pulseTrack(): Track {
  return annotateTrack(
    {
      id: 'pulse',
      role: 'kick',
      lengthBeats: 1,
      notes: [{ beat: 0, dur: 0.1, midi: 0, vel: 1, rate: 0 }],
      gain: 1,
      center: 0,
      maxHz: 40,
    },
    FOUR_FOUR
  );
}

/** Deterministic pseudo-random numbers in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Run the scheduler over [0, seconds) in segments of irregular length. */
function run(
  p: StairParams,
  tracks: Track[],
  seconds: number,
  start: StairState,
  pitchSlope = p.pitchSlope,
  seed = 7
): { events: StairEvent[]; state: StairState } {
  const rand = lcg(seed);
  let state = start;
  const events: StairEvent[] = [];
  while (state.time < seconds - 1e-12) {
    const dt = Math.min(seconds - state.time, 0.02 + 0.09 * rand());
    events.push(...scheduleSegment(state, dt, p.tempoSlope, pitchSlope, p, tracks));
    state = advanceState(state, dt, p.tempoSlope, pitchSlope, p);
  }
  return { events, state };
}

test('metricRate ranks positions by the coarsest grid that contains them', () => {
  assert.equal(metricRate(0, FOUR_FOUR), 0.25);
  assert.equal(metricRate(2, FOUR_FOUR), 0.5);
  assert.equal(metricRate(1, FOUR_FOUR), 1);
  assert.equal(metricRate(0.5, FOUR_FOUR), 2);
  assert.equal(metricRate(0.25, FOUR_FOUR), 4);
  assert.equal(metricRate(1 / 3, FOUR_FOUR), 8);
  assert.equal(metricRate(0, SIX_EIGHT), 0.5);
  assert.equal(metricRate(1, SIX_EIGHT), 1);
  assert.equal(metricRate(1 / 3, SIX_EIGHT), 3);
  assert.equal(metricRate(1 / 6, SIX_EIGHT), 6);
  // every other eighth of the bar is a beat when the bar is felt in three
  assert.equal(metricRate(2 / 3, HEMIOLA), 1.5);
  assert.equal(metricRate(2 / 3, SIX_EIGHT), 3);
});

test('a displaced melody line keeps the rate of its spacing, drums keep their metric rate', () => {
  const line: Track = {
    id: 'line',
    role: 'keys',
    lengthBeats: 4,
    notes: [0.5, 1.5, 2.5, 3.5].map((beat) => ({ beat, dur: 1, midi: 60, vel: 1, rate: 0 })),
    gain: 1,
    center: 0,
    maxHz: 9,
  };
  assert.deepEqual(annotateTrack(line, FOUR_FOUR).notes.map((n) => n.rate), [1, 1, 1, 1]);
  assert.deepEqual(
    annotateTrack({ ...line, role: 'perc' }, FOUR_FOUR).notes.map((n) => n.rate),
    [2, 2, 2, 2]
  );
});

test('window reaches zero at its edge and the layer sum is flat', () => {
  assert.equal(layerWindow(WINDOW_SIGMAS), 0);
  assert.equal(layerWindow(0), 1);
  for (const ratio of RATIOS) {
    const spacing = Math.log2(ratio);
    const spread = 0.85;
    const norm = windowNorm(spread, ratio);
    for (let i = 0; i < 50; i++) {
      const u = i / 50;
      let sum = 0;
      for (let j = -12; j <= 12; j++) sum += layerWindow(((u - j) * spacing) / spread);
      assert.ok(Math.abs(sum * norm - 1) < 0.02, `ratio ${ratio}: sum ${sum * norm}`);
    }
  }
});

test('ceilingGain is 1 well below the ceiling, 0.5 on it, 0 well above', () => {
  assert.equal(ceilingGain(4, 12), 1);
  assert.ok(Math.abs(ceilingGain(12, 12) - 0.5) < 1e-12);
  assert.equal(ceilingGain(24, 12), 0);
});

test('neighbouring layers stay locked at exactly ratio:1 under arbitrary slopes', () => {
  for (const ratio of RATIOS) {
    const p = params({ ratio });
    const rand = lcg(3);
    let state: StairState = { ...createState(), phi: 0.37 };
    for (let step = 0; step < 3000; step++) {
      const slope = 2 + 6 * Math.sin(step * 0.013) + 6 * (rand() - 0.5);
      state = advanceState(state, 0.02 + 0.04 * rand(), slope, 0, p);
      assert.ok(state.u >= 0 && state.u < 1);
      const layers = activeLayers(state, p);
      for (let i = 0; i + 1 < layers.length; i++) {
        // layersInRange lists the fastest layer first
        const fast = layers[i];
        const slow = layers[i + 1];
        assert.equal(fast.id + 1, slow.id);
        assert.ok(Math.abs(fast.beatHz / slow.beatHz - ratio) < 1e-9);
        assert.ok(Math.abs(fast.phase - ratio * slow.phase) <= 1e-9 * Math.max(1, Math.abs(fast.phase)));
      }
    }
  }
});

test('a physical layer keeps its id and a continuous phase across relabelling', () => {
  const p = params({ spread: 1.3 });
  let state: StairState = { ...createState(), phi: 5 };
  const tracked = activeLayers(state, p).find((l) => Math.abs(l.xOct) < 0.5)!;
  let lastPhase = tracked.phase;
  for (let step = 0; step < 400; step++) {
    state = advanceState(state, 0.05, 6, 0, p);
    const layer = activeLayers(state, p).find((l) => l.id === tracked.id);
    if (!layer) break;
    assert.ok(layer.phase > lastPhase, 'phase must keep increasing');
    assert.ok(layer.phase - lastPhase < 3, 'phase must not jump');
    lastPhase = layer.phase;
  }
  assert.ok(state.relabels >= 1, 'the run should cross at least one relabelling');
});

test('onset times do not depend on how time is cut into segments', () => {
  for (const ratio of RATIOS) {
    for (const tempoSlope of [3, 0, -3]) {
      const p = params({ ratio, tempoSlope });
      const start: StairState = { ...createState(), phi: 2.2 };
      // hits of different layers coincide exactly, so order them by more than time
      const order = (x: StairEvent, y: StairEvent) =>
        Math.round((x.time - y.time) * 1e6) || x.layerId - y.layerId || x.noteIndex - y.noteIndex;
      const a = run(p, [hatTrack()], 6, start, 0, 11).events.sort(order);
      const b = run(p, [hatTrack()], 6, start, 0, 99).events.sort(order);
      assert.equal(a.length, b.length, `ratio ${ratio} slope ${tempoSlope}`);
      assert.ok(a.length > 50);
      for (let i = 0; i < a.length; i++) {
        assert.ok(Math.abs(a[i].time - b[i].time) < 1e-7);
        assert.ok(Math.abs(a[i].gain - b[i].gain) < 1e-6);
      }
    }
  }
});

test('closed-form onsets agree with brute-force integration of the tempo curve', () => {
  const p = params({ tempoSlope: 4, spread: 0.6 });
  const start = createState();
  const events = run(p, [pulseTrack()], 3, start).events;
  const layerId = events[0].layerId;
  const expected = events.filter((e) => e.layerId === layerId).map((e) => e.time);

  const layer = activeLayers(start, p).find((l) => l.id === layerId)!;
  const growth = (p.tempoSlope * Math.LN2) / 60;
  const dt = 1e-5;
  let phase = layer.phase;
  const found: number[] = [0];
  for (let t = 0; t < 3; t += dt) {
    const next = phase + layer.beatHz * Math.exp(growth * (t + dt / 2)) * dt;
    if (Math.floor(next) > Math.floor(phase)) found.push(t + dt);
    phase = next;
  }
  // The scheduler stops emitting a layer once it leaves the window; compare the common part.
  assert.ok(expected.length > 4);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(expected[i] - found[i]) < 1e-4, `onset ${i}: ${expected[i]} vs ${found[i]}`);
  }
});

test('a constant slope repeats exactly after one ratio step (the seamless loop)', () => {
  for (const ratio of RATIOS) {
    for (const tempoSlope of [2, -2, 5]) {
      const p = params({ ratio, tempoSlope, pitchSlope: 0.7 });
      const spec = loopSpec(p)!;
      assert.ok(Math.abs(spec.seconds - (60 * Math.log2(ratio)) / Math.abs(tempoSlope)) < 1e-9);
      const tracks = [hatTrack(), pulseTrack()];
      const both = run(p, tracks, 2 * spec.seconds, spec.state, spec.pitchSlope);
      const first = both.events.filter((e) => e.time < spec.seconds);
      const second = both.events.filter((e) => e.time >= spec.seconds);
      assert.ok(first.length > 100);
      assert.equal(first.length, second.length, `ratio ${ratio} slope ${tempoSlope}`);
      const key = (e: StairEvent, shift: number) =>
        `${(e.time - shift).toFixed(6)}|${e.trackId}|${e.noteIndex}|${e.gain.toFixed(5)}|${e.pitchOct.toFixed(5)}`;
      const a = first.map((e) => key(e, 0)).sort();
      const b = second.map((e) => key(e, spec.seconds)).sort();
      assert.deepEqual(a, b);
      // and the pitch staircase is back where it started
      assert.ok(Math.min(both.state.q, 1 - both.state.q) < 1e-9);
    }
  }
});

test('loopSpec refuses a zero slope', () => {
  assert.equal(loopSpec(params({ tempoSlope: 0 })), null);
});

test('the amount of sound is the same at every point of the cycle', () => {
  const p = params({ tempoSlope: 2 });
  const spec = loopSpec(p)!;
  const events = run(p, [hatTrack()], spec.seconds, spec.state).events;
  const bins = 10;
  const energy = new Array(bins).fill(0);
  for (const e of events) energy[Math.min(bins - 1, Math.floor((e.time / spec.seconds) * bins))] += e.gain * e.gain;
  const mean = energy.reduce((s, v) => s + v, 0) / bins;
  for (const v of energy) assert.ok(Math.abs(v / mean - 1) < 0.12, `bin energy ${v / mean}`);
});

test('fast streams are thinned: no audible stream runs above the ceiling', () => {
  const p = params({ flutterHz: 10 });
  const events = run(p, [hatTrack()], 30, createState()).events;
  assert.ok(events.every((e) => e.streamHz < 10 * Math.SQRT2 + 1e-9));
  // the fastest layers still play, but only their slower grids
  assert.ok(events.some((e) => e.beatHz > 4 && e.streamHz < 10));
});

test('solo plays one physical layer and hands over when it leaves the window', () => {
  const p = params({ tempoSlope: 6, solo: true });
  let state = createState();
  let solo = pickSoloLayer(null, state, p, 6);
  const seen = new Set<number>();
  for (let i = 0; i < 1200; i++) {
    solo = pickSoloLayer(solo, state, p, 6);
    const events = scheduleSegment(state, 0.05, 6, 0, p, [pulseTrack()], solo);
    for (const e of events) {
      assert.equal(e.layerId, solo);
      seen.add(e.layerId);
    }
    state = advanceState(state, 0.05, 6, 0, p);
  }
  assert.ok(seen.size >= 2, 'solo should move on to a new layer');
});

test('stepped pitch only takes values on the step grid', () => {
  const p = params({ pitchSlope: 3, pitchStep: 2 });
  const events = run(p, [pulseTrack()], 20, createState(), 3).events;
  for (const e of events) {
    const steps = (e.pitchOct * 12) / 2;
    assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6);
    assert.equal(e.pitchGlide, 0);
  }
  assert.ok(new Set(events.map((e) => e.pitchOct.toFixed(4))).size === 6);
});

test('steppedPitch holds q on the step below it, so the drone and the notes agree', () => {
  assert.equal(steppedPitch(0.3141, 0), 0.3141);
  // quarter tones: 1/24 octave
  assert.ok(Math.abs(steppedPitch(0.3141, 0.5) - 7 / 24) < 1e-12);
  assert.ok(Math.abs(steppedPitch(7 / 24, 0.5) - 7 / 24) < 1e-12);
  assert.ok(Math.abs(steppedPitch(0.9999, 0.5) - 23 / 24) < 1e-12);
  const p = params({ pitchSlope: 3, pitchStep: 0.5 });
  const events = run(p, [pulseTrack()], 20, createState(), 3).events;
  for (const e of events) assert.equal(e.pitchOct, steppedPitch(e.pitchOct, 0.5));
});

test('slopes glide to their target, a kick decays, and link ties pitch to tempo', () => {
  let motion = createSlopeMotion({ tempo: 0, pitch: 0 });
  for (let i = 0; i < 200; i++) motion = stepSlopes(motion, { tempo: 4, pitch: -2 }, 0.025);
  assert.ok(Math.abs(motion.tempo - 4) < 1e-3);
  assert.ok(Math.abs(motion.pitch + 2) < 1e-3);
  motion = { ...motion, kick: 30 };
  assert.equal(appliedSlopes(motion, false).tempo, motion.tempo + 30);
  assert.equal(appliedSlopes(motion, true).pitch, appliedSlopes(motion, true).tempo);
  for (let i = 0; i < 400; i++) motion = stepSlopes(motion, { tempo: 4, pitch: -2 }, 0.025);
  assert.ok(motion.kick < 1e-3);
});

test('an octave-stacked tone is unchanged by a whole octave of pitch', () => {
  const a = shepardPartials(41, 0.3);
  const b = shepardPartials(41, 1.3);
  assert.equal(a.length, b.length);
  a.forEach((partial, i) => {
    assert.ok(Math.abs(partial.hz / b[i].hz - 1) < 1e-9);
    assert.ok(Math.abs(partial.gain - b[i].gain) < 1e-9);
  });
  const lowest = a[0].hz;
  assert.ok(lowest >= 22 && lowest < 44);
});

test('wavetables have unit power and only octave-closed harmonics', () => {
  for (const timbre of ['glass', 'organ', 'reed'] as const) {
    const table = shepardWavetable(349.23, PAD_ENVELOPE, timbre);
    assert.ok(table.fundamentalHz >= 22 && table.fundamentalHz < 44);
    let power = 0;
    for (let n = 1; n < table.real.length; n++) {
      const amp2 = table.real[n] ** 2 + table.imag[n] ** 2;
      power += 0.5 * amp2;
      if (amp2 > 0) {
        let odd = n;
        while (odd % 2 === 0) odd /= 2;
        assert.ok([1, 3, 5, 7].includes(odd));
      }
    }
    assert.ok(Math.abs(power - 1) < 1e-5);
  }
});
