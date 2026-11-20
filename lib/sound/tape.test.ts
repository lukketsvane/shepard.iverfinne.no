import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { advanceState, createState, loopSpec, scheduleSegment } from '../staircase/core';
import { annotateTrack } from '../staircase/meter';
import { StairParams, StairState, Track } from '../staircase/types';
import { FOUR_FOUR } from '../presets/build';
import { PRESETS } from '../presets';
import { GraphFrame } from './graph';
import { LOOP_PEAK, TapeLoop, createTapeNode, frameMessage, loopFromAudioBuffer, renderPulseLoop } from './tape';

interface Range {
  loOct: number;
  hiOct: number;
  edgeOct: number;
}

interface TapeLayers {
  setFrame(frame: ReturnType<typeof frameMessage>): void;
  setLoop(loop: TapeLoop): void;
  setRange(range: Partial<Range>): void;
  render(left: Float32Array, right: Float32Array, startTime: number, sampleRate: number): void;
}

/** The real worklet code, run outside the audio thread. */
const Tape = vm.compileFunction(
  readFileSync(join(process.cwd(), 'public', 'worklets', 'tape-layers.js'), 'utf8') + '\nreturn TapeLayers;',
  ['AudioWorkletProcessor', 'registerProcessor']
)(class {}, () => {}) as new (options?: {
  frame?: ReturnType<typeof frameMessage>;
  loop?: TapeLoop;
  range?: Partial<Range>;
}) => TapeLayers;

const BLOCK = 128;

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
    levels: { drums: 1, melody: 1, pad: 0, sweep: 0, tape: 1, reverb: 0 },
    master: 1,
    solo: false,
    ...patch,
  };
}

function graphFrame(state: StairState, tempoSlope: number, p: StairParams): GraphFrame {
  return { when: state.time, state, tempoSlope, pitchSlope: 0, params: p, soloLayerId: null };
}

/** One impulse per loop of `loopBeats` beats, played at its recorded speed when a beat lasts 1/focusHz s. */
function impulseLoop(sampleRate: number, focusHz: number, loopBeats = 1): TapeLoop {
  const samples = new Float32Array(Math.round((loopBeats / focusHz) * sampleRate));
  samples[0] = 1;
  return { samples, loopBeats, naturalBeatHz: focusHz };
}

/** Renders `seconds` in blocks of 128. `before` runs ahead of each block, as messages from the main thread would. */
function render(
  tape: TapeLayers,
  seconds: number,
  sampleRate: number,
  startTime = 0,
  before: (blockEnd: number) => void = () => {}
): { left: Float32Array; right: Float32Array } {
  const frames = Math.round(seconds * sampleRate);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let at = 0; at < frames; at += BLOCK) {
    before(startTime + (at + BLOCK) / sampleRate);
    tape.render(l, r, startTime + at / sampleRate, sampleRate);
    const count = Math.min(BLOCK, frames - at);
    left.set(l.subarray(0, count), at);
    right.set(r.subarray(0, count), at);
  }
  return { left, right };
}

/** Frames of the engine's own time line: `slopeAt(t)` is held over each segment. */
function engineFrames(
  p: StairParams,
  start: StairState,
  slopeAt: (time: number) => number,
  seconds: number,
  segment: number
): { frames: GraphFrame[]; segments: Array<{ state: StairState; slope: number }>; end: StairState } {
  const frames: GraphFrame[] = [];
  const segments: Array<{ state: StairState; slope: number }> = [];
  let state = start;
  while (state.time < seconds - 1e-9) {
    const slope = slopeAt(state.time);
    frames.push(graphFrame(state, slope, p));
    segments.push({ state, slope });
    state = advanceState(state, segment, slope, 0, p);
  }
  return { frames, segments, end: state };
}

/** Feeds frames to the tape slightly ahead of time, in order, like the engine does. */
function feeder(tape: TapeLayers, frames: GraphFrame[], lead = 0.15): (blockEnd: number) => void {
  let next = 0;
  return (blockEnd) => {
    while (next < frames.length && frames[next].when < blockEnd + lead) {
      tape.setFrame(frameMessage(frames[next++]));
    }
  };
}

function maxAbs(x: Float32Array, from = 0, to = x.length): number {
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(x[i]));
  return peak;
}

