import { IllusionDirection, RissetEngineParams } from './risset-math';

export const MIN_CENTER_BPM = 72;
export const MAX_CENTER_BPM = 176;
export const MIN_CYCLE_SEC = 8;
export const MAX_CYCLE_SEC = 40;

export const PAN_DEADZONE_PX = 12;
export const PINCH_DEADZONE_PX = 16;
export const ROTATE_DEADZONE_RAD = 0.26; // ~15 degrees

export interface TouchPoint {
  x: number;
  y: number;
}

export interface TwoFingerAnchor {
  p1: TouchPoint;
  p2: TouchPoint;
  centroid: TouchPoint;
  distance: number;
  angleRad: number;
  startParams: RissetEngineParams;
}

export interface TwoFingerGestureResult {
  patch: Partial<RissetEngineParams>;
  activeHudLabel: string | null;
  deltaAngleRad: number;
  pinchScale: number;
  centroid: TouchPoint;
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function shortestAngleDelta(fromRad: number, toRad: number): number {
  const diff = toRad - fromRad;
  return Math.atan2(Math.sin(diff), Math.cos(diff));
}

export function createTwoFingerAnchor(
  p1: TouchPoint,
  p2: TouchPoint,
  currentParams: RissetEngineParams
): TwoFingerAnchor {
  const centroid = {
    x: (p1.x + p2.x) * 0.5,
    y: (p1.y + p2.y) * 0.5,
  };
  const distance = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
  const angleRad = Math.atan2(p2.y - p1.y, p2.x - p1.x);

  return {
    p1: { ...p1 },
    p2: { ...p2 },
    centroid,
    distance,
    angleRad,
    startParams: { ...currentParams },
  };
}

/**
 * 1-Finger Vertical Drag -> Focal Center Tempo (BPM)
 */
export function applyOneFingerVerticalTempo(
  startBpm: number,
  deltaY: number,
  viewportHeight: number
): number {
  const safeH = Math.max(320, viewportHeight);
  const normalized = -deltaY / (safeH * 0.65);
  const raw = startBpm + normalized * (MAX_CENTER_BPM - MIN_CENTER_BPM);
  return Math.round(clamp(raw, MIN_CENTER_BPM, MAX_CENTER_BPM));
}

/**
 * 1-Finger Horizontal Drag -> Dropped Subdivisions [0..1]
 */
export function applyOneFingerHorizontalSubdivisions(
  startSubDrop: number,
  deltaX: number,
  viewportWidth: number
): number {
  const safeW = Math.max(280, viewportWidth);
  const normalized = deltaX / (safeW * 0.7);
  return Number(clamp(startSubDrop + normalized, 0, 1).toFixed(3));
}

/**
 * Evaluates simultaneous 2-finger iOS gesture geometry with dead-zone isolation:
 * - Two-Finger Vertical Pan   -> Shepard Pitch Riser [0..1]
 * - Two-Finger Horizontal Pan -> 3:2 Hemiola Cross-Accent [0..1]
 * - Two-Finger Pinch          -> Octave Cycle Period [8..40s]
 * - Two-Finger Rotate         -> Accelerando (CW) / Decelerando (CCW) + Bell Focus
 */
export function evaluateTwoFingerGesture(
  anchor: TwoFingerAnchor,
  p1: TouchPoint,
  p2: TouchPoint,
  viewportWidth: number,
  viewportHeight: number
): TwoFingerGestureResult {
  const centroid = {
    x: (p1.x + p2.x) * 0.5,
    y: (p1.y + p2.y) * 0.5,
  };
  const distance = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
  const angleRad = Math.atan2(p2.y - p1.y, p2.x - p1.x);

  const dx = centroid.x - anchor.centroid.x;
  const dy = centroid.y - anchor.centroid.y;
  const distDelta = distance - anchor.distance;
  const deltaAngleRad = shortestAngleDelta(anchor.angleRad, angleRad);
  const pinchScale = distance / Math.max(20, anchor.distance);

  const patch: Partial<RissetEngineParams> = {};

  // Track which gesture component has the strongest normalized intent for minimal 1-token HUD
  let dominantScore = 0;
  let activeHudLabel: string | null = null;

  const safeW = Math.max(280, viewportWidth);
  const safeH = Math.max(320, viewportHeight);

  // 1. Two-Finger Vertical -> Shepard Pitch Riser
  if (Math.abs(dy) > PAN_DEADZONE_PX) {
    const effDy = dy - Math.sign(dy) * PAN_DEADZONE_PX;
    const riser = clamp(
      anchor.startParams.shepardRiserMix + -effDy / (safeH * 0.55),
      0,
      1
    );
    patch.shepardRiserMix = Number(riser.toFixed(3));
    const score = Math.abs(effDy) / 60;
    if (score > dominantScore) {
      dominantScore = score;
      activeHudLabel = `RISER ${Math.round(riser * 100)}%`;
    }
  }

  // 2. Two-Finger Horizontal -> 3:2 Hemiola Mix
  if (Math.abs(dx) > PAN_DEADZONE_PX) {
    const effDx = dx - Math.sign(dx) * PAN_DEADZONE_PX;
    const hemi = clamp(
      anchor.startParams.hemiolaMix + effDx / (safeW * 0.55),
      0,
      1
    );
    patch.hemiolaMix = Number(hemi.toFixed(3));
    const score = Math.abs(effDx) / 60;
    if (score > dominantScore) {
      dominantScore = score;
      activeHudLabel = `3:2 ${Math.round(hemi * 100)}%`;
    }
  }

  // 3. Two-Finger Pinch -> Cycle Period Seconds
  if (Math.abs(distDelta) > PINCH_DEADZONE_PX) {
    const effDist = anchor.distance + (distDelta - Math.sign(distDelta) * PINCH_DEADZONE_PX);
    const ratio = clamp(effDist / Math.max(24, anchor.distance), 0.25, 4.0);
    const cycleSec = Math.round(
      clamp(
        anchor.startParams.targetCycleSeconds * ratio,
        MIN_CYCLE_SEC,
        MAX_CYCLE_SEC
      )
    );
    patch.targetCycleSeconds = cycleSec;
    const score = Math.abs(distDelta) / 45;
    if (score > dominantScore) {
      dominantScore = score;
      activeHudLabel = `${cycleSec}S`;
    }
  }

  // 4. Two-Finger Rotate -> Direction (CW = Accelerando, CCW = Decelerando) + Bell Focus
  if (Math.abs(deltaAngleRad) > ROTATE_DEADZONE_RAD) {
    const effAngle =
      deltaAngleRad - Math.sign(deltaAngleRad) * ROTATE_DEADZONE_RAD;
    const direction: IllusionDirection =
      deltaAngleRad > 0 ? 'accelerando' : 'decelerando';
    patch.direction = direction;

    const focus = clamp(
      anchor.startParams.bellFocus + ( Math.abs(effAngle) / Math.PI ) * 0.45 * (deltaAngleRad > 0 ? 1 : -1),
      0.65,
      2.1
    );
    patch.bellFocus = Number(focus.toFixed(2));

    const score = Math.abs(effAngle) / 0.28;
    if (score > dominantScore) {
      dominantScore = score;
      activeHudLabel = direction === 'accelerando' ? 'ACCEL' : 'DECEL';
    }
  }

  return {
    patch,
    activeHudLabel,
    deltaAngleRad,
    pinchScale,
    centroid,
  };
}
