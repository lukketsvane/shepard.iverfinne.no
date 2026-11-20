/**
 * Pitched voices (bass, keys, lead).
 *
 * Every voice is octave-ambiguous, so the pitch staircase can wrap without a jump:
 * - organ, glass and reed are one octave-stacked wavetable played at the lowest octave of the
 *   note's pitch class; the stack's bell over log-frequency sits where the role lives.
 * - pluck is a plucked steel string, sounded in the one to three octave copies of the note that
 *   fall around that bell, with weights from the same bell (a pitch class needs no octave to be
 *   heard as a pitch).
 */

import { positiveMod } from '../staircase/meter';
import {
  SpectralEnvelope,
  WavetableTimbre,
  envelopeGain,
  foldToFloor,
  midiToHz,
  shepardWavetable,
} from '../staircase/pitch';
import { PitchedRole, StairEvent, TimbreId } from '../staircase/types';
import { biquad, createRandom, fadeOut, hashSeed, normalise, pause, removeDc, whiteNoise } from './dsp';
import { Ringing } from './ringing';

/** Each role has its own centre of gravity, so bass, keys and lead sit in their own registers. */
export const VOICE_ENVELOPE: Record<PitchedRole, SpectralEnvelope> = {
  bass: { centerHz: 110, sigmaOct: 1.3 },
  keys: { centerHz: 300, sigmaOct: 1.1 },
  lead: { centerHz: 700, sigmaOct: 1.2 },
};

interface RoleShape {
  /** Linear level of a unit-gain note. */
  level: number;
  /** Whether the role goes through the chorus (keys and lead); the bass stays mono and dry. */
  chorus: boolean;
  attack: number;
  release: number;
  /** Lowpass cutoff as a multiple of the bell centre at the strike, and where it settles. */
  brightStart: number;
  brightEnd: number;
  /** Stereo offset by layer parity. */
  pan: number;
}

const SHAPES: Record<PitchedRole, RoleShape> = {
  bass: { level: 0.4, chorus: false, attack: 0.008, release: 0.18, brightStart: 7, brightEnd: 2.4, pan: 0 },
  keys: { level: 0.28, chorus: true, attack: 0.006, release: 0.2, brightStart: 8, brightEnd: 2.4, pan: 0.35 },
  lead: { level: 0.22, chorus: true, attack: 0.004, release: 0.22, brightStart: 7, brightEnd: 3, pan: 0.45 },
};

const MIN_NOTE_SECONDS = 0.05;
const MAX_NOTE_SECONDS = 4;
const FILTER_SETTLE_SECONDS = 0.25;
/** The release falls to this (-80 dB) and the note is stopped there. */
const SILENCE = 1e-4;
/** Octave copies of a plucked note weaker than this (-12 dB) are left out: they cost a node and add little. */
const MIN_PLUCK_WEIGHT = 0.25;
const WAVE_CENTS_PER_STEP = 5;
const WAVE_STEPS_PER_OCTAVE = 1200 / WAVE_CENTS_PER_STEP;
const WAVE_CACHE_SIZE = 600;

/** Mild loudness curve: quiet notes (layers fading in or out) fall away a little faster than linear. */
export function loudness(gain: number): number {
  return Math.pow(gain, 1.25);
}

/**
 * The pitch class of `hz` on a grid of 5 cents (anchored at 1 Hz, so the grid repeats every
 * octave): the wavetable index, and the small factor the oscillator must be scaled by to land
 * on the exact pitch.
 */
export function pitchClassStep(hz: number): { index: number; ratio: number } {
  const steps = WAVE_STEPS_PER_OCTAVE * Math.log2(hz);
  const nearest = Math.round(steps);
  return {
    index: positiveMod(nearest, WAVE_STEPS_PER_OCTAVE),
    ratio: Math.pow(2, (steps - nearest) / WAVE_STEPS_PER_OCTAVE),
  };
}

/** Caches PeriodicWaves by role, timbre and quantised pitch class. */
class WaveCache {
  private waves = new Map<string, { wave: PeriodicWave; fundamentalHz: number }>();

  constructor(private ctx: BaseAudioContext) {}

