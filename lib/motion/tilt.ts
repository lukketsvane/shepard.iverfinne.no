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

/** Standard gravity in m/s^2 (the constant WebKit scales CoreMotion's readings by). */
export const GRAVITY = 9.80665;
/** Seconds for the filtered gravity to close most of the gap to a new pose. */
export const SMOOTHING_TIME = 0.15;
/** Tilt below this many degrees from the reference reads as zero. */
export const DEAD_ZONE_DEG = 3;
/** Tilt at which the reading reaches 1. */
export const FULL_TILT_DEG = 35;
/**
 * Samples whose magnitude differs from gravity by more than this fraction are shakes or knocks,
 * not a pose; they would swing the tilt around, so the pose holds still through them.
 */
export const CALM_BAND = 0.35;
/** Seconds after the screen rotates during which the zero follows the phone (it is mid-turn). */
export const ROTATE_SETTLE = 0.6;
/**
 * Linear acceleration (m/s^2) a swing must exceed to count. Carrying a phone while walking
 * moves it by a few m/s^2; a deliberate shake gives well over 15.
 */
export const SHAKE_ACCEL = 12;
/** A shake is two swings this close together (seconds); a single knock is not one. */
export const SHAKE_WINDOW = 0.5;
/** Seconds after a shake before another can register. */
export const SHAKE_COOLDOWN = 0.6;
/** Seconds to wait for the first real sample before deciding the device has no sensors. */
const SENSOR_WAIT_MS = 1000;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Screen tilt in degrees: `pitch` falls as the top edge tips away, `roll` rises as the right drops. */
export interface Pose {
  pitch: number;
  roll: number;
}

const toRad = Math.PI / 180;
const toDeg = 180 / Math.PI;

function isNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Every iPhone and iPad browser runs on WebKit, which reports accelerationIncludingGravity
 * with the opposite sign to the spec: the spec has a phone lying face up read z = +9.8
 * (https://w3c.github.io/deviceorientation/ section 3.2), WebKit passes CoreMotion's vector
 * on without negating it, so z = -9.8 (Source/WebCore/platform/ios/WebCoreMotionManager.mm).
 * Android browsers follow the spec. iPadOS can claim to be a Mac, hence the touch check.
 */
export function reportsInvertedGravity(nav: {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}): boolean {
  return (
    /iPhone|iPad|iPod/.test(nav.userAgent) ||
    (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)
  );
}

/**
 * Which way is up, in the device frame (x right, y toward the top edge, z out of the screen,
 * unaffected by screen rotation), from accelerationIncludingGravity. A phone at rest feels
 * the floor push up, so the spec's vector points up; `inverted` undoes WebKit's flip.
 * Null while the sample cannot say (no data, or free fall).
 */
export function gravityFromMotion(
  a: { x: number | null; y: number | null; z: number | null } | null,
  inverted: boolean
): Vec3 | null {
  if (!a || !isNumber(a.x) || !isNumber(a.y) || !isNumber(a.z)) return null;
  const sign = inverted ? -1 : 1;
  const up = { x: sign * a.x, y: sign * a.y, z: sign * a.z };
  return length(up) >= GRAVITY / 2 ? up : null;
}

/**
 * The same "up" vector from deviceorientation, for phones that give no usable accelerometer
 * reading. beta and gamma are rotations in the spec's Z-X'-Y'' order, so up in the device
 * frame is (-cos b sin g, sin b, cos b cos g). Unlike the accelerometer, this is the same
 * on every platform.
 */
export function gravityFromOrientation(beta: number | null, gamma: number | null): Vec3 | null {
  if (!isNumber(beta) || !isNumber(gamma)) return null;
  const b = beta * toRad;
  const g = gamma * toRad;
  return {
    x: -GRAVITY * Math.cos(b) * Math.sin(g),
    y: GRAVITY * Math.sin(b),
    z: GRAVITY * Math.cos(b) * Math.cos(g),
  };
}

/**
 * Re-express a device-frame vector in the frame of what is drawn on screen. The sensor frame
 * stays fixed to the phone when the screen rotates (spec section 3.1), but the person sees the
 * page upright, so "top edge" must mean the top of the page. `angle` is screen.orientation.angle:
 * how far the screen has turned counter-clockwise from natural (W3C Screen Orientation 2.2),
 * the same sign as the older window.orientation (MDN: positive is counter-clockwise).
 */
export function toScreenFrame(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle * toRad);
  const s = Math.sin(angle * toRad);
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y, z: v.z };
}

/**
 * Pitch and roll of a screen-frame "up" vector. Both come from ratios of the vector's
 * components, so there is no gimbal singularity with the phone held upright, and the unit of
 * the vector does not matter.
 */
