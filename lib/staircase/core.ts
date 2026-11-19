/**
 * The rhythm staircase.
 *
 * A Shepard tone is a stack of sine waves one octave apart under a fixed bell over
 * log-frequency. Slide every component up and nothing changes after one octave, because
 * each component has taken its neighbour's place.
 *
 * The Risset rhythm is the same object four to eight octaves lower, where periodicity is
 * heard as tempo instead of pitch. Layer j plays the music at rate
 *
 *     R_j(t) = focus * ratio^(u(t) - j)            (beats per second)
 *
 * and every layer's gain depends only on how far it is from the focus tempo. With one
 * shared phase `phi` (the beat count of layer 0) and
 *
 *     phase_j = phi * ratio^(-j)
 *
 * neighbouring layers are locked at exactly `ratio`:1 at every instant, for any history of
 * slopes, so each layer's downbeats land on beats of the faster one (a metrical hierarchy).
 * When u has advanced by 1, layer j is exactly where layer j-1 was: relabelling the layers
 * (u -= 1, phi /= ratio) changes nothing audible. That relabelling is the whole illusion.
 *
 * Because the state is integrated instead of written as a closed form in t, the slope can
 * change at any moment (a tilting phone), be zero, or be negative.
 */

import { positiveMod, trackDensity } from './meter';
import {
  LayerInfo,
  LayerRatio,
  StairEvent,
  StairParams,
  StairState,
  Track,
} from './types';

/** The layer window is cut off this many standard deviations from its centre. */
export const WINDOW_SIGMAS = 3;
/** In solo mode the window is flattened so the single layer stays audible across its life. */
const SOLO_WINDOW_POWER = 0.3;
const MIN_EVENT_GAIN = 1e-3;
const SLOPE_EPSILON = 1e-9;
/** Octaves of metrical depth that count as a full accent. */
const ACCENT_OCTAVES = 3;

export function focusHz(params: StairParams): number {
  return params.focusBpm / 60;
}

/** Growth rate of tempo in 1/s for a slope in octaves per minute. */
function growthRate(tempoSlope: number): number {
  return (tempoSlope * Math.LN2) / 60;
}

/** Gaussian bell, shifted so it reaches exactly zero at +-WINDOW_SIGMAS. */
export function layerWindow(z: number): number {
  if (Math.abs(z) >= WINDOW_SIGMAS) return 0;
  const edge = Math.exp(-0.5 * WINDOW_SIGMAS * WINDOW_SIGMAS);
  return (Math.exp(-0.5 * z * z) - edge) / (1 - edge);
}

/** 1 below the ceiling, 0 above it, with a one-octave cosine skirt centred on it. */
export function ceilingGain(streamHz: number, ceilingHz: number): number {
  const octavesAbove = Math.log2(streamHz / ceilingHz);
  if (octavesAbove <= -0.5) return 1;
  if (octavesAbove >= 0.5) return 0;
  return 0.5 * (1 - Math.sin(Math.PI * octavesAbove));
}

const normCache = new Map<string, number>();

/**
 * Scale that makes the windows of all layers sum to 1, so a hit that coincides in every
 * layer has unit amplitude whatever the spread and ratio. The sum barely depends on u
 * (ripple about 1% at spread 0.85 with ratio 3, far less for 2 and 1.5), so it is averaged once.
 */
export function windowNorm(spread: number, ratio: LayerRatio): number {
  const key = `${spread}:${ratio}`;
  const cached = normCache.get(key);
  if (cached !== undefined) return cached;
  const spacing = Math.log2(ratio);
  const reach = Math.ceil((WINDOW_SIGMAS * spread) / spacing) + 1;
  const samples = 16;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const u = i / samples;
    for (let j = -reach; j <= reach; j++) {
      total += layerWindow(((u - j) * spacing) / spread);
    }
  }
  const norm = samples / total;
  normCache.set(key, norm);
  return norm;
}

