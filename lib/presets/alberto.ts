import { Preset } from '../staircase/types';
import { FOUR_FOUR, Note, excerpt, line, params, pattern } from './build';
import { ALBERTO } from './data/alberto';

/** Below this MIDI note (G3) the figure is the bass. */
const BASS_BELOW = 55;
/** The first half of the file is the figure, with a flutter of high E flats in its third eight beats. */
const figure = excerpt(ALBERTO, 0, 31.5);
/** The second half is the tune. It starts on a pickup at beat 31.5, so it is folded onto a 32-beat loop. */
const tune: Note[] = ALBERTO.filter(([beat]) => beat >= 31.5).map(([beat, dur, midi]) => [beat % 32, dur, midi]);

const bass = line('bass', 'bass', figure.filter(([, , midi]) => midi < BASS_BELOW), 32, FOUR_FOUR, {
  gain: 0.86,
});
const keys = line('figure', 'keys', figure.filter(([, , midi]) => midi >= BASS_BELOW), 32, FOUR_FOUR, {
  gain: 0.68,
});
const lead = line('tune', 'lead', tune, 32, FOUR_FOUR, { gain: 0.68 });

/** Two bars of sixteenths, kept soft: a kick under the bass notes, a rim on two and four, quiet clicks. */
const kick = pattern('kick', 'kick', 'X.......o.x.....X.......o.......', 4, FOUR_FOUR, { gain: 0.56 });
const rim = pattern('rim', 'snare', '....x.......x.......x.......x...', 4, FOUR_FOUR, { gain: 1.2 });
const click = pattern('click', 'hat', 'o.x.o.x.o.x.o.xoo.x.o.x.o.x.o.x.', 4, FOUR_FOUR, { gain: 0.82 });

export const alberto: Preset = {
  id: 'alberto',
  name: 'Alberto Balsalm',
  blurb:
    'A soft figure that jumps between octaves plays under a slow tune, with small clicks for a beat, and it all keeps speeding up like a music box being wound.',
  meter: FOUR_FOUR,
  kit: 'aphex',
  timbre: 'glass',
  trimDb: 2,
  tracks: [bass, keys, lead, kick, rim, click],
  params: params({
    focusBpm: 100,
    tempoSlope: 1,
    levels: { drums: 0.7, melody: 1, pad: 0.3, sweep: 0, tape: 0, reverb: 0.35 },
  }),
  tonic: 58,
  padChord: [0, 7],
  padAnchor: false,
  credit:
    'After Aphex Twin, “Alberto Balsalm” (…I Care Because You Do, 1995), notes from a MIDI transcription. No reliable tempo is published (one automatic estimate says 120 BPM); 100 BPM is a choice.',
};
