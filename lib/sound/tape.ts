/**
 * Tape layers: the main-thread side of public/worklets/tape-layers.js.
 *
 * One loop is replayed by read heads a layer ratio apart in speed. This file makes the loops
 * (the preset's drum rhythm as pulses, or decoded audio) and talks to the worklet node.
 */

import { DrumRole, Meter, Track, isDrumRole } from '../staircase/types';
import type { GraphFrame } from './graph';

export interface TapeLoop {
  samples: Float32Array;
  /** Beats in the loop. Head positions are beats of the staircase, taken modulo this. */
  loopBeats: number;
  /** Beats per second at which the loop plays at its recorded speed, one source sample per output sample. */
  naturalBeatHz: number;
}

const WORKLET_URL = '/worklets/tape-layers.js';
const MAX_BARS = 4;
/**
 * Loudest sample of a loop. The worklet divides the sum of its heads by the square root of
 * their number, but their hits coincide on the shared beat, so output peaks come out at about
 * two thirds of this (measured on the Pulse preset), and a dense pattern leaves some headroom.
 */
export const LOOP_PEAK = 0.5;

/** Length of the click that every pulse starts with. */
const CLICK_SECONDS = 0.001;
/** Peak of the damped sine under the click, relative to the click. */
const BODY_LEVEL = 0.7;
/** The damped sine is cut where it has decayed to about this fraction of its start. */
const BODY_CUTOFF = Math.exp(-8);

interface PulseVoice {
  /** Level of the role, relative to a kick. */
  weight: number;
  bodyHz: number;
  /** Time constant of the decay. 0 = click only. */
  bodySeconds: number;
}

const VOICES: Record<DrumRole, PulseVoice> = {
  kick: { weight: 1, bodyHz: 55, bodySeconds: 0.06 },
  snare: { weight: 0.8, bodyHz: 190, bodySeconds: 0.04 },
  perc: { weight: 0.6, bodyHz: 330, bodySeconds: 0.025 },
  hat: { weight: 0.5, bodyHz: 0, bodySeconds: 0 },
};

/**
 * One pulse, from its onset to where it has died away. It is a raised-cosine click of 1 ms
 * plus a damped sine (the thump of a kick, the knock of a snare or perc).
 *
 * Slowly, the click is a soft tick that defines the beat and the sine is its body. Replayed
 * hundreds of times per second the pulse turns into a tone whose spectrum is the pulse's own,
 * with every frequency multiplied by the speed: the sine becomes a resonance at bodyHz times
 * the speed, and the click, which is unipolar and so keeps its area as it is compressed,
 * supplies everything above it (measured: at the speed of 5 octaves above the focus, the share
 * of energy above 10 kHz is 16 dB higher than with the sine alone).
 */
function pulseShape(voice: PulseVoice, sampleRate: number): Float32Array {
  const seconds =
    voice.bodySeconds > 0 ? Math.max(CLICK_SECONDS, -voice.bodySeconds * Math.log(BODY_CUTOFF)) : CLICK_SECONDS;
  const shape = new Float32Array(Math.ceil(seconds * sampleRate) + 1);
  for (let i = 0; i < shape.length; i++) {
    const t = i / sampleRate;
    let value = t < CLICK_SECONDS ? 0.5 * (1 - Math.cos((2 * Math.PI * t) / CLICK_SECONDS)) : 0;
    if (voice.bodySeconds > 0) {
      const decay = Math.exp(-t / voice.bodySeconds);
      if (decay > BODY_CUTOFF) value += BODY_LEVEL * decay * Math.sin(2 * Math.PI * voice.bodyHz * t);
    }
    shape[i] = value;
  }
  return shape;
}

function scaleToPeak(samples: Float32Array, peak: number): void {
  let loudest = 0;
  for (let i = 0; i < samples.length; i++) loudest = Math.max(loudest, Math.abs(samples[i]));
  if (loudest === 0) return;
  const gain = peak / loudest;
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
}

/** A hit of the loop: when (beats from its start), how hard, and what it sounds like. */
interface Hit {
  beat: number;
  level: number;
  voice: PulseVoice;
}

/**
 * Hits of the drum tracks within `loopBeats`; shorter tracks repeat to fill it. Without any
 * drum note there is one pulse per beat, the downbeat a little stronger.
 */
function drumHits(tracks: Track[], meter: Meter, loopBeats: number): Hit[] {
  const hits: Hit[] = [];
  for (const track of tracks) {
    if (!isDrumRole(track.role) || track.gain <= 0 || track.lengthBeats <= 0) continue;
    const voice = VOICES[track.role];
    for (let start = 0; start < loopBeats - 1e-9; start += track.lengthBeats) {
      for (const note of track.notes) {
        const beat = start + note.beat;
        if (beat < loopBeats - 1e-9) hits.push({ beat, level: note.vel * track.gain * voice.weight, voice });
      }
    }
  }
  if (hits.length > 0) return hits;
  for (let beat = 0; beat < meter.beatsPerBar; beat++) {
    hits.push({ beat, level: beat === 0 ? 1 : 0.6, voice: VOICES.kick });
  }
  return hits;
}