export function poseOf(up: Vec3): Pose {
  return {
    pitch: Math.atan2(up.y, up.z) * toDeg,
    roll: Math.atan2(-up.x, Math.hypot(up.y, up.z)) * toDeg,
  };
}

/** Fold an angle difference into (-180, 180]. */
export function wrapDegrees(deg: number): number {
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * Degrees of tilt to a reading in [-1, 1]: nothing inside the dead zone, then a curve that
 * starts gently (fine control near the middle) and steepens to full scale, then clamps.
 */
export function shapeTilt(deg: number): number {
  const beyond = Math.abs(deg) - DEAD_ZONE_DEG;
  if (beyond <= 0) return 0;
  const t = Math.min(beyond / (FULL_TILT_DEG - DEAD_ZONE_DEG), 1);
  return Math.sign(deg) * 0.5 * (t + t * t * t);
}

/** Tilt of `pose` away from the reference pose, as a reading. */
export function readingFor(pose: Pose, reference: Pose): TiltReading {
  return {
    x: shapeTilt(wrapDegrees(pose.roll - reference.roll)),
    y: shapeTilt(wrapDegrees(reference.pitch - pose.pitch)),
  };
}

/** One-pole low-pass, exact for any step length so the sample rate does not matter. */
export function smoothVector(prev: Vec3, next: Vec3, dt: number, tau = SMOOTHING_TIME): Vec3 {
  const follow = 1 - Math.exp(-Math.max(dt, 0) / tau);
  return {
    x: prev.x + (next.x - prev.x) * follow,
    y: prev.y + (next.y - prev.y) * follow,
    z: prev.z + (next.z - prev.z) * follow,
  };
}

export interface ShakeState {
  /** Whether the last sample was above the threshold, so only a rising edge counts as a swing. */
  above: boolean;
  lastSwing: number;
  lastShake: number;
}

export const SHAKE_REST: ShakeState = { above: false, lastSwing: -Infinity, lastShake: -Infinity };

/** Feed one linear-acceleration magnitude (m/s^2) at `now` seconds; says if it completes a shake. */
export function stepShake(
  state: ShakeState,
  magnitude: number,
  now: number
): { state: ShakeState; shake: boolean } {
  const above = magnitude > SHAKE_ACCEL;
  if (!above || state.above) return { state: { ...state, above }, shake: false };
  const shake = now - state.lastSwing <= SHAKE_WINDOW && now - state.lastShake >= SHAKE_COOLDOWN;
  return {
    state: { above, lastSwing: now, lastShake: shake ? now : state.lastShake },
    shake,
  };
}

export interface Conditioned {
  /** Null while the phone is being shaken or knocked and the pose cannot be trusted. */
  reading: TiltReading | null;
  shake: boolean;
}

export interface Conditioner {
  /**
   * One "up" vector in m/s^2 taken at `t` seconds with the screen at `screenAngle`. Only
   * accelerometer vectors (`canShake`) say anything about movement; orientation-derived ones
   * are always exactly gravity.
   */
  push(up: Vec3, t: number, screenAngle: number, canShake: boolean): Conditioned;
  recentre(): void;
}

/** Everything between raw samples and readings, free of the browser so tests can drive it. */
export function createConditioner(): Conditioner {
  let gravity: Vec3 | null = null;
  let sampleTime = 0;
  let reference: Pose | null = null;
  let angle: number | null = null;
  let settleUntil = 0;
  let shakeState = SHAKE_REST;

  return {
    push(up, t, screenAngle, canShake) {
      let shake = false;
      // Movement is what the sample adds to the gravity estimate it has not yet been mixed into.
      if (gravity && canShake) {
        const step = stepShake(shakeState, distance(up, gravity), t);
        shakeState = step.state;
        shake = step.shake;
      }
      if (Math.abs(length(up) - GRAVITY) > GRAVITY * CALM_BAND) return { reading: null, shake };

      gravity = gravity ? smoothVector(gravity, up, t - sampleTime) : up;
      sampleTime = t;
      if (screenAngle !== angle) {
        // The old zero meant something else on the other side of the turn.
        if (angle !== null) settleUntil = t + ROTATE_SETTLE;
        angle = screenAngle;
      }
      const pose = poseOf(toScreenFrame(gravity, screenAngle));
      if (!reference || t < settleUntil) reference = pose;
      return { reading: readingFor(pose, reference), shake };
    },
    recentre() {
      reference = null;
    },
  };
}

export function tiltSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    ('DeviceMotionEvent' in window || 'DeviceOrientationEvent' in window)
  );
}

/**
 * iOS 13+ gates both sensors behind one permission, per origin (WebKit keeps one access state
 * for "DeviceOrientationAndMotion"); asking for either covers them. Chromium now has the same
 * methods, resolving with the Permissions API state, which is "prompt" when nothing has been
 * decided, so only an explicit "denied" counts as a refusal. Android Chrome has no prompt
 * for motion sensors by default and just delivers the events.
 */
