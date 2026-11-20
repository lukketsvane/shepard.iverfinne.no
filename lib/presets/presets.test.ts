import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceState, createState, loopSpec, scheduleSegment } from '../staircase/core';
import { isDrumRole, Preset, StairEvent } from '../staircase/types';
import { audibleFraction } from '../sound/graph';
import { loudness } from '../sound/voices';
import { PRESETS } from './index';

const KITS = ['troy', 'aphex', 'hand', 'pure'];
const TIMBRES = ['organ', 'glass', 'reed', 'pluck'];
const MAX_CYCLE_SECONDS = 120;
const SEGMENT = 0.5;
/** Events quieter than this (about -26 dB of a full hit) are texture, not notes. */
const AUDIBLE_GAIN = 0.05;

/** Loop length in beats of every track, as written: the polyrhythms are part of the music. */
const LOOP_BEATS: Record<string, Record<string, number>> = {
  troy: { skin: 4, bronze: 4, frame: 4, ground: 4, tick: 4 },
  'icct-hedral': { organ: 16, pulse: 16, stomp: 16, clang: 16, plate: 16 },
  alberto: { bass: 32, figure: 32, tune: 32, kick: 8, rim: 8, click: 8 },
  acrid: { bass: 16, pad: 16, kick: 8, snare: 8, hat: 8, clicks: 8 },
  'di-meola': { lead: 8, ostinato: 7 / 4, bass: 4, cajon: 4, palmas: 4, congas: 4 },
  fosse: { words: 71 / 4, syllables: 71 / 4, ground: 4 },
  paradox: { arpeggio: 4, bass: 4, kick: 4, snare: 4, hat: 4 },
  pulse: { pulse: 4, tick: 4 },
};

function pitchSlopeOf(preset: Preset): number {
  return preset.params.pitchLink ? preset.params.tempoSlope : preset.params.pitchSlope;
}

/** What the engine would schedule over the first `seconds` of playback, with the Drums and Melody levels folded into the tracks as the engine does. */
function schedule(preset: Preset, seconds: number, foldLevels = false): StairEvent[] {
  const { params } = preset;
  const tracks = foldLevels
    ? preset.tracks.map((t) => ({ ...t, gain: t.gain * (isDrumRole(t.role) ? params.levels.drums : params.levels.melody) }))
    : preset.tracks;
  const events: StairEvent[] = [];
  let state = createState();
  for (let t = 0; t < seconds; t += SEGMENT) {
    events.push(...scheduleSegment(state, SEGMENT, params.tempoSlope, pitchSlopeOf(preset), params, tracks));
    state = advanceState(state, SEGMENT, params.tempoSlope, pitchSlopeOf(preset), params);
  }
  return events;
}

test('the presets come in the intended order, with unique ids', () => {
  assert.deepEqual(
    PRESETS.map((p) => p.id),
    ['troy', 'icct-hedral', 'alberto', 'acrid', 'di-meola', 'fosse', 'paradox', 'pulse']
  );
  assert.equal(new Set(PRESETS.map((p) => p.name)).size, PRESETS.length);
});

test('only the fosse preset plays a tape file, and it turns the tape up', () => {
  for (const preset of PRESETS) {
    if (preset.id === 'fosse') {
      assert.equal(preset.tapeUrl, '/audio/fosse-ground.mp3');
      assert.ok(preset.params.levels.tape > 0.4);
    } else {
      assert.equal(preset.tapeUrl, undefined, preset.id);
    }
  }
});