function maxDiff(a: Float32Array, b: Float32Array, from = 0): number {
  let diff = 0;
  for (let i = from; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
  return diff;
}

/** Amplitude of the sine at `hz` in x[from, to), by a Hann-windowed single-bin DFT. */
function toneAmplitude(x: Float32Array, from: number, to: number, hz: number, sampleRate: number): number {
  const n = to - from;
  let re = 0;
  let im = 0;
  let weights = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const phase = (2 * Math.PI * hz * (from + i)) / sampleRate;
    re += x[from + i] * w * Math.cos(phase);
    im -= x[from + i] * w * Math.sin(phase);
    weights += w;
  }
  return (2 * Math.hypot(re, im)) / weights;
}

/** Amplitude spectrum of x[from, from + n) under a Hann window, n a power of two. Bin k is k * sampleRate / n Hz. */
function spectrum(x: Float32Array, from: number, n: number): Float64Array {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let weights = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = x[from + i] * w;
    weights += w;
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  const magnitudes = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) magnitudes[k] = (2 * Math.hypot(re[k], im[k])) / weights;
  return magnitudes;
}

const db = (ratio: number) => 20 * Math.log10(ratio);

/** One note per loop of one beat. */
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

const FRAME = { when: 0, u: 0.3, phi: 0, relabels: 0, tempoSlope: 0, focusHz: 2, ratio: 2 };

test('the tape is silent without a loop or without a frame', () => {
  const sr = 8000;
  const loop = impulseLoop(sr, 2);
  const cases: Array<ConstructorParameters<typeof Tape>[0]> = [{}, { loop }, { frame: FRAME }];
  for (const options of cases) {
    const { left, right } = render(new Tape(options), 0.5, sr);
    assert.equal(maxAbs(left), 0);
    assert.equal(maxAbs(right), 0);
  }
  const { left, right } = render(new Tape({ loop, frame: FRAME }), 0.5, sr);
  assert.ok(maxAbs(left) > 0.01 && maxAbs(right) > 0.01);
});

test('a frame with a number that is not finite is ignored', () => {
  const sr = 8000;
  const tape = new Tape({ loop: impulseLoop(sr, 2), frame: FRAME });
  tape.setFrame({ ...FRAME, when: 0.2, phi: NaN });
  tape.setFrame({ ...FRAME, when: 0.3, ratio: Infinity });
  tape.setFrame({ ...FRAME, when: 0.4, ratio: 1 });
  const { left, right } = render(tape, 1, sr);
  assert.ok(left.every(Number.isFinite) && right.every(Number.isFinite));
  assert.ok(maxAbs(left, 0.5 * sr) > 0.01, 'the first frame keeps playing');
});

test('a frame takes over at its time and not before', () => {
  const sr = 8000;
  const tape = new Tape({ loop: impulseLoop(sr, 2) });
  tape.setFrame({ ...FRAME, when: 0.5, tempoSlope: 0 });
  const { left } = render(tape, 1, sr);
  assert.equal(maxAbs(left, 0, 0.5 * sr - 1), 0);
  assert.ok(maxAbs(left, 0.5 * sr, sr) > 0.01);
});

test('the output stays finite and bounded for every ratio and slope, including 0 and negative phase', () => {
  const sr = 16000;
  const loop = renderPulseLoop(PRESETS[0].tracks, FOUR_FOUR, 2, sr);
  for (const ratio of [2, 1.5, 3] as const) {
    for (const tempoSlope of [0, 1e-12, 2, -5, 40]) {
      for (const phi of [0, 123.456, -77.7, 1e6]) {
        const tape = new Tape({ loop, frame: { ...FRAME, ratio, tempoSlope, phi } });
        const { left, right } = render(tape, 1.5, sr);
        for (const channel of [left, right]) {
          assert.ok(channel.every(Number.isFinite), `ratio ${ratio} slope ${tempoSlope} phi ${phi}`);
          assert.ok(maxAbs(channel) < 0.9);
        }
        assert.ok(maxAbs(left) > 1e-4);
      }
    }
  }
});

