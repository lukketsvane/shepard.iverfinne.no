import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeMidi, parseMidi } from './smf';

const ASSETS = join(process.cwd(), 'public', 'assets', 'aistudio');
const load = (name: string) => parseMidi(new Uint8Array(readFileSync(join(ASSETS, name))))!;

test('icct_hedral.mid: the repeated F / F sharp / G sharp line, displaced by an eighth', () => {
  const midi = load('icct_hedral_1ef614f0.mid');
  assert.equal(midi.bpm, null);
  assert.equal(midi.notes.length, 74);
  assert.equal(midi.lengthBeats, 64.5);
  const firstPhrase = midi.notes.filter((n) => n.beat < 16).map((n) => [n.beat, n.midi, n.dur]);
  assert.deepEqual(firstPhrase.slice(0, 10), [
    [0, 53, 1], [1, 53, 1], [2, 53, 1], [3, 53, 1], [4, 53, 0.5],
    [4.5, 54, 1], [5.5, 54, 1], [6.5, 54, 1], [7.5, 54, 5], [12.5, 56, 1],
  ]);
  assert.deepEqual([...new Set(midi.notes.map((n) => n.midi))].sort((a, b) => a - b), [53, 54, 56, 65, 66, 68, 69]);
});

test('alberto.mid: 64 beats starting on the B flat figure', () => {
  const midi = load('alberto_a8526f5e.mid');
  assert.equal(midi.notes.length, 68);
  assert.equal(midi.lengthBeats, 64);
  assert.deepEqual(
    midi.notes.slice(0, 8).map((n) => [n.beat, n.midi]),
    [[0, 46], [1, 58], [1.75, 51], [3, 63], [4, 50], [5, 62], [6.5, 62], [7.25, 58]]
  );
});

test('aajs.mid: 81 BPM, bass on channel 0 and pad octaves on channel 1', () => {
  const midi = load('aajs_e2ee4640.mid');
  assert.equal(Math.round(midi.bpm!), 81);
  assert.equal(midi.lengthBeats, 16);
  assert.equal(midi.notes.filter((n) => n.channel === 0).length, 12);
  assert.equal(midi.notes.filter((n) => n.channel === 1).length, 6);
  assert.ok(midi.notes.every((n) => n.vel > 0 && n.vel <= 1 && n.dur > 0));
});

test('parseMidi rejects data that is not a MIDI file', () => {
  assert.equal(parseMidi(new Uint8Array([1, 2, 3])), null);
  assert.equal(parseMidi(new Uint8Array(64)), null);
});

test('encodeMidi round-trips timing, pitch and velocity through parseMidi', () => {
  const notes = [
    { time: 0, dur: 0.25, midi: 36, vel: 1, channel: 9 },
    { time: 0.3333, dur: 0.1, midi: 60, vel: 0.5, channel: 0 },
    { time: 1.9, dur: 5, midi: 72, vel: 0.25, channel: 1 }, // runs past the end and is cut there
    { time: 0.3333, dur: 0.05, midi: 60, vel: 0.5, channel: 0 }, // same pitch struck twice at once
  ];
  const parsed = parseMidi(encodeMidi(notes, 2))!;
  assert.equal(parsed.bpm, 120);
  assert.equal(parsed.notes.length, 4);
  // 120 BPM: 2 beats per second
  assert.deepEqual(parsed.notes.map((n) => n.midi), [36, 60, 60, 72]);
  assert.ok(Math.abs(parsed.notes[1].beat - 0.6666) < 2e-3);
  assert.ok(Math.abs(parsed.notes[3].beat - 3.8) < 2e-3);
  assert.ok(Math.abs(parsed.lengthBeats - 4) < 1e-9);
  assert.ok(Math.abs(parsed.notes[3].vel - 0.25) < 0.01);
  assert.equal(parsed.notes[0].channel, 9);
});

/** A file with one track made of `events`, behind a valid header (format 0, 96 ticks per quarter). */
function fileWith(events: number[]): Uint8Array {
  const length = events.length;
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, length, ...events,
  ]);
}

const NOTE_ON_OFF = [0, 0x90, 60, 100, 96, 0x80, 60, 0];

test('a variable-length quantity of five bytes ends the track instead of looping for ever', () => {
  // F0 with a length that overflowed to a negative number before: the cursor used to run backwards
  const parsed = parseMidi(fileWith([...NOTE_ON_OFF, 0, 0xf0, 0x88, 0x80, 0x80, 0x80, 0x00, 1, 2, 3]));
  assert.equal(parsed?.notes.length, 1);
  assert.equal(parseMidi(fileWith([0, 0xf0, 0x88, 0x80, 0x80, 0x80, 0x00, 1, 2, 3])), null);
});

test('an event whose length runs past the track keeps the notes before it', () => {
  const parsed = parseMidi(fileWith([...NOTE_ON_OFF, 0, 0xff, 0x01, 0x7f, 65, 66]));
  assert.equal(parsed?.notes.length, 1);
  assert.equal(parseMidi(fileWith([0, 0x90, 60])), null);
});

test('corrupted copies of a valid file are read or refused, never endless', () => {
  const original = encodeMidi(
    Array.from({ length: 24 }, (_, i) => ({ time: i / 8, dur: 0.1, midi: 40 + i, vel: 0.7, channel: i % 2 })),
    3
  );
  let seed = 1;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let run = 0; run < 2000; run++) {
    const copy = original.slice(0, run % 5 === 0 ? 14 + Math.floor(random() * (original.length - 14)) : original.length);
    for (let hit = 0; hit < 1 + Math.floor(random() * 4); hit++) {
      copy[14 + Math.floor(random() * (copy.length - 14))] = random() < 0.5 ? 0x80 | Math.floor(random() * 256) : Math.floor(random() * 256);
    }
    parseMidi(copy);
  }
});

test('the first time signature is read, and a file without one has none', () => {
  const withSignature = [0, 0xff, 0x58, 0x04, 6, 3, 24, 8, ...NOTE_ON_OFF];
  assert.deepEqual(parseMidi(fileWith(withSignature))?.timeSignature, { numerator: 6, denominator: 8 });
  assert.equal(parseMidi(fileWith(NOTE_ON_OFF))?.timeSignature, null);
});