interface PermissionGate {
  requestPermission?: () => Promise<string>;
}

/** Called synchronously from start(): iOS only shows the prompt inside the tap's user gesture. */
function askPermission(): Promise<string> | null {
  const w = window as unknown as Record<string, PermissionGate | undefined>;
  const gate = [w.DeviceMotionEvent, w.DeviceOrientationEvent].find(
    (g) => typeof g?.requestPermission === 'function'
  );
  return gate?.requestPermission ? gate.requestPermission() : null;
}

/** screen.orientation arrived in Safari 16.4; before it only window.orientation (deprecated) exists. */
function screenAngle(): number {
  const angle = window.screen?.orientation?.angle;
  if (typeof angle === 'number') return angle;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

export function createTilt(handlers: TiltHandlers): Tilt {
  let state: TiltStatus = tiltSupported() ? 'idle' : 'unsupported';
  let starting: Promise<TiltStatus> | null = null;
  /** Bumped by stop() so a start() still waiting on the permission prompt knows to give up. */
  let session = 0;
  let settle: ((status: TiltStatus) => void) | null = null;
  let sensorTimer: ReturnType<typeof setTimeout> | undefined;
  let conditioner = createConditioner();
  let inverted = false;
  /** Once the accelerometer has spoken, orientation events are redundant. */
  let fromMotion = false;
  let lock: WakeLockSentinel | null = null;
  let locking = false;

  /** Leave the waiting phase of start(). */
  function finish(status: TiltStatus) {
    clearTimeout(sensorTimer);
    settle?.(status);
    settle = null;
  }

  function accept({ reading, shake }: Conditioned) {
    if (reading && state !== 'active') {
      state = 'active';
      finish('active');
      void holdScreen();
    }
    if (reading) handlers.onReading(reading);
    if (shake && state === 'active') handlers.onShake();
  }

  function onMotion(e: DeviceMotionEvent) {
    const up = gravityFromMotion(e.accelerationIncludingGravity, inverted);
    if (!up) return;
    fromMotion = true;
    accept(conditioner.push(up, e.timeStamp / 1000, screenAngle(), true));
  }

  function onOrientation(e: DeviceOrientationEvent) {
    if (fromMotion) return;
    const up = gravityFromOrientation(e.beta, e.gamma);
    if (up) accept(conditioner.push(up, e.timeStamp / 1000, screenAngle(), false));
  }

  /** The browser drops the lock whenever the page is hidden, so take it again on return. */
  function onVisibility() {
    if (state === 'active') void holdScreen();
  }

  async function holdScreen() {
    if (lock || locking || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    locking = true;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (state !== 'active') {
        void sentinel.release();
        return;
      }
      sentinel.addEventListener('release', () => {
        if (lock === sentinel) lock = null;
      });
      lock = sentinel;
    } catch {
      // Refused (battery saver, unsupported): steering works, the screen may just dim.
    } finally {
      locking = false;
    }
  }

  function listen() {
    window.addEventListener('devicemotion', onMotion);
    window.addEventListener('deviceorientation', onOrientation);
    document.addEventListener('visibilitychange', onVisibility);
  }

  function unlisten() {
    window.removeEventListener('devicemotion', onMotion);
    window.removeEventListener('deviceorientation', onOrientation);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  async function run(): Promise<TiltStatus> {
    if (state === 'active') return state;
    if (!tiltSupported()) return (state = 'unsupported');
    const token = session;
    // Nothing may be awaited before this call: iOS accepts it only inside the tap's gesture.
    const asked = askPermission();
    if (asked) {
      let answer = 'denied';
      try {
        answer = await asked;
      } catch {
        // No gesture, or no browsing context: access was not given.
      }
      if (token !== session) return state;
      if (answer === 'denied') return (state = 'denied');
    }

    inverted = reportsInvertedGravity(navigator);
    fromMotion = false;
    conditioner = createConditioner();
    return new Promise<TiltStatus>((resolve) => {
      settle = resolve;
      listen();
      // Browsers without sensors (desktops) still expose the API but never deliver a real sample.
      sensorTimer = setTimeout(() => {
        unlisten();
        state = 'unsupported';
        finish(state);
      }, SENSOR_WAIT_MS);
    });
  }

  return {
    start() {
      starting ??= run().finally(() => {
        starting = null;
      });
      return starting;
    },
    stop() {
      session++;
      unlisten();
      void lock?.release();
      lock = null;
      if (state === 'active') state = 'idle';
      finish(state);
    },
    recentre() {
      conditioner.recentre();
    },
    status: () => state,
  };
}
