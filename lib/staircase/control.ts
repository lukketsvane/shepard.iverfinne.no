/**
 * Slopes of the two staircases as they are actually applied: the targets set by the user
 * (slider, pad or tilt), smoothed so tempo never jumps, plus a decaying "kick".
 */

import { SlopeTarget } from './types';

/** Seconds for the applied slope to close most of the gap to its target. */
export const SLOPE_TIME_CONSTANT = 0.35;
/** Seconds for a kick to die away. */
export const KICK_TIME_CONSTANT = 0.8;
/** Largest slope the pad or tilt can ask for, octaves per minute. */
export const MAX_SLOPE = 8;

export interface SlopeMotion {
  tempo: number;
  pitch: number;
  kick: number;
}

export function createSlopeMotion(target: SlopeTarget): SlopeMotion {
  return { tempo: target.tempo, pitch: target.pitch, kick: 0 };
}

export function stepSlopes(motion: SlopeMotion, target: SlopeTarget, dt: number): SlopeMotion {
  const follow = 1 - Math.exp(-dt / SLOPE_TIME_CONSTANT);
  return {
    tempo: motion.tempo + (target.tempo - motion.tempo) * follow,
    pitch: motion.pitch + (target.pitch - motion.pitch) * follow,
    kick: motion.kick * Math.exp(-dt / KICK_TIME_CONSTANT),
  };
}

/** Slopes to integrate. With `link`, pitch follows tempo exactly (kick included), like tape. */
export function appliedSlopes(motion: SlopeMotion, link: boolean): SlopeTarget {
  const tempo = motion.tempo + motion.kick;
  return { tempo, pitch: link ? tempo : motion.pitch };
}

/** "doubles every 30 s", "halves every 12 s", "steady" for a slope in octaves per minute. */
export function describeSlope(slope: number, up: string, down: string): string {
  if (Math.abs(slope) < 0.05) return 'steady';
  const seconds = 60 / Math.abs(slope);
  const every = seconds >= 10 ? `${Math.round(seconds)} s` : `${seconds.toFixed(1)} s`;
  return `${slope > 0 ? up : down} every ${every}`;
}
