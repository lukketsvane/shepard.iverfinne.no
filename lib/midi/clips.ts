import { annotateTrack } from '../staircase/meter';
import { ClipNote, Meter, Track, TrackRole } from '../staircase/types';
import { FOUR_FOUR, SIX_EIGHT, THREE_FOUR } from '../presets/build';
import { ROLE_DEFAULTS } from '../presets/roles';
import { MidiNote, ParsedMidi } from './smf';

const PERCUSSION_CHANNEL = 9;
/** Parts whose typical note lies below this MIDI note (C3) are treated as bass. */
const BASS_BELOW = 48;

/**
 * The meter a file's time signature calls for: 3/4, 6/8 (whose beat is a dotted quarter, so
 * quarter notes are 2/3 of a beat) or else 4/4, which is also what a file without one is taken for.
 */
export function meterOf(signature: ParsedMidi['timeSignature']): { meter: Meter; beatsPerQuarter: number } {
  if (signature?.numerator === 3 && signature.denominator === 4) return { meter: THREE_FOUR, beatsPerQuarter: 1 };
  if (signature?.numerator === 6 && signature.denominator === 8) return { meter: SIX_EIGHT, beatsPerQuarter: 2 / 3 };
  return { meter: FOUR_FOUR, beatsPerQuarter: 1 };
}

/** General MIDI percussion note to drum role. */
function drumRole(midi: number): TrackRole {
  if (midi <= 36 || midi === 41 || midi === 43 || midi === 45) return 'kick';
  if (midi >= 37 && midi <= 40) return 'snare';
  if (midi === 42 || midi === 44 || midi === 46 || (midi >= 49 && midi <= 59)) return 'hat';
  return 'perc';
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Build one looping track from MIDI notes. The loop is rounded up to whole bars. */
export function makeTrack(
  id: string,
  role: TrackRole,
  notes: MidiNote[],
  lengthBeats: number,
  meter: Meter,
  overrides: Partial<Pick<Track, 'center' | 'maxHz' | 'gain'>> = {}
): Track {
  const bars = Math.max(1, Math.ceil(lengthBeats / meter.beatsPerBar - 1e-6));
  const loopBeats = bars * meter.beatsPerBar;
  const clipNotes: ClipNote[] = notes
    .filter((n) => n.beat < loopBeats)
    .map((n) => ({ beat: n.beat, dur: n.dur, midi: n.midi, vel: n.vel, rate: 0 }));
  return annotateTrack(
    { id, role, lengthBeats: loopBeats, notes: clipNotes, ...ROLE_DEFAULTS[role], ...overrides },
    meter
  );
}

/**
 * Turns an imported MIDI file into tracks, in the meter of its time signature: percussion-channel
 * notes become drum tracks by General MIDI note, every other channel a bass or keys track by register.
 */
export function tracksFromMidi(midi: ParsedMidi): { tracks: Track[]; meter: Meter } {
  const { meter, beatsPerQuarter } = meterOf(midi.timeSignature);
  const groups = new Map<string, { role: TrackRole; notes: MidiNote[] }>();
  const add = (key: string, role: TrackRole, note: MidiNote) => {
    const group = groups.get(key) ?? { role, notes: [] };
    group.notes.push(note);
    groups.set(key, group);
  };

  const byChannel = new Map<number, MidiNote[]>();
  for (const quarters of midi.notes) {
    const note = { ...quarters, beat: quarters.beat * beatsPerQuarter, dur: quarters.dur * beatsPerQuarter };
    if (note.channel === PERCUSSION_CHANNEL) {
      const role = drumRole(note.midi);
      add(role, role, note);
    } else {
      byChannel.set(note.channel, [...(byChannel.get(note.channel) ?? []), note]);
    }
  }
  for (const [channel, notes] of byChannel) {
    const role: TrackRole = median(notes.map((n) => n.midi)) < BASS_BELOW ? 'bass' : 'keys';
    for (const note of notes) add(`${role}-${channel}`, role, note);
  }

  const tracks = [...groups.entries()].map(([key, group]) =>
    makeTrack(`midi-${key}`, group.role, group.notes, midi.lengthBeats * beatsPerQuarter, meter)
  );
  return { tracks, meter };
}