for (const preset of PRESETS) {
  const label = preset.id;

  test(`${label}: text fields are filled in`, () => {
    assert.ok(KITS.includes(preset.kit));
    assert.ok(TIMBRES.includes(preset.timbre));
    assert.match(preset.blurb, /^[A-Z].*\.$/);
    assert.doesNotMatch(preset.blurb, /\. [A-Z]/, 'blurb is one sentence');
    assert.ok(preset.credit && preset.credit.length > 20);
    assert.ok(preset.padChord.length > 0 && preset.padChord.every(Number.isFinite));
    assert.ok(Number.isFinite(preset.tonic));
  });

  test(`${label}: tracks have unique ids and the loops written for them`, () => {
    const ids = preset.tracks.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(
      Object.fromEntries(preset.tracks.map((t) => [t.id, t.lengthBeats])),
      LOOP_BEATS[preset.id]
    );
  });

  test(`${label}: notes are annotated and lie inside their loop`, () => {
    for (const track of preset.tracks) {
      assert.ok(track.notes.length > 0, track.id);
      assert.ok(track.gain > 0 && track.center >= -2 && track.center <= 2 && track.maxHz > 0, track.id);
      for (const note of track.notes) {
        assert.ok(note.rate > 0, `${track.id} rate`);
        assert.ok(note.beat >= 0 && note.beat < track.lengthBeats, `${track.id} beat ${note.beat}`);
        assert.ok(note.dur > 0 && note.vel > 0 && note.vel <= 1, track.id);
        if (isDrumRole(track.role)) assert.equal(note.midi, 0, track.id);
        else assert.ok(note.midi >= 24 && note.midi <= 100, `${track.id} midi ${note.midi}`);
      }
    }
  });

  test(`${label}: params are sane and the loop is short enough to render`, () => {
    const { params } = preset;
    assert.ok(params.focusBpm >= 60 && params.focusBpm <= 200);
    assert.ok(Math.abs(params.tempoSlope) >= 0.5 && Math.abs(params.tempoSlope) <= 4);
    assert.ok(Math.abs(params.pitchSlope) <= 4);
    assert.ok(params.pitchStep >= 0 && params.pitchStep <= 2);
    assert.ok([2, 1.5, 3].includes(params.ratio));
    assert.ok(params.spread >= 0.4 && params.spread <= 1.2);
    assert.ok(params.flutterHz >= 8 && params.flutterHz <= 16);
    assert.ok(params.master > 0 && params.master <= 1);
    for (const [name, level] of Object.entries(params.levels)) {
      assert.ok(level >= 0 && level <= 1, `${name} ${level}`);
    }
    assert.equal(params.solo, false);
    const spec = loopSpec(params);
    assert.ok(spec !== null);
    assert.ok(spec.seconds > 5 && spec.seconds < MAX_CYCLE_SECONDS, `cycle ${spec.seconds} s`);
  });

  test(`${label}: thirty seconds of playback make finite, flutter-free events`, () => {
    const events = schedule(preset, 30);
    assert.ok(events.length > 100, `${events.length} events`);
    const ids = new Set(preset.tracks.map((t) => t.id));
    for (const e of events) {
      assert.ok(ids.has(e.trackId));
      assert.ok(e.streamHz <= preset.params.flutterHz * Math.SQRT2, `${e.trackId} at ${e.streamHz} Hz`);
      assert.ok(Number.isFinite(e.time) && e.time >= 0 && e.time < 30 + SEGMENT);
      assert.ok(Number.isFinite(e.midi) && Number.isFinite(e.pitchOct) && Number.isFinite(e.pitchGlide));
      assert.ok(e.pitchOct >= 0 && e.pitchOct < 1);
      assert.ok(e.gain > 0 && e.gain <= 1.5 && e.durSec > 0);
    }
    for (const track of preset.tracks) {
      assert.ok(events.some((e) => e.trackId === track.id), `${track.id} is never heard`);
    }
  });

  test(`${label}: no track is masked, at least half of the events of every track are loud enough to be played`, () => {
    const events = schedule(preset, 30, true);
    for (const track of preset.tracks) {
      const mine = events.filter((e) => e.trackId === track.id);
      const played = mine.filter((e) => audibleFraction(loudness(e.gain)) > 0);
      assert.ok(played.length >= 0.5 * mine.length, `${track.id}: ${played.length} of ${mine.length} events are played`);
    }
  });

  test(`${label}: audible events per second stay musical, not a wall of notes`, () => {
    const audible = schedule(preset, 30).filter((e) => e.gain >= AUDIBLE_GAIN);
    const perSecond = audible.length / 30;
    assert.ok(perSecond >= 8 && perSecond <= 60, `${perSecond.toFixed(1)} events/s`);
  });
}

test('troy: 6/8, doubling every half minute, a held drone near C under a separate riser', () => {
  const troy = PRESETS[0];
  assert.equal(troy.meter.label, '6/8');
  assert.equal(troy.kit, 'troy');
  assert.ok(Math.abs(60 / troy.params.tempoSlope - 29.5) < 0.5);
  assert.ok(troy.params.focusBpm > 105 && troy.params.focusBpm < 125);
  assert.equal(troy.padAnchor, true);
  assert.equal(troy.params.pitchLink, false);
  assert.ok(troy.params.pitchSlope >= 0.5 && troy.params.pitchSlope <= 0.8);
  assert.equal(troy.tonic % 12, 0);
  // the drum counts two to the bar and the bronze three: the bar is a hemiola
  const bronze = troy.tracks.find((t) => t.id === 'bronze')!;
  const skin = troy.tracks.find((t) => t.id === 'skin')!;
  assert.deepEqual(skin.notes.slice(0, 2).map((n) => n.beat), [0, 1]);
  assert.deepEqual(bronze.notes.slice(0, 3).map((n) => Math.round(n.beat * 3)), [0, 2, 4]);
});

