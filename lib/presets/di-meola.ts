import { Preset } from '../staircase/types';
import { FOUR_FOUR, Note, line, params, pattern } from './build';

// E Phrygian dominant: E F G sharp A B C D. Two inflections are written as quarter tones: the
// second degree a quarter tone flat (64.5, 76.5) and a neutral third, G a quarter tone sharp
// (67.5, 79.5), that sits against the G sharp.
const SIXTEENTH = 0.25;

/** Sixteenths written as groups, the first of each group accented, the way a picking hand counts them. */
function picked(groups: number[][]): Note[] {
  const notes: Note[] = [];
  let beat = 0;
  for (const group of groups) {
    group.forEach((midi, i) => {
      notes.push([beat, SIXTEENTH, midi, i === 0 ? 1 : 0.7]);
      beat += SIXTEENTH;
    });
  }
  return notes;
}

/** Two bars: 3+3+2+3+3+2, then 3+3+3+3+2+2. */
const lead = line(
  'lead',
  'lead',
  picked([
    [76, 71, 76], [76.5, 76, 71], [80, 76.5], [76, 71, 76], [81, 80, 76.5], [76, 71],
    [76, 76.5, 80], [81, 80, 76.5], [83, 81, 80], [76.5, 76, 74], [72, 71], [76, 79.5],
  ]),
  8,
  FOUR_FOUR,
  { gain: 0.8, center: -0.5, maxHz: 10 }
);

/** Seven sixteenths, 3+2+2, against a bar of sixteen: the downbeat comes round to the same place every seven bars. */
const ostinato = line(
  'ostinato',
  'keys',
  [[0, 0.25, 64, 1], [0.5, 0.25, 64, 0.7], [0.75, 0.25, 64.5, 1], [1.25, 0.25, 67.5, 1], [1.5, 0.25, 64.5, 0.7]],
  7 * SIXTEENTH,
  FOUR_FOUR,
  { gain: 0.58, center: -0.5, maxHz: 10 }
);

/** E in 3+3+2+3+3+2, with the fifth below and a turn through the flat second. */
const bass = line(
  'bass',
  'bass',
  [[0, 0.5, 40], [0.75, 0.5, 40], [1.5, 0.5, 40], [2, 0.5, 40], [2.75, 0.5, 35], [3.5, 0.5, 40.5]],
  4,
  FOUR_FOUR,
  { gain: 0.8 }
);

/** One bar of sixteenths: cajón bass, palmas on the 3+3+3+3+2+2 count, congas. */
const cajonBass = pattern('cajon', 'kick', 'X.....x.X.....x.', 4, FOUR_FOUR, { gain: 0.9 });
const palmas = pattern('palmas', 'hat', 'X..X..X..X..X.X.', 4, FOUR_FOUR, { gain: 0.75, center: -0.2, maxHz: 10 });
const congas = pattern('congas', 'perc', '..x..x....x..x..', 4, FOUR_FOUR, { gain: 1 });

export const diMeola: Preset = {
  id: 'di-meola',
  name: 'Di Meola',
  blurb:
    'A fast picked line counts in threes over a hand-drum groove in fours, with notes between the piano keys, while the tempo climbs and the pitch steps up by quarter tones.',
  meter: FOUR_FOUR,
  kit: 'hand',
  timbre: 'pluck',
  trimDb: -4,
  tracks: [lead, ostinato, bass, cajonBass, palmas, congas],
  params: params({
    focusBpm: 140,
    tempoSlope: 1.6,
    pitchSlope: 0.45,
    pitchStep: 0.5,
    ratio: 1.5,
    spread: 0.4,
    levels: { drums: 0.9, melody: 1, pad: 0.15, sweep: 0, tape: 0, reverb: 0.2 },
  }),
  tonic: 52,
  padChord: [0, 7],
  padAnchor: false,
  credit:
    'After Al Di Meola’s fusion and flamenco guitar (“Race with Devil on Spanish Highway”, “Mediterranean Sundance”): picked sixteenths grouped in threes, a loop that does not fit the bar, E Phrygian dominant with quarter-tone inflections.',
};
