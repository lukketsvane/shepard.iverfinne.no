import { Preset } from '../staircase/types';
import { FOUR_FOUR, params, pattern } from './build';

const pulse: Preset = {
  id: 'pulse',
  name: 'Pulse',
  blurb: 'Bare clicks, as in Risset’s original demonstration: nothing but the illusion.',
  meter: FOUR_FOUR,
  kit: 'pure',
  timbre: 'glass',
  tracks: [
    pattern('pulse', 'kick', 'X...x...x...x...', 4, FOUR_FOUR),
    pattern('tick', 'hat', 'x.x.x.x.x.x.x.x.', 4, FOUR_FOUR, { gain: 0.35 }),
  ],
  params: params({ levels: { melody: 0, reverb: 0.1 } }),
  tonic: 45,
  padChord: [0],
  padAnchor: false,
};

export const PRESETS: Preset[] = [pulse];