test('slow heads hit exactly where the scheduler puts the onsets, through changing slopes and relabelling', () => {
  const sr = 8000;
  const focusHz = 2;
  // Only the heads within +-half an octave of the focus are heard, so at most one or two sound
  // at a time; each plays one impulse per beat of its own tempo.
  const cases = [
    { ratio: 2 as const, half: 0.45 },
    { ratio: 1.5 as const, half: 0.28 },
    { ratio: 3 as const, half: 0.45 },
  ];
  for (const { ratio, half } of cases) {
    const p = params({ ratio, spread: 2 });
    // octaves per minute, scaled so that every ratio's staircase moves at the same pace in u
    const slopes = [20, -12, 40, -24].map((slope) => slope * Math.log2(ratio));
    const { frames, segments, end } = engineFrames(
      p,
      { ...createState(), phi: 0.37 },
      (t) => slopes[Math.floor(t / 2) % slopes.length],
      20,
      0.05
    );
    const events = segments.flatMap(({ state, slope }) =>
      scheduleSegment(state, 0.05, slope, 0, p, [pulseTrack()])
    );
    const relabels = new Set(segments.map((segment) => segment.state.relabels));
    assert.ok(relabels.size >= 3 && end.relabels !== 0, `the run must cross several relabellings: ${[...relabels]}`);

    const tape = new Tape({ loop: impulseLoop(sr, focusHz), range: { loOct: -half, hiOct: half, edgeOct: 0.1 } });
    const { left, right } = render(tape, 20, sr, 0, feeder(tape, frames));
    const mono = left.map((v, i) => v + right[i]);
    const tolerance = Math.round(0.001 * sr);

    let checked = 0;
    for (const event of events) {
      if (Math.abs(event.xOct) > half - 0.12 || event.time < 0.1 || event.time > 19.9) continue;
      const at = Math.round(event.time * sr);
      let best = at - 3 * tolerance;
      for (let i = best; i <= at + 3 * tolerance; i++) if (mono[i] > mono[best]) best = i;
      assert.ok(Math.abs(best - at) <= tolerance, `ratio ${ratio}: onset ${event.time} heard at ${best / sr}`);
      assert.ok(mono[best] > 0.25, `ratio ${ratio}: onset ${event.time} too quiet: ${mono[best]}`);
      checked++;
    }
    assert.ok(checked > 10, `ratio ${ratio}: only ${checked} onsets compared`);

    // and nothing else is loud: every strong peak belongs to an onset
    for (let i = 16; i < mono.length - 16; i++) {
      if (mono[i] < 0.25) continue;
      let isPeak = true;
      for (let k = -16; k <= 16; k++) if (mono[i + k] > mono[i]) isPeak = false;
      if (!isPeak) continue;
      assert.ok(
        events.some((event) => Math.abs(event.time * sr - i) <= tolerance),
        `ratio ${ratio}: unexplained peak at ${i / sr}`
      );
    }
  }
});

test('a constant slope repeats exactly after one ratio step, in both channels', () => {
  const sr = 8000;
  for (const [ratio, tempoSlope] of [[2, 12], [2, -12], [1.5, 18], [3, -9]] as const) {
    const p = params({ ratio, tempoSlope, focusBpm: 120 });
    const spec = loopSpec(p)!;
    const loop = renderPulseLoop(PRESETS[0].tracks, FOUR_FOUR, 2, sr);
    const frame = { ...frameMessage(graphFrame(spec.state, tempoSlope, p)), when: 0 };
    const first = render(new Tape({ loop, frame }), spec.seconds, sr, 0);
    const second = render(new Tape({ loop, frame }), spec.seconds, sr, spec.seconds);
    assert.ok(maxAbs(first.left) > 0.01);
    assert.ok(maxDiff(first.left, second.left) < 1e-5, `ratio ${ratio} slope ${tempoSlope} left`);
    assert.ok(maxDiff(first.right, second.right) < 1e-5, `ratio ${ratio} slope ${tempoSlope} right`);
  }
});