/** Beat phase of layer 0 after `dt` seconds at a constant slope. */
function phiAfter(state: StairState, dt: number, tempoSlope: number, params: StairParams): number {
  const rate = focusHz(params) * Math.pow(params.ratio, state.u);
  const a = growthRate(tempoSlope);
  const beats = Math.abs(a) < SLOPE_EPSILON ? rate * dt : (rate * Math.expm1(a * dt)) / a;
  return state.phi + beats;
}

export function createState(time = 0): StairState {
  return { time, u: 0, phi: 0, relabels: 0, q: 0 };
}

/** Advance both staircases by `dt` seconds at constant slopes (octaves per minute). */
export function advanceState(
  state: StairState,
  dt: number,
  tempoSlope: number,
  pitchSlope: number,
  params: StairParams
): StairState {
  let phi = phiAfter(state, dt, tempoSlope, params);
  let u = state.u + (tempoSlope / 60 / Math.log2(params.ratio)) * dt;
  let relabels = state.relabels;
  while (u >= 1) {
    u -= 1;
    phi /= params.ratio;
    relabels += 1;
  }
  while (u < 0) {
    u += 1;
    phi *= params.ratio;
    relabels -= 1;
  }
  return {
    time: state.time + dt,
    u,
    phi,
    relabels,
    q: positiveMod(state.q + (pitchSlope / 60) * dt, 1),
  };
}

/** Layers whose distance from the focus lies within [minOct, maxOct]. */
export function layersInRange(
  state: StairState,
  params: StairParams,
  minOct: number,
  maxOct: number
): LayerInfo[] {
  const spacing = Math.log2(params.ratio);
  const first = Math.ceil(state.u - maxOct / spacing);
  const last = Math.floor(state.u - minOct / spacing);
  const hz = focusHz(params);
  const layers: LayerInfo[] = [];
  for (let j = first; j <= last; j++) {
    const xOct = (state.u - j) * spacing;
    layers.push({
      id: j + state.relabels,
      xOct,
      beatHz: hz * Math.pow(2, xOct),
      phase: state.phi * Math.pow(params.ratio, -j),
      window: layerWindow(xOct / params.spread),
    });
  }
  return layers;
}

/** Layers inside the window centred on the focus tempo. */
export function activeLayers(state: StairState, params: StairParams): LayerInfo[] {
  const reach = WINDOW_SIGMAS * params.spread;
  return layersInRange(state, params, -reach, reach);
}

/**
 * Every note onset in [state.time, state.time + dt), for all layers and tracks, with the
 * slopes held constant over the segment. Onset times come from the exact inverse of the
 * phase integral, so they do not depend on how the time line is cut into segments.
 */