  /** Wave and the frequency at which an oscillator must run to sound a note of pitch `hz`. */
  lookup(role: PitchedRole, timbre: WavetableTimbre, hz: number): { wave: PeriodicWave; frequency: number } {
    const { index, ratio } = pitchClassStep(hz);
    const key = `${role}:${timbre}:${index}`;
    let entry = this.waves.get(key);
    if (!entry) {
      const table = shepardWavetable(Math.pow(2, index / WAVE_STEPS_PER_OCTAVE), VOICE_ENVELOPE[role], timbre);
      const wave = this.ctx.createPeriodicWave(table.real, table.imag, { disableNormalization: true });
      entry = { wave, fundamentalHz: table.fundamentalHz };
      if (this.waves.size >= WAVE_CACHE_SIZE) this.waves.delete(this.waves.keys().next().value as string);
      this.waves.set(key, entry);
    }
    return { wave: entry.wave, frequency: entry.fundamentalHz * ratio };
  }
}

// ---------------------------------------------------------------------------------------------
// plucked string

/**
 * Octaves either side of the bell centre that a plucked note is sounded in (so one to three
 * octave copies of it), and the taper at that edge. Each copy is a source and a gain node.
 */
const PLUCK_REACH_OCT = 1.25;
const PLUCK_TAPER_OCT = 0.5;
/** Reference strings are rendered every half octave from here; a note plays the nearest, resampled by at most 2^(1/4). */
const PLUCK_REF_LOW_HZ = 27.5;
const PLUCK_REFS_PER_OCTAVE = 2;
const PLUCK_REF_COUNT = 14;
/**
 * A string is peak-normalised and then falls away, so its energy is a fraction of that of a
 * sustained tone with the same peak; this brings a plucked note to the loudness of the wavetables.
 */
const PLUCK_LEVEL = 5;
/** Seconds to fall 60 dB for a string at 110 Hz; higher strings die faster, as real ones do. */
const PLUCK_T60_AT_110 = 3.2;

export interface PluckCopy {
  hz: number;
  /** Power-normalised: the squares of all weights of one note sum to 1. */
  weight: number;
}

/** The octave copies of a pitch class that sound together, weighted by the role's bell. Octave-invariant. */
export function pluckCopies(hz: number, env: SpectralEnvelope): PluckCopy[] {
  const low = env.centerHz * Math.pow(2, -PLUCK_REACH_OCT);
  const pitchClass = foldToFloor(hz);
  const copies: PluckCopy[] = [];
  let power = 0;
  for (let f = pitchClass * Math.pow(2, Math.ceil(Math.log2(low / pitchClass))); ; f *= 2) {
    const x = Math.log2(f / env.centerHz);
    if (Math.abs(x) >= PLUCK_REACH_OCT) {
      if (x > 0) break;
      continue;
    }
    const edge = Math.min(1, (PLUCK_REACH_OCT - Math.abs(x)) / PLUCK_TAPER_OCT);
    const weight = envelopeGain(f, env) * edge;
    if (weight <= 0) continue;
    copies.push({ hz: f, weight });
    power += weight * weight;
  }
  const scale = power > 0 ? 1 / Math.sqrt(power) : 0;
  return copies.map((copy) => ({ ...copy, weight: copy.weight * scale }));
}

export function pluckRefHz(index: number): number {
  return PLUCK_REF_LOW_HZ * Math.pow(2, index / PLUCK_REFS_PER_OCTAVE);
}

export function nearestPluckRef(hz: number): number {
  const index = Math.round(PLUCK_REFS_PER_OCTAVE * Math.log2(hz / PLUCK_REF_LOW_HZ));
  return Math.max(0, Math.min(PLUCK_REF_COUNT - 1, index));
}

/**
 * A steel string by Karplus-Strong: a burst of noise, combed by the pick position, circulating
 * in a delay line whose loop filter takes the highs out faster than the lows. The fractional
 * part of the delay comes from an all-pass, so the pitch is exact at any sample rate.
 */
