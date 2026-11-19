import type { LayerRatio, Meter, Preset, StairParams, Track, TrackRole } from './types';
import { annotateTrack, METERS } from './meter';

export function baseParams(ratio: LayerRatio = 2): StairParams {
  return {
    focusBpm: 112,
    tempoSlope: 2,
    pitchSlope: 1,
    pitchLink: true,
    pitchStep: 0,
    ratio,
    spread: 1.05,
    flutterHz: 18,
    levels: { drums: 0.72, melody: 0.5, pad: 0.16, sweep: 0, tape: 0, reverb: 0.12 },
    master: 0.7,
    solo: false,
  };
}

function track(id: string, role: TrackRole, meter: Meter, positions: number[], midi: number, center = 0): Track {
  return annotateTrack({
    id, role, lengthBeats: meter.beatsPerBar,
    notes: positions.map((beat) => ({ beat, dur: role === 'hat' ? 0.08 : 0.2, vel: 0.85, midi, rate: 1 })),
    gain: role === 'hat' ? 0.35 : 0.62, center, maxHz: role === 'hat' ? 12 : 24,
  }, meter);
}

function makePreset(id: string, name: string, blurb: string, meter: Meter, ratio: LayerRatio, parts: [number[], number[], number[]]): Preset {
  return {
    id, name, blurb, meter, kit: 'pure', timbre: 'organ',
    params: baseParams(ratio), tonic: 48, padChord: [0, 7],
    tracks: [
      track('pulse', 'kick', meter, parts[0], 36, -0.25),
      track('backbeat', 'snare', meter, parts[1], 38),
      track('ticks', 'hat', meter, parts[2], 42, 0.3),
      track('bass', 'bass', meter, [0, meter.beatsPerBar / 2], 48, -0.4),
    ],
  };
}

export const STAIRCASE_PRESETS: readonly Preset[] = [
  makePreset('pulse', 'ENDLESS PULSE', 'Tempo doubles but the downbeat keeps returning.', METERS[0], 2, [[0, 2], [1, 3], [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]]),
  makePreset('hemiola', 'HEMIOLA', 'A three-against-two rhythm folds into itself.', METERS[2], 1.5, [[0, 1], [0.5, 1.5], [0, 1 / 3, 2 / 3, 1, 4 / 3, 5 / 3]]),
  makePreset('triple', 'TRIPLE', 'A threefold tempo ladder under a repeating three-beat bar.', METERS[1], 3, [[0, 1.5], [1, 2], [0, 0.5, 1, 1.5, 2, 2.5]]),
];

export function clonePreset(preset: Preset): Preset {
  return {
    ...preset,
    meter: { ...preset.meter, barDivisions: [...preset.meter.barDivisions], beatDivisions: [...preset.meter.beatDivisions] },
    params: { ...preset.params, levels: { ...preset.params.levels } },
    tracks: preset.tracks.map((t) => ({ ...t, notes: t.notes.map((n) => ({ ...n })) })),
    padChord: [...preset.padChord],
  };
}