test('fosse: the longest word fits the words row of a 320 px wide phone at full size', () => {
  const fosse = PRESETS.find((p) => p.id === 'fosse')!;
  const longest = Math.max(...fosse.words!.list.map((word) => word.length));
  // bold 36 px type measures about 0.62 em a letter (Rambunctuous: 266 px in the browser); the row is 288 px
  assert.ok(longest * 36 * 0.62 <= 320 - 2 * 16, `${longest} letters`);
});

test('di-meola: a 3:2 ladder in quarter tones against a loop that does not fit the bar', () => {
  const meola = PRESETS.find((p) => p.id === 'di-meola')!;
  assert.equal(meola.params.ratio, 1.5);
  assert.equal(meola.params.pitchStep, 0.5);
  assert.ok(meola.params.pitchSlope > 0 && meola.params.pitchSlope <= 1);
  const ostinato = meola.tracks.find((t) => t.id === 'ostinato')!;
  assert.equal(ostinato.lengthBeats * 4, 7);
  const microtones = meola.tracks.flatMap((t) => t.notes).filter((n) => n.midi % 1 !== 0);
  assert.ok(microtones.length >= 8);
  assert.ok(microtones.every((n) => Math.abs((n.midi % 1) - 0.5) < 1e-9), 'inflections are quarter tones');
});

test('fosse: the poem is 32 words of 71 syllables, one note and one tick each', () => {
  const fosse = PRESETS.find((p) => p.id === 'fosse')!;
  assert.ok(fosse.words);
  const words = fosse.tracks.find((t) => t.id === fosse.words!.trackId)!;
  assert.equal(words.role, 'keys');
  assert.equal(
    fosse.words.list.join(' '),
    'MudCrab elastic Appropriate Chirp Somber Rise Twigs Frugal Rambunctuous Rudder Ladle Timid Holler ' +
      'Ittenuate Enamel Brittle Tactile Lutomatic Leeks Tittelate Grievance Scion Transgress Haul Edict ' +
      'Frizzy Subverted Unadorned Body Language Cedar Shrub'
  );
  assert.equal(fosse.words.list.length, words.notes.length);
  // every word lasts as many sixteenths as it has syllables
  assert.deepEqual(
    words.notes.map((n) => n.dur * 4),
    [2, 3, 4, 1, 2, 1, 1, 2, 4, 2, 2, 2, 2, 4, 3, 2, 2, 4, 1, 3, 2, 2, 2, 1, 2, 2, 3, 3, 2, 2, 2, 1]
  );
  for (let i = 1; i < words.notes.length; i++) {
    assert.ok(words.notes[i].beat > words.notes[i - 1].beat, 'notes are in poem order');
  }
  const syllables = fosse.tracks.find((t) => t.id === 'syllables')!;
  assert.equal(syllables.notes.length, 71);
  assert.equal(syllables.lengthBeats * 4, 71);
  assert.equal(words.lengthBeats * 4, 71);
  // each word's note starts on its first syllable and lasts as long as the word
  const accented = syllables.notes.filter((n) => n.vel === 1).map((n) => n.beat);
  assert.deepEqual(accented, words.notes.map((n) => n.beat));
  const last = words.notes[words.notes.length - 1];
  assert.equal((last.beat + last.dur) * 4, 71);
  // the poem ends on the note it starts on
  assert.equal(words.notes[0].midi, last.midi);
  // a decelerando that drags the pitch down with it
  assert.ok(fosse.params.tempoSlope < 0);
  assert.equal(fosse.params.pitchLink, true);
  assert.ok(fosse.params.focusBpm >= 76 && fosse.params.focusBpm <= 88);
  assert.equal(fosse.text!.split('\n\n').length, 4);
});

test('paradox: pitch falls exactly as fast as the tempo rises', () => {
  const paradox = PRESETS.find((p) => p.id === 'paradox')!;
  assert.equal(paradox.params.pitchLink, false);
  assert.equal(paradox.params.pitchSlope, -paradox.params.tempoSlope);
  // the sweep and the tape rise with the tempo, so they stay under the sinking drone instead of fighting it
  const { pad, sweep, tape } = paradox.params.levels;
  assert.ok(pad >= 0.5 && sweep > 0 && tape > 0);
  assert.ok(pad >= 2 * Math.max(sweep, tape));
});
