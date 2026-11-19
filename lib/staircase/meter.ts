import type { ClipNote, Meter, Track } from './types';

export const METERS: readonly Meter[] = [
  { label: '4/4', beatsPerBar: 4, barDivisions: [2, 2], beatDivisions: [2, 2] },
  { label: '3/4', beatsPerBar: 3, barDivisions: [3], beatDivisions: [2, 2] },
  { label: '6/8', beatsPerBar: 2, barDivisions: [2], beatDivisions: [3, 2] },
];

export function metricalRate(beat: number, meter: Meter): number {
  const parts = [...meter.barDivisions, ...meter.beatDivisions];
  let rate = 1 / meter.beatsPerBar;
  if (Math.abs(beat / meter.beatsPerBar - Math.round(beat / meter.beatsPerBar)) < 1e-7) return rate;
  for (const division of parts) {
    rate *= division;
    if (Math.abs(beat * rate - Math.round(beat * rate)) < 1e-7) return rate;
  }
  return rate;
}

export function annotateTrack(track: Track, meter: Meter): Track {
  return {
    ...track,
    notes: track.notes.map((note: ClipNote) => ({ ...note, rate: metricalRate(note.beat, meter) })),
  };
}

export function accentForRate(rate: number, track: Track): number {
  const maxRate = track.notes.reduce((m, n) => Math.max(m, n.rate), 1 / track.lengthBeats);
  return Math.max(0, Math.min(1, 1 - Math.log2(Math.max(rate, 1 / track.lengthBeats) * track.lengthBeats) / Math.max(1, Math.log2(maxRate * track.lengthBeats))));
}