/**
 * One loop of the drum tracks as pulses, at the speed where a beat lasts 1/focusHz seconds.
 * The loop is the longest drum track rounded up to whole bars (at most four); shorter tracks
 * repeat. Pulses wrap around the end, so the loop is seamless.
 */
export function renderPulseLoop(tracks: Track[], meter: Meter, focusHz: number, sampleRate: number): TapeLoop {
  const drums = tracks.filter((track) => isDrumRole(track.role) && track.notes.length > 0);
  const longest = Math.max(meter.beatsPerBar, ...drums.map((track) => track.lengthBeats));
  const bars = Math.min(MAX_BARS, Math.ceil(longest / meter.beatsPerBar - 1e-9));
  const loopBeats = bars * meter.beatsPerBar;
  const length = Math.max(2, Math.round((loopBeats / focusHz) * sampleRate));
  const samples = new Float32Array(length);

  const shapes = new Map<PulseVoice, Float32Array>();
  for (const hit of drumHits(drums, meter, loopBeats)) {
    let shape = shapes.get(hit.voice);
    if (!shape) shapes.set(hit.voice, (shape = pulseShape(hit.voice, sampleRate)));
    let index = Math.round((hit.beat / loopBeats) * length) % length;
    for (let k = 0; k < shape.length; k++) {
      samples[index] += hit.level * shape[k];
      if (++index === length) index = 0;
    }
  }
  scaleToPeak(samples, LOOP_PEAK);
  return { samples, loopBeats, naturalBeatHz: (loopBeats * sampleRate) / length };
}

/**
 * Decoded audio as a loop: the channels mixed down to mono, played at its recorded speed when
 * the beat rate is `focusHz`. The buffer must be at the sample rate of the context that plays it.
 */
export function loopFromAudioBuffer(buffer: AudioBuffer, focusHz: number): TapeLoop {
  const samples = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < samples.length; i++) samples[i] += channel[i] / buffer.numberOfChannels;
  }
  scaleToPeak(samples, LOOP_PEAK);
  return { samples, loopBeats: buffer.duration * focusHz, naturalBeatHz: focusHz };
}

export interface FrameMessage {
  when: number;
  u: number;
  phi: number;
  relabels: number;
  tempoSlope: number;
  focusHz: number;
  ratio: number;
}

/** What the worklet needs of a frame: the staircase state and the slope that applies from `when`. */
export function frameMessage(frame: GraphFrame): FrameMessage {
  return {
    when: frame.when,
    u: frame.state.u,
    phi: frame.state.phi,
    relabels: frame.state.relabels,
    tempoSlope: frame.tempoSlope,
    focusHz: frame.params.focusBpm / 60,
    ratio: frame.params.ratio,
  };
}

const modules = new WeakMap<BaseAudioContext, Promise<void>>();

function loadModule(ctx: BaseAudioContext): Promise<void> {
  let loaded = modules.get(ctx);
  if (!loaded) {
    loaded = ctx.audioWorklet.addModule(WORKLET_URL);
    modules.set(ctx, loaded);
    // A failed load is not cached, so a later call can try again.
    loaded.catch(() => modules.delete(ctx));
  }
  return loaded;
}

/**
 * The tape node: no inputs, stereo output. Rejects if the worklet module cannot be loaded.
 * With neither frame nor loop it is silent until postFrame and postLoop have been called.
 *
 * A live context gets its loop by message once the node exists: the worklet builds the mips a
 * slice per block, where building them while the node is created would stall the audio thread
 * for the length of a long recording. An offline context has not started yet, so it takes the
 * loop with the node and renders it from the first sample.
 */
export async function createTapeNode(
  ctx: BaseAudioContext,
  options: { frame?: GraphFrame; loop?: TapeLoop } = {}
): Promise<AudioWorkletNode> {
  await loadModule(ctx);
  const offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
  const node = new AudioWorkletNode(ctx, 'tape-layers', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      frame: options.frame && frameMessage(options.frame),
      loop: offline ? options.loop : undefined,
    },
  });
  if (!offline && options.loop) postLoop(node, options.loop);
  return node;
}

/** Frames may be posted slightly ahead of their `when`, in time order. */
export function postFrame(node: AudioWorkletNode, frame: GraphFrame): void {
  node.port.postMessage({ type: 'frame', ...frameMessage(frame) });
}

export function postLoop(node: AudioWorkletNode, loop: TapeLoop): void {
  node.port.postMessage({ type: 'loop', ...loop });
}
