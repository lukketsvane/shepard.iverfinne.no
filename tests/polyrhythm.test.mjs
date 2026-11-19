import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POLY_PULSES,
  EXACT_PPQ,
  EXACT_TICKS_PER_BAR,
  polyrhythmEventsBetween,
  buildExact5711Midi,
} from '../lib/polyrhythm-5711.ts';

test('5:7:11 gives exact event counts and onset fractions in each 4/4 bar', () => {
  const bpm = 142;
  const barSeconds = 240 / bpm;
  const events = polyrhythmEventsBetween(0, barSeconds * 4, bpm);
  assert.equal(events.length, (5 + 7 + 11) * 4);
  for (const pulse of POLY_PULSES) {
    const hits = events.filter((event) => event.pulse === pulse);
    assert.equal(hits.length, pulse * 4);
    for (let i = 0; i < hits.length; i++) {
      const expected = (Math.floor(i / pulse) + (i % pulse) / pulse) * barSeconds;
      assert.ok(Math.abs(hits[i].second - expected) < 1e-10);
    }
  }
  const halfway = 1.75 * barSeconds;
  const split = [
    ...polyrhythmEventsBetween(0, halfway, bpm),
    ...polyrhythmEventsBetween(halfway, 4 * barSeconds, bpm),
  ].sort((a, b) => a.second - b.second || a.pulse - b.pulse);
  assert.deepEqual(split, events);
});

test('MIDI tracks use whole integer ticks for all 5:7:11 hits', () => {
  const bars = 4;
  const data = buildExact5711Midi(142, bars);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const name = (start, count) => String.fromCharCode(...data.slice(start, start + count));
  assert.equal(name(0, 4), 'MThd');
  assert.equal(view.getUint16(8), 1);
  assert.equal(view.getUint16(10), 4);
  assert.equal(view.getUint16(12), EXACT_PPQ);
  let cursor = 14;
  for (let track = 0; track < 4; track++) {
    assert.equal(name(cursor, 4), 'MTrk');
    const end = cursor + 8 + view.getUint32(cursor + 4);
    let position = cursor + 8;
    let absoluteTick = 0;
    const onsets = [];
    while (position < end) {
      let delta = 0;
      let octet;
      do {
        octet = data[position++];
        delta = (delta << 7) | (octet & 127);
      } while (octet & 128);
      absoluteTick += delta;
      const status = data[position++];
      if (status === 255) {
        const subtype = data[position++];
        const len = data[position++];
        position += len;
        if (subtype === 47) break;
      } else {
        const note = data[position++];
        const velocity = data[position++];
        if (status === 0x99 && velocity > 0) onsets.push({ tick: absoluteTick, note });
      }
    }
    if (track > 0) {
      const pulse = POLY_PULSES[track - 1];
      assert.equal(onsets.length, pulse * bars);
      const interval = EXACT_TICKS_PER_BAR / pulse;
      assert.ok(Number.isInteger(interval));
      for (let i = 0; i < onsets.length; i++) {
        const tick = Math.floor(i / pulse) * EXACT_TICKS_PER_BAR + (i % pulse) * interval;
        assert.equal(onsets[i].tick, tick);
      }
    }
    cursor = end;
  }
  assert.equal(cursor, data.byteLength);
});
