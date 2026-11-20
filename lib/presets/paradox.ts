import { Preset } from '../staircase/types';
import { FOUR_FOUR, line, params, pattern } from './build';

/** D minor, one bar: a falling arpeggio over a bass that walks D D F G, so the sinking pitch has something to show itself on. */
const arpeggio = line(
  'arpeggio',
  'keys',
  [
    [0, 0.5, 62],
    [0.5, 0.5, 65],
    [1, 0.5, 69],
    [1.5, 0.5, 72],
    [2, 0.5, 69],
    [2.5, 0.5, 65],
    [3, 0.5, 62],
    [3.5, 0.5, 57],
  ],
  4,
  FOUR_FOUR,
  { gain: 0.88 }
);
const bass = line(
  'bass',
  'bass',
  [[0, 1, 38], [1.5, 0.5, 38], [2.5, 1, 41], [3.5, 0.5, 43]],
  4,
  FOUR_FOUR,
  { gain: 1.2 }
);

/** One bar of sixteenths. Every onset lands on a beat of a layer twice as fast. */
const kick = pattern('kick', 'kick', 'X.......X.o.x...', 4, FOUR_FOUR, { gain: 0.86 });
const snare = pattern('snare', 'snare', '....X.......X...', 4, FOUR_FOUR, { gain: 2.1 });
const hat = pattern('hat', 'hat', 'X.x.x.x.X.x.x.xo', 4, FOUR_FOUR, { gain: 1 });

export const paradox: Preset = {
  id: 'paradox',
  name: 'Paradox',
  blurb:
    'The rhythm speeds up without end while the pitch falls without end, at the same rate, and the tape layer turns the beats into a tone that climbs against the falling notes.',
  meter: FOUR_FOUR,
  kit: 'aphex',
  timbre: 'glass',
  trimDb: -2.1,
  tracks: [arpeggio, bass, kick, snare, hat],
  params: params({
    focusBpm: 120,
    tempoSlope: 1.5,
    pitchSlope: -1.5,
    pitchLink: false,
    levels: { drums: 0.9, melody: 0.9, pad: 0.6, sweep: 0.15, tape: 0.25, reverb: 0.3 },
  }),
  tonic: 50,
  padChord: [0, 7],
  padAnchor: false,
  credit: 'A showcase of the two staircases run in opposite directions: Risset’s rhythm up, Shepard’s tone down.',
};