test('heads that reach audio rate are tones one layer ratio apart, and the range limits them', () => {
  // One period of a sine per loop: a head at beat rate f plays a sine at f Hz.
  const sr = 16000;
  const focusHz = 10;
  const length = sr / focusHz;
  const samples = Float32Array.from({ length }, (_, i) => Math.sin((2 * Math.PI * i) / length));
  const loop: TapeLoop = { samples, loopBeats: 1, naturalBeatHz: focusHz };
  const u = 0.3;
  const n = 16384;
  const peaks = (range?: Partial<Range>) => {
    const tape = new Tape({ loop, frame: { ...FRAME, u, focusHz }, range });
    const { left, right } = render(tape, 2, sr);
    const bins = spectrum(left.map((v, i) => v + right[i]), sr / 2, n);
    const binHz = sr / n;
    const strongest = Math.max(...bins.subarray(Math.ceil(30 / binHz)));
    const found: number[] = [];
    for (let k = Math.ceil(30 / binHz); k < bins.length - 1; k++) {
      if (bins[k] > bins[k - 1] && bins[k] >= bins[k + 1] && bins[k] > strongest * 0.01) found.push(k * binHz);
    }
    return { found, bins, binHz };
  };

  // head j = -k sits k + u octaves above the focus and plays focusHz * 2^(u + k) Hz
  const all = peaks();
  const expected = [2, 3, 4, 5, 6, 7, 8].map((k) => focusHz * 2 ** (u + k));
  assert.equal(all.found.length, expected.length, `peaks at ${all.found}`);
  expected.forEach((hz, i) => assert.ok(Math.abs(all.found[i] - hz) < 2, `peak ${i}: ${all.found[i]} Hz, expected ${hz}`));
  for (const hz of expected.slice(0, 6)) {
    const peak = all.bins[Math.round(hz / all.binHz)];
    // away from every tone and from the 3rd harmonic of the one below
    const between = Math.max(...all.bins.subarray(Math.round((hz * Math.SQRT2) / all.binHz) - 2, Math.round((hz * Math.SQRT2) / all.binHz) + 3));
    assert.ok(db(peak / between) > 35, `${hz} Hz: only ${db(peak / between)} dB above the gap`);
  }

  // narrowing the range removes the heads outside it
  const narrow = peaks({ loOct: 5, hiOct: 7.5, edgeOct: 0.4 }).found;
  const inside = [5, 6, 7].map((k) => focusHz * 2 ** (u + k));
  assert.equal(narrow.length, inside.length, `peaks at ${narrow}`);
  inside.forEach((hz, i) => assert.ok(Math.abs(narrow[i] - hz) < 2));
});

test('reading at high speed from the mips aliases far less than reading the loop itself', () => {
  const sr = 8000;
  const length = 1000;
  const focusHz = sr / length;
  // One tone that survives the speed-up (0.05 cycles/sample) and one that cannot (0.4).
  const samples = Float32Array.from(
    { length },
    (_, i) => Math.sin(2 * Math.PI * 0.05 * i) + Math.sin(2 * Math.PI * 0.4 * i)
  );
  const speedOct = Math.log2(1.9);
  const range = { loOct: speedOct - 0.2, hiOct: speedOct + 0.2, edgeOct: 0.05 };
  const tape = new Tape({
    loop: { samples, loopBeats: 1, naturalBeatHz: focusHz },
    frame: { ...FRAME, u: speedOct, focusHz },
    range,
  });
  const seconds = 2;
  const { left: mips, right } = render(tape, seconds, sr);
  // the same head read naively: linear interpolation of the loop, same positions
  const naive = new Float32Array(seconds * sr);
  for (let i = 0; i < naive.length; i++) {
    const position = (((2 ** speedOct * focusHz * i) / sr) % 1) * length;
    const k = Math.floor(position);
    naive[i] = samples[k] + (position - k) * (samples[(k + 1) % length] - samples[k]);
  }
  const tone = 0.05 * 1.9 * sr;
  // 0.4 * 1.9 = 0.76 cycles per sample, which folds about the Nyquist rate to 0.24
  const folded = (1 - 0.4 * 1.9) * sr;
  const from = sr / 2;
  const to = seconds * sr;
  const aliasOver = (x: Float32Array) =>
    toneAmplitude(x, from, to, folded, sr) / toneAmplitude(x, from, to, tone, sr);
  const naiveRatio = aliasOver(naive);
  const mipRatio = aliasOver(mips);
  assert.ok(naiveRatio > 0.3, `the naive read should alias: ${naiveRatio}`);
  assert.ok(db(naiveRatio / mipRatio) > 15, `only ${db(naiveRatio / mipRatio)} dB better`);
  // while the tone that can be represented keeps its level
  // (the head is scaled by 1 / sqrt(0.4 octaves) and divided between the channels)
  const kept =
    Math.hypot(toneAmplitude(mips, from, to, tone, sr), toneAmplitude(right, from, to, tone, sr)) /
    (toneAmplitude(naive, from, to, tone, sr) / Math.sqrt(0.4));
  assert.ok(Math.abs(db(kept)) < 1, `the tone changed by ${db(kept)} dB`);
});

