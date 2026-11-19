/** Steering the staircase by tilting the phone. */

export type TiltStatus = 'unsupported' | 'idle' | 'denied' | 'active';

/**
 * Tilt relative to the pose the phone was in when steering started or was last re-centred.
 * Both axes run from -1 to 1. `y` is positive when the top edge tips away from you,
 * `x` is positive when the right edge drops.
 */
export interface TiltReading {
  x: number;
  y: number;
}

export interface TiltHandlers {
  onReading(reading: TiltReading): void;
  onShake(): void;
}

export interface Tilt {
  /** Ask for sensor access and begin. Must be called from a tap. */
  start(): Promise<TiltStatus>;
  stop(): void;
  /** Make the current pose the new zero. */
  recentre(): void;
  status(): TiltStatus;
}

export function tiltSupported(): boolean {
  return false;
}

export function createTilt(_handlers: TiltHandlers): Tilt {
  // Placeholder until the sensor code lands.
  return {
    start: async () => 'unsupported',
    stop() {},
    recentre() {},
    status: () => 'unsupported',
  };
}
