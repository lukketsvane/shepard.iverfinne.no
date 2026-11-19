import { Track, TrackRole } from '../staircase/types';

/**
 * Where each kind of part sits by default.
 * `center`: octaves from the focus tempo at which the part is loudest. The bass lives in
 * slower layers (long notes), the lead in faster ones.
 * `maxHz`: the part's notes fade out once their stream runs faster than this.
 */
export const ROLE_DEFAULTS: Record<TrackRole, Pick<Track, 'center' | 'maxHz' | 'gain'>> = {
  kick: { center: 0, maxHz: 5.5, gain: 1 },
  snare: { center: 0, maxHz: 5, gain: 0.9 },
  hat: { center: 0, maxHz: 13, gain: 0.6 },
  perc: { center: 0, maxHz: 10, gain: 0.7 },
  bass: { center: -0.5, maxHz: 4.5, gain: 0.9 },
  keys: { center: 0, maxHz: 9, gain: 0.8 },
  lead: { center: 0.5, maxHz: 11, gain: 0.6 },
};