test('a pulse train keeps its area at every speed: the tone does not fade as the heads speed up', () => {
  const sr = 8000;
  const length = 400;
  const focusHz = sr / length;
  const loop: TapeLoop = { samples: new Float32Array(length), loopBeats: 1, naturalBeatHz: focusHz };
  loop.samples[0] = 1;
  const amplitude = (x: number) => {
    const tape = new Tape({
      loop,
      frame: { ...FRAME, u: x, focusHz },
      range: { loOct: x - 0.2, hiOct: x + 0.2, edgeOct: 0.05 },
    });
    const { left, right } = render(tape, 1.5, sr);
    const hz = focusHz * 2 ** x;
    const from = sr / 2;
    return Math.hypot(toneAmplitude(left, from, 1.5 * sr, hz, sr), toneAmplitude(right, from, 1.5 * sr, hz, sr));
  };
  // The fundamental of a train of unit-area pulses is 2 / length, whatever the speed; one head
  // in a range 0.4 octaves wide is scaled by 1 / sqrt(0.4).
  const expected = 2 / length / Math.sqrt(0.4);
  for (const x of [3.3, 4.3, 5.3, 6.3]) {
    const found = amplitude(x);
    assert.ok(Math.abs(found / expected - 1) < 0.05, `x=${x}: ${found} vs ${expected}`);
  }
});

test('handing over to a new frame changes nothing when the state is the same', () => {
  const sr = 8000;
  const p = params({ tempoSlope: 30 });
  const loop = renderPulseLoop(PRESETS[0].tracks, FOUR_FOUR, 2, sr);
  const seconds = 6;
  const slopeAt = (t: number) => 30 * (t < 2.9999 ? 1 : -0.5);
  const run = (segment: number, stop = Infinity) => {
    const tape = new Tape({ loop });
    const frames = engineFrames(p, createState(), slopeAt, seconds, segment).frames.filter((f) => f.when < stop);
    return { tape, frames, out: render(tape, seconds, sr, 0, feeder(tape, frames)) };
  };
  const coarse = run(0.05);
  const fine = run(0.01);
  assert.ok(maxAbs(coarse.out.left) > 0.01);
  assert.ok(maxDiff(coarse.out.left, fine.out.left) < 2e-5, 'frames every 50 ms or every 10 ms');
  assert.ok(maxDiff(coarse.out.right, fine.out.right) < 2e-5);

  // one frame for the whole 6 s, relabelling in between: same sound
  const single = new Tape({ loop });
  single.setFrame(frameMessage(graphFrame(createState(), 30, p)));
  const constant = render(single, 3, sr);
  const frames = engineFrames(p, createState(), () => 30, 3, 0.05).frames;
  const chopped = new Tape({ loop });
  const reference = render(chopped, 3, sr, 0, feeder(chopped, frames));
  assert.ok(maxDiff(constant.left, reference.left) < 2e-5);
  assert.ok(maxDiff(constant.right, reference.right) < 2e-5);
});

test('no click when a new frame changes the slope', () => {
  // Slow heads playing a smooth loop (one sine period): a jump in position, window or stereo
  // lean at a hand-over would show as a large second difference at that sample. The slope
  // wanders by a few octaves per minute per frame, as the engine's smoothed slopes do.
  const sr = 8000;
  const focusHz = 2;
  const length = sr / focusHz;
  const samples = Float32Array.from({ length }, (_, i) => Math.sin((2 * Math.PI * i) / length));
  const p = params();
  const segment = 0.05;
  const { frames } = engineFrames(p, createState(), (t) => 20 * Math.sin(2 * Math.PI * 0.5 * t), 6, segment);
  const tape = new Tape({ loop: { samples, loopBeats: 1, naturalBeatHz: focusHz }, range: { loOct: -3, hiOct: 3, edgeOct: 1 } });
  const { left } = render(tape, 6, sr, 0, feeder(tape, frames));
  const curvature = (i: number) => Math.abs(left[i + 1] - 2 * left[i] + left[i - 1]);
  const boundary = new Set(frames.map((frame) => Math.round(frame.when * sr)));
  let atHandOver = 0;
  let elsewhere = 0;
  for (let i = 1; i < left.length - 1; i++) {
    const nearBoundary = boundary.has(i) || boundary.has(i + 1) || boundary.has(i - 1);
    if (nearBoundary && i > 0.5 * sr) atHandOver = Math.max(atHandOver, curvature(i));
    else if (!nearBoundary && i > 0.5 * sr) elsewhere = Math.max(elsewhere, curvature(i));
  }
  assert.ok(elsewhere > 1e-6, 'the signal moves');
  assert.ok(atHandOver < 3 * elsewhere, `${atHandOver} at hand-over vs ${elsewhere} elsewhere`);
});

