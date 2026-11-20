import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEAD_ZONE_DEG,
  FULL_TILT_DEG,
  GRAVITY,
  ROTATE_SETTLE,
  SHAKE_COOLDOWN,
  Vec3,
  createConditioner,
  gravityFromMotion,
  gravityFromOrientation,
  poseOf,
  readingFor,
  reportsInvertedGravity,
  shapeTilt,
  smoothVector,
  toScreenFrame,
  wrapDegrees,
} from './tilt';

const rad = Math.PI / 180;
const G = GRAVITY;

function near(actual: number, expected: number, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not within ${eps} of ${expected}`);
}

function nearVec(actual: Vec3, expected: Vec3, eps = 1e-9) {
  near(actual.x, expected.x, eps);
  near(actual.y, expected.y, eps);
  near(actual.z, expected.z, eps);
}

/**
 * Which way is up, in the frame of the page, for a phone tipped back `backDeg` from upright
 * (top edge away from you) with its right edge `dropDeg` below the horizontal.
 */
function pageUp(backDeg: number, dropDeg = 0): Vec3 {
  const pitch = (90 - backDeg) * rad;
  const drop = dropDeg * rad;
  return {
    x: -G * Math.sin(drop),
    y: G * Math.cos(drop) * Math.sin(pitch),
    z: G * Math.cos(drop) * Math.cos(pitch),
  };
}

/** The phone's own frame when the page is upright: unturned. */
const portrait = pageUp;

/** Turned onto its left side (screen angle 90, top of the phone to the left): the page's top is the phone's right edge. */
function landscapeLeft(backDeg: number, dropDeg = 0): Vec3 {
  const p = pageUp(backDeg, dropDeg);
  return { x: p.y, y: -p.x, z: p.z };
}

/** Turned onto its right side (screen angle 270): the page's top is the phone's left edge. */
function landscapeRight(backDeg: number, dropDeg = 0): Vec3 {
  const p = pageUp(backDeg, dropDeg);
  return { x: -p.y, y: p.x, z: p.z };
}

test('which phones report gravity with the spec sign', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15';
  assert.equal(reportsInvertedGravity({ userAgent: iphone, platform: 'iPhone', maxTouchPoints: 5 }), true);
  assert.equal(reportsInvertedGravity({ userAgent: android, platform: 'Linux armv81', maxTouchPoints: 5 }), false);
  // iPadOS 13+ sends a Mac user agent; only the touch screen gives it away.
  assert.equal(reportsInvertedGravity({ userAgent: mac, platform: 'MacIntel', maxTouchPoints: 5 }), true);
  assert.equal(reportsInvertedGravity({ userAgent: mac, platform: 'MacIntel', maxTouchPoints: 0 }), false);
});

test('gravity from the accelerometer: spec sign, WebKit sign, and samples that say nothing', () => {
  // Spec example: lying face up reads +9.8 on z.
  assert.deepEqual(gravityFromMotion({ x: 0, y: 0, z: 9.8 }, false), { x: 0, y: 0, z: 9.8 });
  // WebKit reads -9.8 for the same pose; undoing the flip gives the same vector.
  nearVec(gravityFromMotion({ x: 0, y: 0, z: -9.8 }, true)!, { x: 0, y: 0, z: 9.8 });
  assert.equal(gravityFromMotion(null, false), null);
  assert.equal(gravityFromMotion({ x: null, y: null, z: null }, false), null); // desktop browsers
  assert.equal(gravityFromMotion({ x: 0, y: 0, z: 0 }, false), null);
  assert.equal(gravityFromMotion({ x: 0.1, y: 0.2, z: 0.3 }, false), null); // free fall
  assert.equal(gravityFromMotion({ x: NaN, y: 0, z: 9.8 }, false), null);
});

test('gravity from beta and gamma agrees with the spec poses', () => {
  nearVec(gravityFromOrientation(0, 0)!, { x: 0, y: 0, z: G });
  nearVec(gravityFromOrientation(90, 0)!, { x: 0, y: G, z: 0 }); // upright
  nearVec(gravityFromOrientation(0, 30)!, { x: -G * Math.sin(30 * rad), y: 0, z: G * Math.cos(30 * rad) }); // right edge down
  nearVec(gravityFromOrientation(60, 0)!, portrait(30));
  assert.equal(gravityFromOrientation(null, null), null);
  near(Math.hypot(...Object.values(gravityFromOrientation(37, -52)!) as [number, number, number]), G);
});

test('portrait: the top edge tipping away is +y, the right edge dropping is +x', () => {
  const reference = poseOf(toScreenFrame(portrait(40), 0));
  const away = readingFor(poseOf(toScreenFrame(portrait(60), 0)), reference);
  const toward = readingFor(poseOf(toScreenFrame(portrait(20), 0)), reference);
  assert.ok(away.y > 0.3 && toward.y < -0.3);
  near(away.x, 0);
  const drop = readingFor(poseOf(toScreenFrame(portrait(40, 20), 0)), reference);
  const lift = readingFor(poseOf(toScreenFrame(portrait(40, -20), 0)), reference);
  assert.ok(drop.x > 0.3 && lift.x < -0.3);
  near(drop.y, 0, 1e-6);
});

test('landscape: top edge and right edge mean the edges of the page, not of the phone', () => {
  for (const [angle, make] of [[90, landscapeLeft], [270, landscapeRight]] as const) {
    const reference = poseOf(toScreenFrame(make(40), angle));
    const away = readingFor(poseOf(toScreenFrame(make(60), angle)), reference);
    const drop = readingFor(poseOf(toScreenFrame(make(40, 20), angle)), reference);
    assert.ok(away.y > 0.3, `angle ${angle}: tipping away gives ${away.y}`);
    near(away.x, 0, 1e-6);
    assert.ok(drop.x > 0.3, `angle ${angle}: right edge dropping gives ${drop.x}`);
    near(drop.y, 0, 1e-6);
  }
});

test('the same movement reads the same whichever way the phone is turned, and with either accelerometer sign', () => {
  const moves = [
    { back: [40, 60], drop: [0, 0] },
    { back: [40, 40], drop: [0, -25] },
    { back: [55, 30], drop: [0, 15] },
  ];
  for (const m of moves) {
    const readings = [
      [0, portrait],
      [90, landscapeLeft],
      [270, landscapeRight],
    ].map(([angle, make]) => {
      const f = make as typeof portrait;
      const ref = poseOf(toScreenFrame(f(m.back[0], m.drop[0]), angle as number));
      return readingFor(poseOf(toScreenFrame(f(m.back[1], m.drop[1]), angle as number)), ref);
    });
    for (const r of readings) {
      near(r.x, readings[0].x, 1e-6);
      near(r.y, readings[0].y, 1e-6);
    }
  }
  // WebKit negates the whole accelerometer vector; undone, nothing changes.
  const v = portrait(50, 10);
  const webkit = gravityFromMotion({ x: -v.x, y: -v.y, z: -v.z }, true)!;
  const android = gravityFromMotion(v, false)!;
  nearVec(webkit, android);
});

test('the legacy window.orientation sign agrees with screen.orientation.angle', () => {
  // -90 (turned clockwise) is 270 on the modern scale; the maths takes either.
  nearVec(toScreenFrame({ x: 1, y: 2, z: 3 }, -90), toScreenFrame({ x: 1, y: 2, z: 3 }, 270));
  nearVec(toScreenFrame({ x: 1, y: 2, z: 3 }, 180), { x: -1, y: -2, z: 3 });
});

test('upright phone has no singularity: tilting through vertical stays smooth', () => {
  let last = -Infinity;
  for (let back = 10; back <= 80; back += 1) {
    const p = poseOf(toScreenFrame(portrait(back), 0));
    near(p.roll, 0, 1e-9);
    assert.ok(p.pitch < 90 && p.pitch > 0);
    const y = readingFor(p, poseOf(toScreenFrame(portrait(45), 0))).y;
    assert.ok(y >= last);
    last = y;
  }
});

test('dead zone, response curve and clamp', () => {
  assert.equal(shapeTilt(0), 0);
  assert.equal(shapeTilt(DEAD_ZONE_DEG), 0);
  assert.equal(shapeTilt(-DEAD_ZONE_DEG + 0.01), 0);
  assert.ok(shapeTilt(DEAD_ZONE_DEG + 0.5) > 0 && shapeTilt(DEAD_ZONE_DEG + 0.5) < 0.01, 'starts from zero, no jump');
  near(shapeTilt(FULL_TILT_DEG), 1);
  near(shapeTilt(-FULL_TILT_DEG), -1);
  assert.equal(shapeTilt(80), 1);
  assert.equal(shapeTilt(-80), -1);
  const middle = (DEAD_ZONE_DEG + FULL_TILT_DEG) / 2;
  assert.ok(shapeTilt(middle) < 0.5, 'gentler than linear in the middle');
  let last = 0;
  for (let d = 0; d <= 40; d += 0.5) {
    assert.ok(shapeTilt(d) >= last);
    near(shapeTilt(-d), -shapeTilt(d));
    last = shapeTilt(d);
  }
});

test('angle differences wrap the short way round', () => {
  near(wrapDegrees(190), -170);
  near(wrapDegrees(-190), 170);
  near(wrapDegrees(360), 0);
  near(wrapDegrees(180), 180);
  near(wrapDegrees(-180), 180);
  near(wrapDegrees(12), 12);
  const across = readingFor({ pitch: -175, roll: 0 }, { pitch: 175, roll: 0 });
  near(across.y, shapeTilt(-10), 1e-12); // ten degrees across the seam, not 350
});

test('smoothing: step response of a 0.15 s one-pole, independent of the sample rate', () => {
  const from = { x: 0, y: 0, z: 0 };
  const to = { x: 10, y: -4, z: 2 };
  near(smoothVector(from, to, 0.15).x, 10 * (1 - Math.exp(-1)), 1e-12);
  assert.ok(smoothVector(from, to, 0.75).x > 9.9);
  assert.deepEqual(smoothVector(from, to, 0), from);
  assert.deepEqual(smoothVector(from, to, -1), from);
  const once = smoothVector(from, to, 0.1);
  let stepped = from;
  for (let i = 0; i < 10; i++) stepped = smoothVector(stepped, to, 0.01);
  nearVec(stepped, once, 1e-12);
});

/** Run the conditioner over `seconds` of 60 Hz samples of `signal(t)`. */
function run(
  conditioner: ReturnType<typeof createConditioner>,
  seconds: number,
  signal: (t: number) => Vec3,
  options: { start?: number; angle?: number; canShake?: boolean } = {}
) {
  const start = options.start ?? 0;
  const readings: { t: number; x: number; y: number }[] = [];
  const shakes: number[] = [];
  for (let i = 0; i <= seconds * 60; i++) {
    const t = start + i / 60;
    const out = conditioner.push(signal(t), t, options.angle ?? 0, options.canShake ?? true);
    if (out.reading) readings.push({ t, ...out.reading });
    if (out.shake) shakes.push(t);
  }
  return { readings, shakes };
}

test('calibration: the pose at the start is zero, recentre() makes the current pose zero', () => {
  const c = createConditioner();
  const first = run(c, 0.5, () => portrait(30));
  assert.deepEqual(first.readings[0], { t: 0, x: 0, y: 0 });
  near(first.readings[first.readings.length - 1].y, 0, 1e-6);

  const tipped = run(c, 1, () => portrait(60), { start: 0.5 });
  assert.ok(tipped.readings[tipped.readings.length - 1].y > 0.5);

  c.recentre();
  const after = run(c, 1, () => portrait(60), { start: 1.5 });
  assert.deepEqual(after.readings[0].y, 0);
  near(after.readings[after.readings.length - 1].y, 0, 1e-6);
  // ...and tipping back now reads as the opposite direction from the new zero.
  const back = run(c, 1, () => portrait(30), { start: 2.5 });
  assert.ok(back.readings[back.readings.length - 1].y < -0.5);
});

test('step response through the whole chain: no jump, then settles', () => {
  const c = createConditioner();
  run(c, 0.5, () => portrait(30));
  const { readings } = run(c, 1.5, () => portrait(55), { start: 0.5 });
  let last = 0;
  for (const r of readings) {
    assert.ok(r.y >= last - 1e-12, 'rises monotonically');
    last = r.y;
  }
  assert.ok(readings[1].y < 0.05, 'the first sample after the step barely moves');
  // 25 degrees tilt: shaped value is the same as the filter has fully settled by 1.5 s.
  near(readings[readings.length - 1].y, shapeTilt(25), 1e-3);
  // After one time constant the filter has covered 63% of the 25 degrees.
  const atTau = readings.find((r) => r.t >= 0.5 + 0.15)!;
  assert.ok(atTau.y > shapeTilt(25 * 0.55) && atTau.y < shapeTilt(25 * 0.7));
});

test('turning the screen re-zeroes once the turn is over, instead of steering during it', () => {
  const c = createConditioner();
  run(c, 0.5, () => portrait(40));
  // A quarter turn counter-clockwise about the screen normal, taking 0.3 s. The screen flips
  // to landscape halfway through, while the phone is still moving.
  const turning = (t: number): Vec3 => {
    const phi = (Math.min(Math.max(t - 0.5, 0), 0.3) / 0.3) * (Math.PI / 2);
    return { x: G * 0.8 * Math.sin(phi), y: G * 0.8 * Math.cos(phi), z: G * 0.6 };
  };
  run(c, 0.15, turning, { start: 0.5, angle: 0 });
  const after = run(c, 1.5, turning, { start: 0.65, angle: 90 });
  const during = after.readings.filter((r) => r.t < 0.65 + ROTATE_SETTLE);
  assert.ok(during.length > 30 && during.every((r) => r.x === 0 && r.y === 0), 'quiet while settling');
  const end = after.readings[after.readings.length - 1];
  assert.ok(Math.abs(end.x) < 0.03 && Math.abs(end.y) < 0.03, `zero in the new orientation, got ${end.x}, ${end.y}`);
  // From the new zero, tipping the page's top away reads as +y in landscape too.
  const tipped = run(c, 1, () => landscapeLeft(65), { start: 2.15, angle: 90 });
  assert.ok(tipped.readings[tipped.readings.length - 1].y > 0.3);
});

test('knocks and shakes do not steer: the pose holds through them', () => {
  const c = createConditioner();
  run(c, 0.5, () => portrait(40));
  const out = c.push({ x: 25, y: -30, z: 10 }, 0.52, 0, true);
  assert.equal(out.reading, null);
  const after = c.push(portrait(40), 0.54, 0, true);
  assert.deepEqual(after.reading, { x: 0, y: 0 });
});

/** The phone held at a pose while the hand adds `lin(t)` m/s^2 along the screen's y axis. */
function moving(lin: (t: number) => number, pose = portrait(40)): (t: number) => Vec3 {
  return (t) => ({ x: pose.x, y: pose.y + lin(t), z: pose.z });
}

test('shake: a deliberate shake fires once, not on every swing', () => {
  const c = createConditioner();
  run(c, 0.5, () => portrait(40));
  const { shakes } = run(c, 0.6, moving((t) => 22 * Math.sin(2 * Math.PI * 4 * t)), { start: 0.5 });
  assert.equal(shakes.length, 1);
});

test('shake: continued shaking repeats no faster than the cooldown', () => {
  const c = createConditioner();
  run(c, 0.5, () => portrait(40));
  const { shakes } = run(c, 3, moving((t) => 22 * Math.sin(2 * Math.PI * 4 * t)), { start: 0.5 });
  assert.ok(shakes.length >= 3 && shakes.length <= 5, `${shakes.length} shakes in 3 s`);
  for (let i = 1; i < shakes.length; i++) assert.ok(shakes[i] - shakes[i - 1] >= SHAKE_COOLDOWN - 1e-9);
});

test('shake: walking with the phone in hand does not fire it', () => {
  const c = createConditioner();
  run(c, 0.5, () => portrait(40));
  // Strides about twice a second moving the phone by up to ~5 m/s^2, with a little sway on top.
  const walking = moving((t) => 4 * Math.sin(2 * Math.PI * 1.9 * t) + 1.5 * Math.sin(2 * Math.PI * 0.95 * t + 1));
  const { shakes, readings } = run(c, 20, walking, { start: 0.5 });
  assert.equal(shakes.length, 0);
  assert.ok(readings.length > 0.7 * 20 * 60, 'steering still reads while walking');
});

test('shake: a single knock does not fire it, two swings do', () => {
  const c = createConditioner();
  run(c, 0.5, () => portrait(40));
  const knock = run(c, 1, moving((t) => (t > 0.8 && t < 0.83 ? 30 : 0)), { start: 0.5 });
  assert.equal(knock.shakes.length, 0);
  const double = run(
    c,
    1,
    moving((t) => (t > 1.8 && t < 1.83 ? 30 : t > 1.95 && t < 1.98 ? -30 : 0)),
    { start: 1.5 }
  );
  assert.equal(double.shakes.length, 1);
});

test('shake needs the accelerometer: orientation-derived samples never fire it', () => {
  const c = createConditioner();
  run(c, 0.5, () => portrait(40), { canShake: false });
  const { shakes } = run(c, 1, moving((t) => 22 * Math.sin(2 * Math.PI * 4 * t)), { start: 0.5, canShake: false });
  assert.equal(shakes.length, 0);
});