export function renderPluck(hz: number, sampleRate: number, seed: number): Float32Array {
  const rand = createRandom(seed);
  const t60 = Math.max(1.2, Math.min(PLUCK_T60_AT_110, PLUCK_T60_AT_110 * Math.pow(hz / 110, -0.35)));
  const out = new Float32Array(Math.round((t60 + 0.25) * sampleRate));

  const brightness = 0.62;
  const loopGain = Math.pow(0.001, 1 / (t60 * hz));
  // the averaging filter delays by (1 - brightness) samples at low frequencies
  const total = sampleRate / hz - (1 - brightness);
  const length = Math.floor(total - 0.5);
  const fraction = total - length;
  const coeff = (1 - fraction) / (1 + fraction);

  // pick position: the excitation minus a copy of itself shifted by a fraction of the string
  const burst = biquad(whiteNoise(length, rand), 'lowpass', 6000, 0.7, sampleRate);
  const pick = Math.round((0.12 + 0.1 * rand()) * length);
  const line = new Float32Array(length);
  for (let i = 0; i < length; i++) line[i] = burst[i] - burst[(i - pick + length) % length];
  removeDc(line);

  let at = 0;
  let previous = 0;
  let allpassIn = 0;
  let allpassOut = 0;
  for (let n = 0; n < out.length; n++) {
    const x = line[at];
    out[n] = x;
    const smoothed = brightness * x + (1 - brightness) * previous;
    previous = x;
    const shifted = coeff * smoothed + allpassIn - coeff * allpassOut;
    allpassIn = smoothed;
    allpassOut = shifted;
    line[at] = loopGain * shifted;
    at = at + 1 === length ? 0 : at + 1;
  }
  return normalise(fadeOut(out, 0.12, sampleRate), 0.9);
}

// ---------------------------------------------------------------------------------------------
// playing notes

/** Chorus: two short delays swept slowly in opposite directions, thrown to the left and right. */
const CHORUS = [
  { delay: 0.014, depth: 0.003, rate: 0.31, pan: -0.8 },
  { delay: 0.021, depth: 0.004, rate: 0.47, pan: 0.8 },
];
const CHORUS_WET = 0.5;

export class PitchedVoices {
  private timbre: TimbreId = 'glass';
  /** Counts the choices of timbre, so that a slow one never overwrites a newer one. */
  private timbreVersion = 0;
  private waves: WaveCache;
  private plucks = new Map<number, AudioBuffer>();
  /** Two inputs per role, one per layer parity, panned apart so layers interleave in space. */
  private inputs = new Map<PitchedRole, AudioNode[]>();
  private nodes: AudioNode[] = [];

  constructor(
    private ctx: BaseAudioContext,
    out: AudioNode,
    private ringing: Ringing
  ) {
    this.waves = new WaveCache(ctx);
    const chorus = this.createChorus(out);
    for (const role of Object.keys(SHAPES) as PitchedRole[]) {
      const { pan, chorus: wide } = SHAPES[role];
      const inputs = [-pan, pan].map((position) => {
        const input = ctx.createGain();
        const panner = ctx.createStereoPanner();
        panner.pan.value = position;
        input.connect(panner);
        panner.connect(wide ? chorus : out);
        this.nodes.push(input, panner);
        return input;
      });
      this.inputs.set(role, inputs);
    }
  }

  /** Dry signal plus two swept delays; returns the input. */
  private createChorus(out: AudioNode): AudioNode {
    const input = this.ctx.createGain();
    input.connect(out);
    this.nodes.push(input);
    for (const voice of CHORUS) {
      const delay = this.ctx.createDelay(0.05);
      delay.delayTime.value = voice.delay;
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = voice.rate;
      const depth = this.ctx.createGain();
      depth.gain.value = voice.depth;
      lfo.connect(depth);
      depth.connect(delay.delayTime);
      lfo.start();
      const wet = this.ctx.createGain();
      wet.gain.value = CHORUS_WET;
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = voice.pan;
      input.connect(delay);
      delay.connect(wet);
      wet.connect(panner);
      panner.connect(out);
      this.nodes.push(delay, lfo, depth, wet, panner);
    }
    return input;
  }

  /**
   * Choose the timbre once it is ready. A plucked timbre first renders the strings the given
   * roles will need, one at a time with a pause between, so that playing is not held up.
   */
  async setTimbre(timbre: TimbreId, roles: Iterable<PitchedRole>): Promise<void> {
    const version = ++this.timbreVersion;
    if (timbre === 'pluck') {
      for (const role of roles) {
        const env = VOICE_ENVELOPE[role];
        const reach = Math.pow(2, PLUCK_REACH_OCT);
        for (let index = nearestPluckRef(env.centerHz / reach); index <= nearestPluckRef(env.centerHz * reach); index++) {
          if (this.plucks.has(index)) continue;
          const samples = renderPluck(pluckRefHz(index), this.ctx.sampleRate, hashSeed('pluck', index));
          const buffer = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
          buffer.getChannelData(0).set(samples);
          this.plucks.set(index, buffer);
          await pause();
        }
      }
    }
    // a newer choice made while the strings were rendering wins
    if (version === this.timbreVersion) this.timbre = timbre;
  }