test('the tape keeps extrapolating when the frames stop coming', () => {
  const sr = 8000;
  const p = params({ tempoSlope: 12 });
  const loop = renderPulseLoop(PRESETS[0].tracks, FOUR_FOUR, 2, sr);
  const frames = engineFrames(p, createState(), () => 12, 1, 0.05).frames;
  const stalled = new Tape({ loop });
  const a = render(stalled, 4, sr, 0, feeder(stalled, frames));
  const whole = new Tape({ loop });
  whole.setFrame(frameMessage(frames[0]));
  const b = render(whole, 4, sr);
  assert.ok(maxAbs(a.left, 3 * sr) > 0.01);
  assert.ok(maxDiff(a.left, b.left) < 2e-5);
});

test('swapping the loop while playing dips through silence instead of clicking', () => {
  const sr = 8000;
  const length = sr / 2;
  const sine = Float32Array.from({ length }, (_, i) => Math.sin((2 * Math.PI * i) / length));
  const loop = (samples: Float32Array): TapeLoop => ({ samples, loopBeats: 1, naturalBeatHz: 2 });
  const tape = new Tape({
    loop: loop(sine),
    frame: { ...FRAME, tempoSlope: 0 },
    range: { loOct: -3, hiOct: 3, edgeOct: 1 },
  });
  const before = render(tape, 1, sr).left;
  // the same music upside down: swapping it in at once would jump by twice the level
  tape.setLoop(loop(sine.map((v) => -v)));
  const after = render(tape, 1, sr, 1).left;
  const steps = (x: Float32Array) => {
    let step = 0;
    for (let i = 1; i < x.length; i++) step = Math.max(step, Math.abs(x[i] - x[i - 1]));
    return step;
  };
  assert.ok(maxAbs(before) > 0.05);
  assert.ok(steps(after) < 0.1 * maxAbs(before), `a step of ${steps(after)} in a signal of ${maxAbs(before)}`);

  // and it ends up on the new loop: the same as a tape that never played the old one
  const fresh = new Tape({
    loop: loop(sine.map((v) => -v)),
    frame: { ...FRAME, tempoSlope: 0 },
    range: { loOct: -3, hiOct: 3, edgeOct: 1 },
  });
  const reference = render(fresh, 2, sr).left;
  assert.ok(maxDiff(after.subarray(0.5 * sr), reference.subarray(1.5 * sr)) < 1e-4);

  tape.setLoop({ samples: new Float32Array(0), loopBeats: 1, naturalBeatHz: 2 });
  assert.equal(maxAbs(render(tape, 0.2, sr, 2).left), 0, 'an unusable loop silences the tape');
});

test('a long loop is built over several blocks while the old one keeps playing', () => {
  const sr = 8000;
  const tape = new Tape({ loop: impulseLoop(sr, 2), frame: { ...FRAME, tempoSlope: 2 } });
  render(tape, 0.5, sr);
  // 400000 samples: more than 40 blocks of mip building at 8192 samples per block
  tape.setLoop({ samples: new Float32Array(400000), loopBeats: 100, naturalBeatHz: 2 });
  const during = render(tape, 0.25, sr, 0.5);
  assert.ok(maxAbs(during.left) > 0.02, 'the old loop plays on while the new one is built');
  const after = render(tape, 1.5, sr, 0.75);
  assert.ok(after.left.every(Number.isFinite));
  assert.ok(maxAbs(after.left, sr) < 1e-6, 'the new (empty) loop has taken over');
});

/** A track of `lengthBeats` beats with a full-velocity note at each of `beats`. */
function track(role: Track['role'], lengthBeats: number, beats: number[], gain = 1): Track {
  return {
    id: role,
    role,
    lengthBeats,
    notes: beats.map((beat) => ({ beat, dur: 0.1, midi: 0, vel: 1, rate: 1 })),
    gain,
    center: 0,
    maxHz: 10,
  };
}

