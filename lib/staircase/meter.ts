import { Meter, Track, isDrumRole } from './types';

const GRID_TOLERANCE_BEATS = 1e-3;

/** Positive modulo in [0, mod). */
export function positiveMod(value: number, mod: number): number {
  const rem = value % mod;
  return rem < 0 ? rem + mod : rem;
}

/** Grid periods in beats, from the bar down to the finest subdivision. */
export function metricPeriods(meter: Meter): number[] {
  const periods = [meter.beatsPerBar];
  let period = meter.beatsPerBar;
  for (const d of meter.divisions) {
    period /= d;
    periods.push(period);
  }
  return periods;
}

/**
 * Notes per beat of the coarsest metrical grid that contains this position.
 * A downbeat belongs to the bar grid, an offbeat sixteenth only to the sixteenth grid.
 * Positions on no grid count as twice as fast as the finest one, so ornaments are dropped first.
 */
export function metricRate(beat: number, meter: Meter): number {
  const periods = metricPeriods(meter);
  const pos = positiveMod(beat, meter.beatsPerBar);
  for (const period of periods) {
    const k = pos / period;
    if (Math.abs(k - Math.round(k)) * period < GRID_TOLERANCE_BEATS) {
      return 1 / period;
    }
  }
  return 2 / periods[periods.length - 1];
}

/** Distance in beats from `beat` to the nearest different onset of the looped track. */
function nearestOnsetGap(beat: number, onsets: number[], lengthBeats: number): number {
  let gap = lengthBeats;
  for (const other of onsets) {
    const d = Math.abs(other - beat);
    if (d < GRID_TOLERANCE_BEATS) continue;
    gap = Math.min(gap, d, lengthBeats - d);
  }
  return gap;
}

/**
 * Fills `note.rate` for every note of a track.
 * Drums thin by metrical position. A melody also keeps any note that is not crowded by its
 * neighbours, wherever it sits in the bar, so a displaced line survives as a line.
 */
export function annotateTrack(track: Track, meter: Meter): Track {
  const pitched = !isDrumRole(track.role);
  const onsets = pitched ? track.notes.map((n) => n.beat) : [];
  const notes = track.notes.map((note) => {
    let rate = metricRate(note.beat, meter);
    if (pitched) {
      rate = Math.min(rate, 1 / nearestOnsetGap(note.beat, onsets, track.lengthBeats));
    }
    return { ...note, rate };
  });
  return { ...track, notes };
}

/** Rate of the busiest stream in a track, in notes per beat. */
export function trackDensity(track: Track): number {
  let density = 0;
  for (const note of track.notes) density = Math.max(density, note.rate);
  return density;
}
