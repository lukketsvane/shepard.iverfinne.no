import { annotateTrack } from '../staircase/meter';
import { ClipNote, Meter, StairParams, Track, TrackRole } from '../staircase/types';
import { ROLE_DEFAULTS } from './roles';

export const FOUR_FOUR: Meter = { label: '4/4', beatsPerBar: 4, divisions: [2, 2, 2, 2] };
export const THREE_FOUR: Meter = { label: '3/4', beatsPerBar: 3, divisions: [3, 2, 2] };
/** Two dotted-quarter beats per bar. */
export const SIX_EIGHT: Meter = { label: '6/8', beatsPerBar: 2, divisions: [2, 3, 2] };
/** The 6/8 bar felt in three: the hemiola. */
export const THREE_OVER_TWO: Meter = { label: '3 over 2', beatsPerBar: 2, divisions: [3, 2, 2] };

const STEP_VELOCITY: Record<string, number> = { X: 1, x: 0.8, o: 0.5 };
const NOTE_VELOCITY = 0.8;

/** A written note: onset and duration in beats, MIDI note (fractional for microtones), optional velocity. */
export type Note = [beat: number, dur: number, midi: number, vel?: number];

/** Notes with `from <= beat < to`, moved so that `from` becomes beat 0. */
export function excerpt(notes: Note[], from: number, to: number): Note[] {
  return notes
    .filter(([beat]) => beat >= from && beat < to)
    .map(([beat, dur, midi, vel]) => [beat - from, dur, midi, vel]);
}

/** A loop of any length in beats, from written notes. Use `pattern` for drums written as steps. */
export function line(
  id: string,
  role: TrackRole,
  notes: Note[],
  lengthBeats: number,
  meter: Meter,
  overrides: Partial<Pick<Track, 'center' | 'maxHz' | 'gain'>> = {}
): Track {
  const clipNotes: ClipNote[] = notes
    .map(([beat, dur, midi, vel = NOTE_VELOCITY]) => ({ beat, dur, midi, vel, rate: 0 }))
    .sort((a, b) => a.beat - b.beat);
  return annotateTrack(
    { id, role, lengthBeats, notes: clipNotes, ...ROLE_DEFAULTS[role], ...overrides },
    meter
  );
}

/**
 * A drum track written as steps: `X` accent, `x` hit, `o` ghost note, anything else a rest.
 * `stepsPerBeat` is 4 for sixteenths in simple time, 3 or 6 in compound time.
 */
export function pattern(
  id: string,
  role: TrackRole,
  steps: string,
  stepsPerBeat: number,
  meter: Meter,
  overrides: Partial<Pick<Track, 'center' | 'maxHz' | 'gain'>> = {}
): Track {
  const notes: ClipNote[] = [];
  [...steps].forEach((step, i) => {
    const vel = STEP_VELOCITY[step];
    if (vel !== undefined) {
      notes.push({ beat: i / stepsPerBeat, dur: 1 / stepsPerBeat, midi: 0, vel, rate: 0 });
    }
  });
  return annotateTrack(
    { id, role, lengthBeats: steps.length / stepsPerBeat, notes, ...ROLE_DEFAULTS[role], ...overrides },
    meter
  );
}

export function params(patch: Partial<Omit<StairParams, 'levels'>> & { levels?: Partial<StairParams['levels']> }): StairParams {
  const base: StairParams = {
    focusBpm: 120,
    tempoSlope: 2,
    pitchSlope: 0,
    pitchLink: false,
    pitchStep: 0,
    ratio: 2,
    spread: 0.85,
    flutterHz: 12,
    levels: { drums: 1, melody: 1, pad: 0, sweep: 0, tape: 0, reverb: 0.2 },
    master: 0.8,
    solo: false,
  };
  return { ...base, ...patch, levels: { ...base.levels, ...patch.levels } };
}
