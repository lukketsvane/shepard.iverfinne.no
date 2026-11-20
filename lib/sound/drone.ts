/**
 * The continuous voices: the drone that carries the pitch staircase, and the barber-pole sweep.
 *
 * Both are a ring of components one octave apart under a fixed bell. As the staircase turns,
 * every component slides along its own exponential ramp; the one that reaches the edge of the
 * bell (where its gain is exactly zero) is recycled to the other edge. Nothing ever starts,
 * stops or jumps while audible.
 */

import { steppedPitch } from '../staircase/core';
import { positiveMod } from '../staircase/meter';
import { PAD_ENVELOPE, envelopeGain, foldToFloor, midiToHz } from '../staircase/pitch';
import { Preset } from '../staircase/types';
import { createRandom, pinkNoiseLoop } from './dsp';
import type { GraphFrame } from './graph';

/** Frames come every 50 ms; a longer silence in the frame times (a stalled tab, a pause) is a jump. */
const MAX_FRAME_GAP_SECONDS = 0.25;
/** A move of more than this many octaves between two frames is a restart, not a glide. */
const MAX_STEP_OCT = 0.25;

/**
 * Positions (octaves, in [0, size)) of `size` slots one octave apart when the ring has turned by
 * `turn` octaves. Slot s sits at turn + s, wrapped: the slot leaving the top re-enters at the bottom.
 */
export function ringPositions(turn: number, size: number): number[] {
  return Array.from({ length: size }, (_, slot) => positiveMod(turn + slot, size));
}

/** Smooth 0..1 rise over the first octave at either edge of the ring, so a recycled slot is silent. */
export function edgeTaper(position: number, size: number): number {
  const x = Math.max(0, Math.min(1, Math.min(position, size - position)));
  return x * x * (3 - 2 * x);
}

/**
 * Where a ring has been, so each frame can say per slot whether the move since the last one is a
 * glide (ramp to the new value) or a jump (set it: the slot crossed the seam, or time broke).
 */
class RingMotion {
  private last: { when: number; turn: number; positions: number[] } | null = null;

  constructor(private size: number) {}

  move(turn: number, when: number): { positions: number[]; smooth: boolean[] } {
    const positions = ringPositions(turn, this.size);
    const last = this.last;
    const continuous =
      last !== null && when - last.when <= MAX_FRAME_GAP_SECONDS && Math.abs(turn - last.turn) <= MAX_STEP_OCT;
    const smooth = positions.map((p, slot) => continuous && Math.abs(p - last!.positions[slot]) < this.size / 2);
    this.last = { when, turn, positions };
    return { positions, smooth };
  }
}

/**
 * Slow automation needs no sample accuracy, and computing it per sample (a power or a sine for
 * every sample of every component) is what makes a drone expensive: once per block is plenty.
 */
function perBlock(param: AudioParam): AudioParam {
  param.automationRate = 'k-rate';
  return param;
}

/** Ramp to `value` at `when`, or jump there when the move was not a glide. */
function drive(param: AudioParam, value: number, when: number, smooth: boolean, shape: 'linear' | 'exponential'): void {
  if (!smooth) param.setValueAtTime(value, when);
  else if (shape === 'exponential') param.exponentialRampToValueAtTime(value, when);
  else param.linearRampToValueAtTime(value, when);
}

// ---------------------------------------------------------------------------------------------
// pad

/** Nine octaves from a pitch class in [22, 44) Hz reach past 11 kHz, where the bell is long gone. */
const PAD_SLOTS = 9;
/** A soft triangle-ish wave: the sine plus a little third and fifth harmonic. */
const PAD_WAVE_IMAG = [0, 1, 0, 0.12, 0, 0.04];
/** Nine unit sines to a note, two or three notes and an anchor make a loud tone: this keeps a pad level of 1 a bed under the drums. */
const PAD_STACK_LEVEL = 0.1;
const PAD_ANCHOR_LEVEL = 0.6;
const PAD_DETUNE_CENTS = 5;
const PAD_STACK_PANS = [-0.4, 0.4, 0, -0.2, 0.2];
const PAD_FADE_SECONDS = 0.4;

/** Gain of a pad component at `hz` sitting at `position` of its ring. */
export function padGain(hz: number, position: number): number {
  return envelopeGain(hz, PAD_ENVELOPE) * edgeTaper(position, PAD_SLOTS);
}

/** Frequency of slot position `position` for a stack whose pitch class is `baseHz`. */
export function padFrequency(baseHz: number, position: number): number {
  return baseHz * Math.pow(2, position);
}

