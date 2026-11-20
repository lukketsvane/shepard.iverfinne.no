import { Preset } from '../staircase/types';
import { SIX_EIGHT, THREE_OVER_TWO, line, params, pattern } from './build';

/**
 * Two bars of 6/8 (a beat is a dotted quarter, a step a sixteenth, twelve steps to the bar).
 * The drum sits on the two-feel, the bronze on the three-feel, so the bar is a hemiola:
 * the two families meet only on the downbeat. The last bronze quarter of the second bar and
 * a few eighths are left out, the "dropped subdivisions" that make the loop limp forward.
 */
const skin = pattern('skin', 'kick', 'X.....x...x.X.....x...x.', 6, SIX_EIGHT, { gain: 0.66 });
const bronze = pattern('bronze', 'snare', 'X...x...x...x...x.......', 6, THREE_OVER_TWO, { gain: 1.2 });
/** The clicks sit in slower layers than the drums, so their sixteenth ghosts stay below the flutter limit. */
const frame = pattern('frame', 'hat', 'X.x.xoX.x.xoX...xoX.x.xo', 6, SIX_EIGHT, {
  gain: 0.85,
  center: -0.4,
  maxHz: 11,
});

/** A low C, then a D flat in the second bar: a minor second against the drone, every four beats. */
const ground = line('ground', 'bass', [[0, 1.5, 36], [2, 1.5, 37]], 4, SIX_EIGHT, { gain: 1.3 });

/** Three notes to the bar on the three-feel, C C D flat and C E flat D flat, uneasy and never resolving. */
const tick = line(
  'tick',
  'keys',
  [
    [0, 0.4, 72],
    [2 / 3, 0.4, 72],
    [4 / 3, 0.4, 73],
    [2, 0.4, 72],
    [2 + 2 / 3, 0.4, 75],
    [2 + 4 / 3, 0.4, 73],
  ],
  4,
  THREE_OVER_TWO,
  { gain: 1.3 }
);

export const troy: Preset = {
  id: 'troy',
  name: 'Troy',
  blurb:
    'War drums in two, bronze in three and quick clicks speed up without end over a held drone, while a second pitch climbs above it.',
  meter: SIX_EIGHT,
  kit: 'troy',
  timbre: 'glass',
  trimDb: -0.3,
  tracks: [skin, bronze, frame, ground, tick],
  params: params({
    focusBpm: 115,
    tempoSlope: 2.03,
    pitchSlope: 0.65,
    pitchLink: false,
    flutterHz: 12,
    levels: { drums: 1, melody: 0.6, pad: 0.45, sweep: 0.2, tape: 0, reverb: 0.3 },
  }),
  tonic: 72,
  padChord: [0, 7],
  padAnchor: true,
  credit:
    'After Ludwig Göransson, “Troy” (The Odyssey, 2026), as analysed by Signals Music Studio: a modified Risset rhythm with dropped subdivisions, a hemiola, and a pitch riser over a drone. Tempo, meter and drone as measured from the recording: 6/8, doubling every 29.5 s, dotted quarter near 115 BPM, drone on C.',
};
