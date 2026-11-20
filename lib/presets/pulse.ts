import { Preset } from '../staircase/types';
import { FOUR_FOUR, params, pattern } from './build';

export const pulse: Preset = {
  id: 'pulse',
  name: 'Pulse',
  blurb: 'Bare clicks, as in Risset’s original demonstration: nothing but the illusion.',
  meter: FOUR_FOUR,
  kit: 'pure',
  timbre: 'glass',
  trimDb: 14,
  tracks: [
    pattern('pulse', 'kick', 'X...x...x...x...', 4, FOUR_FOUR, { gain: 0.6 }),
    pattern('tick', 'hat', 'x.x.x.x.x.x.x.x.', 4, FOUR_FOUR, { gain: 0.4 }),
  ],
  params: params({ levels: { melody: 0, reverb: 0.1 } }),
  tonic: 45,
  padChord: [0],
  padAnchor: false,
  credit: 'After Risset’s endless accelerando, the Shepard tone played in tempo instead of pitch.',
};