/** The octaves of one chord note: a sine per slot, with a slow detune so that the drone breathes. */
class PadStack {
  private oscillators: OscillatorNode[] = [];
  private gains: GainNode[] = [];
  readonly nodes: AudioNode[] = [];

  constructor(
    ctx: BaseAudioContext,
    wave: PeriodicWave,
    out: AudioNode,
    private baseHz: number,
    pan: number,
    lfoHz: number,
    level: number
  ) {
    const sum = ctx.createGain();
    sum.gain.value = level * PAD_STACK_LEVEL;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    sum.connect(panner);
    panner.connect(out);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = lfoHz;
    const depth = ctx.createGain();
    depth.gain.value = PAD_DETUNE_CENTS;
    lfo.connect(depth);
    lfo.start();

    for (let slot = 0; slot < PAD_SLOTS; slot++) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = padFrequency(baseHz, slot);
      depth.connect(perBlock(osc.detune));
      perBlock(osc.frequency);
      const gain = ctx.createGain();
      perBlock(gain.gain).value = 0;
      osc.connect(gain);
      gain.connect(sum);
      osc.start();
      this.oscillators.push(osc);
      this.gains.push(gain);
    }
    this.nodes.push(sum, panner, lfo, depth, ...this.oscillators, ...this.gains);
  }

  /** Hold every component at `positions`. */
  hold(positions: number[]): void {
    positions.forEach((position, slot) => {
      this.oscillators[slot].frequency.value = padFrequency(this.baseHz, position);
      this.gains[slot].gain.value = padGain(padFrequency(this.baseHz, position), position);
    });
  }

  move(positions: number[], smooth: boolean[], when: number): void {
    positions.forEach((position, slot) => {
      const hz = padFrequency(this.baseHz, position);
      drive(this.oscillators[slot].frequency, hz, when, smooth[slot], 'exponential');
      drive(this.gains[slot].gain, padGain(hz, position), when, smooth[slot], 'linear');
    });
  }
}

export class Pad {
  /** The chord notes, which follow the pitch phase; the anchor is not among them. */
  private moving: PadStack[] = [];
  private motion = new RingMotion(PAD_SLOTS);
  /** Fade of the whole drone, for starting and for being replaced. */
  private fade: GainNode;
  private nodes: AudioNode[] = [];
  /** Pitch phase in octaves without wrapping, so a slot keeps its identity across q wrapping to 0. */
  private turn: { q: number; value: number } | null = null;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    preset: Pick<Preset, 'tonic' | 'padChord' | 'padAnchor'>
  ) {
    this.fade = ctx.createGain();
    this.fade.gain.value = 0;
    this.fade.gain.setTargetAtTime(1, ctx.currentTime, PAD_FADE_SECONDS / 5);
    this.fade.connect(destination);

    // breathing: the whole drone swells and ebbs by about a tenth, over some twelve seconds
    const breath = ctx.createGain();
    breath.gain.value = 0.9;
    const swell = ctx.createOscillator();
    swell.frequency.value = 0.083;
    const swellDepth = ctx.createGain();
    swellDepth.gain.value = 0.1;
    swell.connect(swellDepth);
    swellDepth.connect(breath.gain);
    swell.start();
    breath.connect(this.fade);
    this.nodes.push(this.fade, breath, swell, swellDepth);

    const wave = ctx.createPeriodicWave(new Float32Array(PAD_WAVE_IMAG.length), new Float32Array(PAD_WAVE_IMAG));
    const rand = createRandom(preset.tonic);
    const rest = ringPositions(0, PAD_SLOTS);
    preset.padChord.forEach((offset, i) => {
      const base = foldToFloor(midiToHz(preset.tonic + offset));
      const pan = PAD_STACK_PANS[i % PAD_STACK_PANS.length];
      const stack = new PadStack(ctx, wave, breath, base, pan, 0.04 + 0.07 * rand(), 1);
      stack.hold(rest);
      this.moving.push(stack);
    });
    const stacks = [...this.moving];
    if (preset.padAnchor) {
      // the held note the riser moves against: the root at q = 0, for ever
      const base = foldToFloor(midiToHz(preset.tonic));
      const anchor = new PadStack(ctx, wave, breath, base, 0, 0.05 + 0.03 * rand(), PAD_ANCHOR_LEVEL);
      anchor.hold(rest);
      stacks.push(anchor);
    }
    for (const stack of stacks) this.nodes.push(...stack.nodes);
  }

  /** Move every moving stack to the frame's pitch phase, which steps like the notes do when the pitch moves in steps. */
  update(frame: GraphFrame): void {
    const q = steppedPitch(frame.state.q, frame.params.pitchStep);
    let value = q;
    if (this.turn) {
      // the shortest way from the last q: q is only known modulo one octave
      const delta = positiveMod(q - this.turn.q + 0.5, 1) - 0.5;
      value = this.turn.value + delta;
    }
    this.turn = { q, value };
    const { positions, smooth } = this.motion.move(value, frame.when);
    for (const stack of this.moving) stack.move(positions, smooth, frame.when);
  }

  /** Fade out and release everything shortly after `when`. */
  dispose(when: number): void {
    this.fade.gain.setTargetAtTime(0, when, PAD_FADE_SECONDS / 5);
    const end = when + PAD_FADE_SECONDS * 2;
    const oscillators = this.nodes.filter((node): node is OscillatorNode => node instanceof OscillatorNode);
    for (const osc of oscillators) osc.stop(end);
    oscillators[0].onended = () => this.nodes.forEach((node) => node.disconnect());
  }
}