  /** `fade` (0..1) scales the note, for those just above the threshold of what is worth playing. */
  play(event: StairEvent, when: number, fade = 1): void {
    if (event.role !== 'bass' && event.role !== 'keys' && event.role !== 'lead') return;
    const role: PitchedRole = event.role;
    const shape = SHAPES[role];
    const hz = midiToHz(event.midi + 12 * event.pitchOct);
    const duration = Math.max(MIN_NOTE_SECONDS, Math.min(MAX_NOTE_SECONDS, event.durSec));
    const level = shape.level * loudness(event.gain) * fade * (1 + 0.15 * event.accent);
    const end = when + duration + shape.release;

    // soft attack, sustain, then a release that falls linearly in dB
    const envelope = this.ctx.createGain();
    envelope.gain.setValueAtTime(0, when);
    envelope.gain.linearRampToValueAtTime(level, when + shape.attack);
    envelope.gain.setValueAtTime(level, when + duration);
    envelope.gain.exponentialRampToValueAtTime(SILENCE, end);
    envelope.connect(this.inputs.get(role)![((event.layerId % 2) + 2) % 2]);

    const sources =
      this.timbre === 'pluck'
        ? this.pluckSources(role, hz, event, when, envelope)
        : this.oscillator(role, this.timbre, hz, event, when, end, envelope);
    for (const source of sources) {
      source.stop(end);
      this.ringing.add(source);
    }
  }

  private oscillator(
    role: PitchedRole,
    timbre: WavetableTimbre,
    hz: number,
    event: StairEvent,
    when: number,
    end: number,
    out: AudioNode
  ): AudioScheduledSourceNode[] {
    const shape = SHAPES[role];
    const { wave, frequency } = this.waves.lookup(role, timbre, hz);

    // a lowpass that opens on the strike and settles: the note blooms instead of sitting still
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.9;
    // per block: sample-accurate cutoff would recompute the filter for every sample of every note
    filter.frequency.automationRate = 'k-rate';
    const centre = VOICE_ENVELOPE[role].centerHz;
    filter.frequency.setValueAtTime(centre * shape.brightStart * (1 + event.accent), when);
    filter.frequency.exponentialRampToValueAtTime(centre * shape.brightEnd, when + FILTER_SETTLE_SECONDS);
    filter.connect(out);

    const osc = this.ctx.createOscillator();
    osc.setPeriodicWave(wave);
    osc.frequency.setValueAtTime(frequency, when);
    if (event.pitchGlide !== 0) {
      osc.frequency.exponentialRampToValueAtTime(frequency * Math.pow(2, event.pitchGlide * (end - when)), end);
    }
    osc.connect(filter);
    osc.start(when);
    return [osc];
  }

  private pluckSources(
    role: PitchedRole,
    hz: number,
    event: StairEvent,
    when: number,
    out: AudioNode
  ): AudioScheduledSourceNode[] {
    return pluckCopies(hz, VOICE_ENVELOPE[role]).flatMap((copy) => {
      const index = nearestPluckRef(copy.hz);
      const buffer = this.plucks.get(index);
      if (!buffer || copy.weight < MIN_PLUCK_WEIGHT) return [];
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      const rate = copy.hz / pluckRefHz(index);
      source.playbackRate.value = rate;
      if (event.pitchGlide !== 0) {
        const span = Math.min(buffer.duration / rate, MAX_NOTE_SECONDS);
        source.playbackRate.exponentialRampToValueAtTime(rate * Math.pow(2, event.pitchGlide * span), when + span);
      }
      const weight = this.ctx.createGain();
      weight.gain.value = copy.weight * PLUCK_LEVEL;
      source.connect(weight);
      weight.connect(out);
      source.start(when);
      return [source];
    });
  }

  dispose(): void {
    for (const node of this.nodes) {
      if (node instanceof OscillatorNode) node.stop();
      node.disconnect();
    }
    this.nodes = [];
    this.inputs.clear();
  }
}
