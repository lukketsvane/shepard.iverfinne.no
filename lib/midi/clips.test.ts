import test from 'node:test';
import assert from 'node:assert/strict';
import { FOUR_FOUR, SIX_EIGHT, THREE_FOUR } from '../presets/build';
import { meterOf, tracksFromMidi } from './clips';
import { MidiNote, ParsedMidi } from './smf';

const hat = (beat: number): MidiNote => ({ beat, dur: 0.25, midi: 42, vel: 0.8, channel: 9 });

function file(notes: MidiNote[], timeSignature: ParsedMidi['timeSignature']): ParsedMidi {
  return { bpm: null, timeSignature, notes, lengthBeats: 4 };
}

test('the meter follows the time signature and defaults to 4/4', () => {
  assert.equal(meterOf(null).meter, FOUR_FOUR);
  assert.equal(meterOf({ numerator: 4, denominator: 4 }).meter, FOUR_FOUR);
  assert.equal(meterOf({ numerator: 7, denominator: 8 }).meter, FOUR_FOUR);
  assert.equal(meterOf({ numerator: 3, denominator: 4 }).meter, THREE_FOUR);
  assert.equal(meterOf({ numerator: 6, denominator: 8 }).meter, SIX_EIGHT);
});

test('hats on every eighth of a 4/4 file are an eighth-note stream, as they are in the music', () => {
  const eighths = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map(hat);
  const { tracks, meter } = tracksFromMidi(file(eighths, null));
  assert.equal(meter, FOUR_FOUR);
  assert.deepEqual(tracks[0].notes.map((n) => n.rate), [0.25, 2, 1, 2, 0.5, 2, 1, 2]);
});

test('a 6/8 file is laid on dotted-quarter beats, so its bar is two beats long', () => {
  // six eighths = three quarters = two dotted quarters; the hats sit on every eighth
  const { tracks, meter } = tracksFromMidi({ ...file([0, 0.5, 1, 1.5, 2, 2.5].map(hat), { numerator: 6, denominator: 8 }), lengthBeats: 3 });
  assert.equal(meter, SIX_EIGHT);
  assert.equal(tracks[0].lengthBeats, 2);
  assert.deepEqual(tracks[0].notes.map((n) => Math.round(n.beat * 6) / 6), [0, 1 / 3, 2 / 3, 1, 4 / 3, 5 / 3]);
});