test('renderPulseLoop: whole bars, capped at four, shorter tracks repeat, melody is left out', () => {
  const sr = 48000;
  const beat = sr / 2;
  const preset = renderPulseLoop(PRESETS[0].tracks, FOUR_FOUR, 2, sr);
  assert.equal(preset.loopBeats, 4);
  assert.equal(preset.samples.length, 96000);
  assert.equal(preset.naturalBeatHz, 2);
  assert.ok(Math.abs(maxAbs(preset.samples) - LOOP_PEAK) < 1e-6, 'the loudest sample of every loop is the same');

  assert.equal(renderPulseLoop([track('kick', 5, [0])], FOUR_FOUR, 2, sr).loopBeats, 8);
  assert.equal(renderPulseLoop([track('kick', 20, [0, 17])], FOUR_FOUR, 2, sr).loopBeats, 16);

  // a one-bar kick repeats under a two-bar hat
  const loop = renderPulseLoop(
    [track('kick', 4, [0, 2]), track('hat', 8, [1]), track('keys', 16, [0])],
    FOUR_FOUR,
    2,
    sr
  );
  assert.equal(loop.loopBeats, 8);
  // value half a millisecond into each beat: the top of the click
  const click = (b: number) => loop.samples[Math.round(b * beat) + 24];
  assert.ok(Math.abs(click(0) - click(4)) < 1e-6 && click(0) > 0.1);
  assert.ok(Math.abs(click(2) - click(6)) < 1e-6 && click(2) > 0.1);
  assert.ok(click(1) > 0.02 && click(1) < click(0), 'the hat is on beat 1 of the first bar only');
  assert.ok(Math.abs(click(5)) < 1e-3);
  assert.ok(Math.abs(click(3)) < 1e-3 && Math.abs(click(7)) < 1e-3);

  // no drum notes: one pulse per beat, the downbeat strongest
  const bare = renderPulseLoop([track('keys', 4, [0])], FOUR_FOUR, 2, sr);
  assert.equal(bare.loopBeats, 4);
  const barePulse = (b: number) => bare.samples[Math.round(b * beat) + 24];
  assert.ok(barePulse(1) > 0.02 && barePulse(2) > 0.02 && barePulse(3) > 0.02);
  assert.ok(barePulse(0) > barePulse(1));
});

test('renderPulseLoop: pulses start on their beat, the kick is the heaviest, and the end wraps around', () => {
  const sr = 48000;
  const beat = sr / 2;
  const loop = renderPulseLoop(
    [track('kick', 4, [0]), track('snare', 4, [1]), track('perc', 4, [2]), track('hat', 4, [3])],
    FOUR_FOUR,
    2,
    sr
  );
  const energy = (b: number) => {
    let sum = 0;
    for (let i = Math.round(b * beat); i < Math.round(b * beat) + 0.4 * sr; i++) sum += loop.samples[i] ** 2;
    return sum;
  };
  assert.ok(energy(0) > energy(1) && energy(1) > energy(2) && energy(2) > energy(3) && energy(3) > 0);
  // quiet before an onset (the last pulse has died away), the click begins on the onset
  assert.equal(maxAbs(loop.samples, Math.round(beat) - 200, Math.round(beat)), 0);
  assert.ok(loop.samples[Math.round(beat) + 12] > 0);
  // a unipolar click has area: the loop does not average out to zero
  assert.ok(loop.samples.reduce((sum, v) => sum + v, 0) > 0);

  const late = renderPulseLoop([track('kick', 4, [3.99])], FOUR_FOUR, 2, sr);
  assert.ok(maxAbs(late.samples, 0, 2000) > 0.01, 'the thump rings on past the end of the loop, into its start');
});

