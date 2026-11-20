import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS } from '../presets/index';
import { loopMidi } from './loop';
import { parseMidi } from './smf';

const [troy] = PRESETS;
const withSlope = (tempoSlope: number) => ({ ...troy.params, tempoSlope, pitchSlope: 0, pitchLink: false });

test('a steady tempo has no loop to save', () => {
  assert.equal(loopMidi(troy, withSlope(0)), null);
});

test('one cycle is written as a clip of exactly its length', () => {
  const parsed = parseMidi(loopMidi(troy, withSlope(2))!)!;
  assert.ok(parsed.notes.length > 100);
  assert.ok(Math.abs(parsed.lengthBeats - 60) < 1.5);
});

test('a cycle longer than the WAV limit is refused with the same message instead of writing a file of minutes', () => {
  assert.throws(() => loopMidi(troy, withSlope(0.05)), /One cycle would be 1200 s long\. Use a steeper tempo slope\./);
});
