import { Preset } from '../staircase/types';
import { FOUR_FOUR, excerpt, line, params, pattern } from './build';
import { ICCT_HEDRAL } from './data/icct-hedral';

/**
 * The 16-beat phrase of the transcription: four F quarters, then F sharp and G sharp
 * one eighth late, so the line seems to slip off the bar. The second half of the piece
 * (beats 32-48 of the file) puts a pulse of A eighths over the held F sharp.
 */
const bass = line('organ', 'bass', excerpt(ICCT_HEDRAL, 0, 16), 16, FOUR_FOUR, { gain: 1.1 });
const pulse = line(
  'pulse',
  'keys',
  excerpt(ICCT_HEDRAL, 32, 48).filter(([, , midi]) => midi >= 60),
  16,
  FOUR_FOUR,
  { gain: 0.95 }
);

/**
 * Eighths (two to the beat) over four bars: a stomp on every beat, so every beat of a slower
 * layer lands on one of a faster layer, and clangs on every displaced onset of the bass.
 */
const stomp = pattern('stomp', 'kick', 'X.x.x.x.X.x.x.x.X.x.x.x.X.x.x.x.', 2, FOUR_FOUR, { gain: 0.85 });
const clang = pattern('clang', 'perc', '.........x.x.x.x.........x.x.x.x', 2, FOUR_FOUR, { gain: 1.3 });
const plate = pattern('plate', 'snare', '..x...x...x...x...x...x...x...x.', 2, FOUR_FOUR, { gain: 1.9 });

export const icctHedral: Preset = {
  id: 'icct-hedral',
  name: 'Icct Hedral',
  blurb:
    'A heavy organ line on F, F sharp and G sharp slips half a beat off the bar over a metal stomp, and the whole machine speeds up without end.',
  meter: FOUR_FOUR,
  kit: 'aphex',
  timbre: 'organ',
  trimDb: -0.5,
  tracks: [bass, pulse, stomp, clang, plate],
  params: params({
    focusBpm: 141,
    tempoSlope: 1.5,
    levels: { drums: 0.9, melody: 1, pad: 0.4, sweep: 0.1, tape: 0, reverb: 0.3 },
  }),
  tonic: 54,
  padChord: [0, 3, 7],
  padAnchor: false,
  credit:
    'After Aphex Twin, “Icct Hedral” (…I Care Because You Do, 1995), notes from a MIDI transcription. About 141 BPM, from an automatic analysis of the Philip Glass orchestration (AcousticBrainz), which also guesses F sharp minor.',
};
