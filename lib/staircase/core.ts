import type { LayerInfo, Partial, Preset, StairEvent, StairParams, StairState, Track } from './types';
import { accentForRate } from './meter';

const TAU = Math.PI * 2;
const mod = (x: number, n: number) => ((x % n) + n) % n;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const smooth = (x: number) => { const y = clamp(x, 0, 1); return y * y * (3 - 2 * y); };
const gaussian = (x: number, sigma: number) => Math.exp(-0.5 * (x / Math.max(0.1, sigma)) ** 2);

export const initialState = (time = 0): StairState => ({ time, u: 0, phi: 0, relabels: 0, q: 0 });

export function effectivePitchSlope(params: StairParams): number {
  return params.pitchLink ? params.tempoSlope : params.pitchSlope;
}

export function advanceState(state: StairState, dt: number, params: StairParams): StairState {
  if (!(dt >= 0) || !Number.isFinite(dt)) throw new RangeError('dt must be finite and non-negative');
  const stepOct = Math.log2(params.ratio);
  const g = state.u - state.relabels;
  const gNext = g + (params.tempoSlope * dt) / (60 * stepOct);
  const whole = Math.floor(gNext);
  const k = Math.LN2 * params.tempoSlope / 60;
  const f0 = (params.focusBpm / 60) * Math.pow(params.ratio, g);
  const beats = Math.abs(k) < 1e-9 ? f0 * dt : f0 * Math.expm1(k * dt) / k;
  return {
    time: state.time + dt,
    u: gNext - whole,
    phi: state.phi + beats,
    relabels: -whole,
    q: mod(state.q + effectivePitchSlope(params) * dt / 60, 1),
  };
}

export function getLayers(state: StairState, params: StairParams): LayerInfo[] {
  const stepOct = Math.log2(params.ratio);
  const reach = Math.max(3, Math.ceil((params.spread * 3.5 + 0.75) / stepOct));
  const layers: LayerInfo[] = [];
  for (let i = -reach; i <= reach; i++) {
    const xOct = (i + state.u) * stepOct;
    const id = i + state.relabels;
    layers.push({
      id,
      xOct,
      beatHz: (params.focusBpm / 60) * Math.pow(2, xOct),
      phase: mod(state.phi * Math.pow(params.ratio, id), 1),
      window: gaussian(xOct, params.spread),
    });
  }
  return layers;
}

export function pitchAt(state: StairState, dt: number, params: StairParams): { oct: number; glide: number } {
  const glide = effectivePitchSlope(params) / 60;
  const raw = mod(state.q + glide * dt, 1);
  const quantum = params.pitchStep / 12;
  return params.pitchStep > 0
    ? { oct: mod(Math.round(raw / quantum) * quantum, 1), glide: 0 }
    : { oct: raw, glide };
}

export function getPadPartials(state: StairState, preset: Preset): Partial[] {
  const root = 440 * Math.pow(2, (preset.tonic - 69) / 12);
  const partials: Partial[] = [];
  for (const chord of preset.padChord) {
    for (let i = -3; i <= 3; i++) {
      const oct = i + state.q;
      const hz = root * Math.pow(2, oct + chord / 12);
      if (hz >= 20 && hz <= 16000) partials.push({ hz, gain: gaussian(oct, 1.35) / Math.max(1, preset.padChord.length) });
    }
  }
  return partials;
}

function triggerGain(xOct: number, track: Track, beatHz: number, params: StairParams, rate: number): number {
  const streamHz = beatHz * rate;
  const limit = Math.min(track.maxHz, params.flutterHz);
  const ceiling = 1 - smooth((streamHz - limit * 0.65) / (limit * 0.35));
  const level = ['kick', 'snare', 'hat', 'perc'].includes(track.role) ? params.levels.drums : params.levels.melody;
  return Math.max(0, track.gain * gaussian(xOct - track.center, params.spread) * ceiling * level * params.master);
}

export function eventsBetween(state: StairState, seconds: number, preset: Preset): StairEvent[] {
  const params = preset.params;
  if (!(seconds > 0) || !Number.isFinite(seconds)) return [];
  const later = advanceState(state, seconds, params);
  const ids = new Set([...getLayers(state, params), ...getLayers(later, params)].map((layer) => layer.id));
  const g = state.u - state.relabels;
  const k = Math.LN2 * params.tempoSlope / 60;
  const startBeatHz = params.focusBpm / 60 * Math.pow(params.ratio, g);
  const pitchSlope = effectivePitchSlope(params);
  const events: StairEvent[] = [];
  const selectedId = getLayers(state, params).reduce((a, b) => Math.abs(a.xOct) < Math.abs(b.xOct) ? a : b).id;
  for (const id of ids) {
    if (params.solo && id !== selectedId) continue;
    const ratioPow = Math.pow(params.ratio, id);
    const f = startBeatHz * ratioPow;
    const startPhase = state.phi * ratioPow;
    const beatsWindow = Math.abs(k) < 1e-9 ? f * seconds : f * Math.expm1(k * seconds) / k;
    for (const track of preset.tracks) {
      if (!(track.lengthBeats > 0)) continue;
      for (let noteIndex = 0; noteIndex < track.notes.length; noteIndex++) {
        const note = track.notes[noteIndex];
        const first = Math.ceil((startPhase - note.beat - 1e-8) / track.lengthBeats);
        const last = Math.floor((startPhase + beatsWindow - note.beat - 1e-8) / track.lengthBeats);
        for (let cycle = first; cycle <= last; cycle++) {
          const beatOffset = note.beat + cycle * track.lengthBeats - startPhase;
          if (beatOffset < -1e-7) continue;
          const argument = 1 + k * beatOffset / f;
          if (argument <= 0) continue;
          const dt = Math.abs(k) < 1e-9 ? beatOffset / f : Math.log(argument) / k;
          if (dt < -1e-7 || dt >= seconds - 1e-8) continue;
          const at = advanceState(state, Math.max(0, dt), params);
          const xOct = (id - at.relabels + at.u) * Math.log2(params.ratio);
          const beatHz = f * Math.exp(k * dt);
          const gain = triggerGain(xOct, track, beatHz, params, note.rate) * note.vel;
          if (gain < 1e-5) continue;
          const pitch = pitchAt(state, dt, params);
          events.push({
            time: state.time + dt,
            trackId: track.id,
            role: track.role,
            noteIndex,
            layerId: id,
            xOct,
            beatHz,
            streamHz: beatHz * note.rate,
            accent: accentForRate(note.rate, track),
            gain,
            durSec: clamp(note.dur / beatHz, 0.025, 2),
            midi: note.midi,
            pitchOct: pitch.oct,
            pitchGlide: pitch.glide,
          });
        }
      }
    }
  }
  return events.sort((a, b) => a.time - b.time || a.trackId.localeCompare(b.trackId));
}

export function loopSeconds(params: StairParams): number {
  if (Math.abs(params.tempoSlope) < 1e-9) throw new RangeError('tempo slope must be nonzero');
  return 60 * Math.log2(params.ratio) / Math.abs(params.tempoSlope);
}

export function wrapSeam(samples: Float32Array, overlap: number): void {
  const length = samples.length;
  const n = Math.min(Math.max(0, overlap), Math.floor(length / 2));
  if (n < 2) return;
  const head = samples.slice(0, n);
  for (let i = 0; i < n; i++) {
    const mix = i / (n - 1);
    samples[length - n + i] = samples[length - n + i] * (1 - mix) + head[i] * mix;
  }
}
