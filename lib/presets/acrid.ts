import { Preset } from '../staircase/types';
import { FOUR_FOUR, line, params, pattern } from './build';
import { ACRID_BASS, ACRID_PAD } from './data/acrid';

/** The pad line is written in octave pairs; the octave-stacked timbre makes the upper one redundant. */
const PAD_LOW = ACRID_PAD.filter(([, , midi]) => midi < 84);

/**
 * The bass steps in dotted eighths (three sixteenths) against a bar of four beats. The clicks
 * keep that count through the whole eight beats, ten steps of three and a short one of two,
 * so the two grids part and meet again every loop.
 */
const bass = line('bass', 'bass', ACRID_BASS, 16, FOUR_FOUR, { gain: 0.82 });
const pad = line('pad', 'keys', PAD_LOW, 16, FOUR_FOUR, { gain: 0.8 });

/** Eight beats of sixteenths: a half-time break on the four. */
const kick = pattern('kick', 'kick', 'X.....x...x.....X.....x.....x...', 4, FOUR_FOUR, { gain: 0.88 });
const snare = pattern('snare', 'snare', '........X..o..o.........X.o.....', 4, FOUR_FOUR, { gain: 1.5 });
const hat = pattern('hat', 'hat', 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.', 4, FOUR_FOUR, { gain: 0.8 });
const clicks = pattern('clicks', 'perc', 'o..o..o..o..o..o..o..o..o..o..o.', 4, FOUR_FOUR, { gain: 1.2 });

export const acrid: Preset = {
  id: 'acrid',
  name: 'Acrid Avid Jam Shred',
  blurb:
    'A bass line that steps in threes against a break in fours, with a slow pad line above, speeding up without end so the two grids keep sliding past each other.',
  meter: FOUR_FOUR,
  kit: 'aphex',
  timbre: 'reed',
  trimDb: 1,
  tracks: [bass, pad, kick, snare, hat, clicks],
  params: params({
    focusBpm: 81,
    tempoSlope: 1.8,
    levels: { drums: 1, melody: 1, pad: 0.35, sweep: 0.1, tape: 0, reverb: 0.25 },
  }),
  tonic: 53,
  padChord: [0, 3, 7],
  padAnchor: false,
  credit:
    'After Aphex Twin, “Acrid Avid Jam Shred” (…I Care Because You Do, 1995), notes from a MIDI transcription. 81 BPM as in the file; SongBPM lists 81 and AcousticBrainz 162, in F minor.',
};