// ---------------------------------------------------------------------------------------------
// sweep

/** Seven filters one octave apart, from 60 Hz to 7.7 kHz. */
const SWEEP_SLOTS = 7;
const SWEEP_BASE_HZ = 60;
const SWEEP_Q = 7;
/** Standard deviation of the bell over the ring, in octaves. */
const SWEEP_SIGMA_OCT = 1.3;
const SWEEP_PAN = 0.5;
const SWEEP_NOISE_SECONDS = 4;
const SWEEP_FADE_SECONDS = 0.4;

/** Bell over the ring that reaches exactly zero at both edges. */
export function sweepGain(position: number): number {
  const z = (position - SWEEP_SLOTS / 2) / SWEEP_SIGMA_OCT;
  const edge = Math.exp(-0.5 * (SWEEP_SLOTS / 2 / SWEEP_SIGMA_OCT) ** 2);
  return Math.max(0, (Math.exp(-0.5 * z * z) - edge) / (1 - edge));
}

export function sweepFrequency(position: number): number {
  return SWEEP_BASE_HZ * Math.pow(2, position);
}

/**
 * Noise through a ring of resonant filters whose centres follow the tempo: one octave of
 * sweep per octave of tempo, so the rising tempo is a sound that rises for ever (the
 * filter-sweep form of the Shepard tone, the "barber pole").
 */
export class Sweep {
  private filters: BiquadFilterNode[] = [];
  private gains: GainNode[] = [];
  private nodes: AudioNode[] = [];
  private motion = new RingMotion(SWEEP_SLOTS);
  private source: AudioBufferSourceNode;
  /** Fade of the whole sweep, so that removing it does not cut the sound. */
  private fade: GainNode;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.fade = ctx.createGain();
    this.fade.connect(destination);
    const length = Math.round(SWEEP_NOISE_SECONDS * ctx.sampleRate);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    buffer.getChannelData(0).set(pinkNoiseLoop(length, createRandom(7)));
    const source = (this.source = ctx.createBufferSource());
    source.buffer = buffer;
    source.loop = true;
    source.start();

    // neighbouring filters go to opposite sides, so the sweep circles in the stereo field
    const sides = [-SWEEP_PAN, SWEEP_PAN].map((pan) => {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      panner.connect(this.fade);
      this.nodes.push(panner);
      return panner;
    });
    for (let slot = 0; slot < SWEEP_SLOTS; slot++) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = SWEEP_Q;
      perBlock(filter.frequency).value = sweepFrequency(slot);
      const gain = ctx.createGain();
      perBlock(gain.gain).value = 0;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(sides[slot % 2]);
      this.filters.push(filter);
      this.gains.push(gain);
    }
    this.nodes.push(this.fade, source, ...this.filters, ...this.gains);
  }

  update(frame: GraphFrame): void {
    // octaves of sweep = octaves of tempo; u counts layer ratios and relabels the whole ones
    const turn = (frame.state.relabels + frame.state.u) * Math.log2(frame.params.ratio);
    const { positions, smooth } = this.motion.move(turn, frame.when);
    positions.forEach((position, slot) => {
      drive(this.filters[slot].frequency, sweepFrequency(position), frame.when, smooth[slot], 'exponential');
      drive(this.gains[slot].gain, sweepGain(position), frame.when, smooth[slot], 'linear');
    });
  }

  /** Fade out and release everything shortly after `when`. */
  dispose(when: number): void {
    this.fade.gain.setTargetAtTime(0, when, SWEEP_FADE_SECONDS / 5);
    this.source.stop(when + SWEEP_FADE_SECONDS * 2);
    this.source.onended = () => this.nodes.forEach((node) => node.disconnect());
  }
}
