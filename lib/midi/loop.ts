import { advanceState, checkLoopLength, loopSpec, scheduleSegment } from '../staircase/core';
import { Preset, StairParams, TrackRole, isDrumRole } from '../staircase/types';
import { TimedNote, encodeMidi } from './smf';

/** General MIDI percussion notes and melodic channels used for the export. */
const DRUM_NOTE: Partial<Record<TrackRole, number>> = { kick: 36, snare: 38, hat: 42, perc: 76 };
const MELODY_CHANNEL: Partial<Record<TrackRole, number>> = { bass: 0, keys: 1, lead: 2 };
const DRUM_CHANNEL = 9;
const DRUM_SECONDS = 0.05;
const SEGMENT_SECONDS = 0.05;

/**
 * One seamless cycle of every layer as a MIDI clip at a fixed 120 BPM. Loop it in any
 * sequencer and it accelerates forever; velocities carry the layer fades.
 * Returns null when the tempo slope is zero, and throws when the cycle is too long to write out.
 */
export function loopMidi(preset: Preset, params: StairParams): Uint8Array | null {
  const spec = loopSpec(params);
  if (!spec) return null;
  checkLoopLength(spec.seconds);
  const tracks = preset.tracks.map((track) => ({
    ...track,
    gain: track.gain * (isDrumRole(track.role) ? params.levels.drums : params.levels.melody),
  }));

  const notes: TimedNote[] = [];
  let state = spec.state;
  while (state.time < spec.seconds - 1e-9) {
    const dt = Math.min(SEGMENT_SECONDS, spec.seconds - state.time);
    for (const event of scheduleSegment(state, dt, params.tempoSlope, spec.pitchSlope, params, tracks)) {
      const drum = isDrumRole(event.role);
      notes.push({
        time: event.time,
        dur: drum ? DRUM_SECONDS : event.durSec,
        midi: drum ? DRUM_NOTE[event.role]! : event.midi + Math.round(event.pitchOct * 12),
        vel: Math.min(1, Math.sqrt(event.gain)),
        channel: drum ? DRUM_CHANNEL : MELODY_CHANNEL[event.role]!,
      });
    }
    state = advanceState(state, dt, params.tempoSlope, spec.pitchSlope, params);
  }
  return encodeMidi(notes, spec.seconds);
}