test('loopFromAudioBuffer mixes down to mono and counts beats in the recording', () => {
  const channels = [Float32Array.from([1, 0, -1, 0]), Float32Array.from([0, 1, 0, -1])];
  const buffer = {
    length: 4,
    numberOfChannels: 2,
    sampleRate: 4,
    duration: 1,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer;
  const loop = loopFromAudioBuffer(buffer, 2);
  assert.equal(loop.loopBeats, 2);
  assert.equal(loop.naturalBeatHz, 2);
  const peak = Math.max(...loop.samples.map(Math.abs));
  assert.ok(Math.abs(peak - LOOP_PEAK) < 1e-6);
  assert.ok(Math.abs(loop.samples[0] / loop.samples[1] - 1) < 1e-6 && loop.samples[0] > 0);
  assert.ok(Math.abs(loop.samples[2] + loop.samples[0]) < 1e-6);
});

test('frameMessage carries what the worklet needs', () => {
  const p = params({ focusBpm: 90, ratio: 1.5 });
  const state: StairState = { time: 3, u: 0.4, phi: 12.5, relabels: -2, q: 0.1 };
  assert.deepEqual(frameMessage({ ...graphFrame(state, -3, p), when: 7.25 }), {
    when: 7.25,
    u: 0.4,
    phi: 12.5,
    relabels: -2,
    tempoSlope: -3,
    focusHz: 1.5,
    ratio: 1.5,
  });
});

test('createTapeNode loads the module once per context, passes the options, and rejects when it cannot load', async () => {
  const created: Array<{ name: string; options: Record<string, unknown>; posted: unknown[] }> = [];
  class FakeNode {
    posted: unknown[] = [];
    port = { postMessage: (message: unknown) => this.posted.push(message) };
    constructor(_ctx: unknown, name: string, options: Record<string, unknown>) {
      created.push({ name, options, posted: this.posted });
    }
  }
  class FakeOffline {}
  const globals = globalThis as unknown as { AudioWorkletNode?: unknown; OfflineAudioContext?: unknown };
  globals.AudioWorkletNode = FakeNode;
  globals.OfflineAudioContext = FakeOffline;
  try {
    const urls: string[] = [];
    let fail = true;
    const audioWorklet = {
      addModule: async (url: string) => {
        urls.push(url);
        if (fail) throw new Error('404');
      },
    };
    const ctx = { audioWorklet } as unknown as BaseAudioContext;
    const loop = impulseLoop(8000, 2);
    const p = params();
    await assert.rejects(createTapeNode(ctx, { loop }), /404/);
    fail = false;
    await createTapeNode(ctx, { loop, frame: graphFrame(createState(), 2, p) });
    await createTapeNode(ctx, {});
    assert.deepEqual(urls, ['/worklets/tape-layers.js', '/worklets/tape-layers.js']);
    assert.equal(created.length, 2);
    assert.equal(created[0].name, 'tape-layers');
    assert.deepEqual(created[0].options.outputChannelCount, [2]);
    assert.equal(created[0].options.numberOfInputs, 0);
    const processorOptions = created[0].options.processorOptions as { frame: unknown; loop?: TapeLoop };
    assert.deepEqual(processorOptions.frame, frameMessage(graphFrame(createState(), 2, p)));
    // a live context builds the loop in the worklet a slice per block, after the node exists
    assert.equal(processorOptions.loop, undefined);
    assert.deepEqual(created[0].posted, [{ type: 'loop', ...loop }]);
    assert.deepEqual(created[1].posted, []);

    // an offline context has not started: the loop comes with the node
    const offline = Object.assign(new FakeOffline(), { audioWorklet }) as unknown as BaseAudioContext;
    await createTapeNode(offline, { loop });
    assert.equal((created[2].options.processorOptions as { loop: TapeLoop }).loop, loop);
    assert.deepEqual(created[2].posted, []);
  } finally {
    delete globals.AudioWorkletNode;
    delete globals.OfflineAudioContext;
  }
});

test('a loop that arrives by message is built a slice per block, and the tape sounds once it is ready', () => {
  const sr = 8000;
  // 400000 samples: the mips take more than 40 blocks at 8192 samples per block
  const samples = new Float32Array(400000);
  for (let i = 0; i < samples.length; i += 1000) samples[i] = 1;
  const tape = new Tape({ frame: { ...FRAME, tempoSlope: 0, u: 0.5, focusHz: 2 } });
  tape.setLoop({ samples, loopBeats: 100, naturalBeatHz: 2 });
  const first = render(tape, 0.2, sr);
  assert.equal(maxAbs(first.left), 0, 'nothing sounds in the first blocks: they were not spent building the chain');
  const later = render(tape, 2, sr, 0.2);
  assert.ok(maxAbs(later.left) > 0.001, 'the loop is playing once built');
  assert.ok(later.left.every(Number.isFinite));
});

test('a loop given at construction plays from the first block', () => {
  const sr = 8000;
  const tape = new Tape({ loop: impulseLoop(sr, 2), frame: { ...FRAME, tempoSlope: 0, u: 0.5 } });
  assert.ok(maxAbs(render(tape, 1, sr).left) > 0.01);
});

test('a frame that is far out of date silences the tape instead of extrapolating to infinity, and fresh frames bring it back', () => {
  const sr = 8000;
  const loop = impulseLoop(sr, 2);
  const frame = { ...FRAME, tempoSlope: 2.03, u: 0.5 };
  const tape = new Tape({ loop, frame });
  assert.ok(maxAbs(render(tape, 1, sr).left) > 0.01);
  // 8.5 hours later, as when the transport was stopped and the context left running
  const later = 8.5 * 3600;
  const stale = render(tape, 0.5, sr, later);
  assert.equal(maxAbs(stale.left), 0);
  assert.equal(maxAbs(stale.right), 0);
  tape.setFrame({ ...frame, when: later + 0.5, phi: 3 });
  const fresh = render(tape, 2, sr, later + 0.5);
  assert.ok(fresh.left.every(Number.isFinite) && fresh.right.every(Number.isFinite));
  assert.ok(maxAbs(fresh.left) > 0.01, 'the tape recovers');
});