export function scheduleSegment(
  state: StairState,
  dt: number,
  tempoSlope: number,
  pitchSlope: number,
  params: StairParams,
  tracks: Track[],
  soloLayerId: number | null = null
): StairEvent[] {
  if (dt <= 0) return [];
  const { ratio, spread } = params;
  const spacing = Math.log2(ratio);
  const hz = focusHz(params);
  const rate0 = hz * Math.pow(ratio, state.u);
  const a = growthRate(tempoSlope);
  const phi0 = state.phi;
  const phi1 = phiAfter(state, dt, tempoSlope, params);
  const uPerSecond = tempoSlope / 60 / spacing;
  const uLow = Math.min(state.u, state.u + uPerSecond * dt);
  const uHigh = Math.max(state.u, state.u + uPerSecond * dt);
  const norm = windowNorm(spread, ratio);
  const reach = WINDOW_SIGMAS * spread;
  const events: StairEvent[] = [];

  for (const track of tracks) {
    if (track.notes.length === 0 || track.gain <= 0) continue;
    const density = trackDensity(track);
    const ceilingHz = Math.min(track.maxHz, params.flutterHz);
    const first = Math.ceil(uLow - (track.center + reach) / spacing);
    const last = Math.floor(uHigh - (track.center - reach) / spacing);

    for (let j = first; j <= last; j++) {
      const layerId = j + state.relabels;
      if (soloLayerId !== null && layerId !== soloLayerId) continue;
      const scale = Math.pow(ratio, -j);
      const psi0 = phi0 * scale;
      const psi1 = phi1 * scale;
      const firstLoop = Math.floor(psi0 / track.lengthBeats);
      const lastLoop = Math.floor(psi1 / track.lengthBeats);

      for (let loop = firstLoop; loop <= lastLoop; loop++) {
        for (let n = 0; n < track.notes.length; n++) {
          const note = track.notes[n];
          const psi = loop * track.lengthBeats + note.beat;
          if (psi < psi0 || psi >= psi1) continue;

          const beatsAhead = (psi - psi0) / scale;
          const tau =
            Math.abs(a) < SLOPE_EPSILON
              ? beatsAhead / rate0
              : Math.log1p((a * beatsAhead) / rate0) / a;
          const xOct = (state.u + uPerSecond * tau - j) * spacing;
          const window = layerWindow((xOct - track.center) / spread);
          const beatHz = hz * Math.pow(2, xOct);
          const streamHz = beatHz * note.rate;
          const layerGain =
            soloLayerId === null ? window * norm : Math.pow(window, SOLO_WINDOW_POWER);
          const gain = note.vel * track.gain * layerGain * ceilingGain(streamHz, ceilingHz);
          if (gain < MIN_EVENT_GAIN) continue;

          const q = positiveMod(state.q + (pitchSlope / 60) * tau, 1);
          const stepped = params.pitchStep > 0;
          const stepOct = params.pitchStep / 12;
          events.push({
            time: state.time + tau,
            trackId: track.id,
            role: track.role,
            noteIndex: n,
            layerId,
            xOct,
            beatHz,
            streamHz,
            accent: Math.min(1, Math.max(0, Math.log2(density / note.rate) / ACCENT_OCTAVES)),
            gain,
            durSec: note.dur / beatHz,
            midi: note.midi,
            pitchOct: stepped ? positiveMod(Math.floor(q / stepOct + 1e-9) * stepOct, 1) : q,
            pitchGlide: stepped ? 0 : pitchSlope / 60,
          });
        }
      }
    }
  }

  events.sort((p, r) => p.time - r.time);
  return events;
}

/**
 * The state from which a constant slope repeats exactly. For a constant growth rate a the
 * self-similar solution is phi = R / a (phase equals rate over log-rate slope): after one
 * ratio step and one relabelling, every layer is back at its starting phase.
 * Returns null when the tempo slope is zero, because nothing then cycles.
 */
export function loopSpec(
  params: StairParams
): { state: StairState; seconds: number; pitchSlope: number } | null {
  if (Math.abs(params.tempoSlope) < 1e-6) return null;
  const seconds = (60 * Math.log2(params.ratio)) / Math.abs(params.tempoSlope);
  const requestedPitch = params.pitchLink ? params.tempoSlope : params.pitchSlope;
  // The pitch staircase must also come back to where it started: whole octaves per cycle.
  const octavesPerCycle = Math.round((requestedPitch * seconds) / 60);
  return {
    state: {
      time: 0,
      u: 0,
      phi: focusHz(params) / growthRate(params.tempoSlope),
      relabels: 0,
      q: 0,
    },
    seconds,
    pitchSlope: (octavesPerCycle * 60) / seconds,
  };
}

/**
 * Which layer to play alone. Keeps the current one while it is inside the window; otherwise
 * picks the layer that has just entered, so it can be followed through its whole life.
 */
export function pickSoloLayer(
  current: number | null,
  state: StairState,
  params: StairParams,
  tempoSlope: number
): number | null {
  const layers = activeLayers(state, params);
  if (layers.length === 0) return null;
  if (current !== null && layers.some((layer) => layer.id === current)) return current;
  const entering = layers.reduce((best, layer) =>
    (tempoSlope >= 0 ? layer.xOct < best.xOct : layer.xOct > best.xOct) ? layer : best
  );
  return entering.id;
}
