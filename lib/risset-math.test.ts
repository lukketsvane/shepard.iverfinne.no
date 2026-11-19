import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeQuantizedCycle,
  computeTriggersInWindow,
  getBellGain,
  getShepardRiserPartials,
  getSubdivisionRetention,
  getVoicesSnapshotAtTime,
  positiveMod,
} from './risset-math';
import { RISSET_PRESETS, clonePattern, cycleStepCell } from './risset-presets';
import {
  applyOneFingerHorizontalSubdivisions,
  applyOneFingerVerticalTempo,
  createTwoFingerAnchor,
  evaluateTwoFingerGesture,
} from './gesture-math';

test('computeQuantizedCycle enforces integer N0 and exact Stowell-Risset period', () => {
  const spec = computeQuantizedCycle(120, 4, 2, 22);
  assert.equal(spec.baseBpm, 30);
  assert.equal(spec.maxBpm, 480);
  assert.equal(Number.isInteger(spec.quantizedBarsN0), true);
  assert.ok(spec.quantizedBarsN0 >= 1);

  const expectedT = (spec.quantizedBarsN0 * Math.LN2) / spec.baseBarRate;
  assert.ok(Math.abs(spec.exactCycleSeconds - expectedT) < 1e-12);
});

test('all octave voices stay locked in exact 2:1 bar phase in accelerando and decelerando', () => {
  const preset = RISSET_PRESETS[0];
  for (const direction of ['accelerando', 'decelerando'] as const) {
    const params = { ...preset.params, direction };
    for (const sampleTime of [0, 1.37, 5.83, 11.09, 19.44, 27.61]) {
      const snap = getVoicesSnapshotAtTime(
        sampleTime,
        params,
        preset.pattern.stepsPerBar,
        preset.pattern.beatsPerBar
      );

      const sorted = [...snap.voices].sort(
        (a, b) => a.octavePosition - b.octavePosition
      );

      for (let i = 0; i < sorted.length - 1; i++) {
        const lower = sorted[i];
        const higher = sorted[i + 1];

        assert.ok(
          Math.abs(higher.octavePosition - lower.octavePosition - 1.0) < 1e-9
        );
        assert.ok(
          Math.abs(higher.instantaneousBpm / lower.instantaneousBpm - 2.0) <
            1e-9
        );

        const expectedHigherFraction = positiveMod(2 * lower.barFraction, 1);
        const diff = Math.abs(higher.barFraction - expectedHigherFraction);
        const circularDiff = Math.min(diff, 1 - diff);
        assert.ok(
          circularDiff < 1e-9,
          `Expected 2:1 phase lock at t=${sampleTime} (${direction}), got diff=${circularDiff}`
        );
      }
    }
  }
});

test('bell window vanishes cleanly at octave boundaries and peaks at center', () => {
  assert.equal(getBellGain(0, 4, 1.15), 0);
  assert.equal(getBellGain(4, 4, 1.15), 0);
  assert.ok(Math.abs(getBellGain(2, 4, 1.15) - 1.0) < 1e-12);
});

test('dropped subdivisions preserve anchors while progressively thinning inner subdivisions', () => {
  assert.equal(getSubdivisionRetention(3.6, 4, 0, 1.0), 1.0);
  const lowOctaveSub = getSubdivisionRetention(0.5, 4, 2, 0.85);
  const highOctaveSub = getSubdivisionRetention(3.4, 4, 2, 0.85);
  const highOctavePulse = getSubdivisionRetention(3.4, 4, 1, 0.85);

  assert.equal(lowOctaveSub, 1.0);
  assert.ok(highOctaveSub < 0.25);
  assert.ok(highOctaveSub < highOctavePulse);
});

test('chunked lookahead scheduling matches single-window scheduling without drops or duplicates', () => {
  const preset = RISSET_PRESETS[0];
  for (const direction of ['accelerando', 'decelerando'] as const) {
    const params = { ...preset.params, direction };
    const totalWindow = 8.0;
    const monolithic = computeTriggersInWindow(
      0,
      totalWindow,
      10,
      params,
      preset.pattern
    );
    assert.ok(monolithic.length > 40);

    const chunked = [];
    let cursor = 0;
    const step = 0.047;
    while (cursor < totalWindow) {
      const next = Math.min(totalWindow, cursor + step);
      chunked.push(
        ...computeTriggersInWindow(cursor, next, 10, params, preset.pattern)
      );
      cursor = next;
    }

    assert.equal(chunked.length, monolithic.length);
  }
});

test('two-finger vertical, horizontal, pinch, and rotate gestures isolate cleanly with deadzones', () => {
  const baseParams = { ...RISSET_PRESETS[0].params };

  // 1-finger vertical & horizontal
  assert.ok(applyOneFingerVerticalTempo(118, -160, 844) > 118);
  assert.ok(applyOneFingerHorizontalSubdivisions(0.5, 100, 390) > 0.5);

  // Anchor two fingers horizontally spaced by 120px around (195, 422)
  const anchor = createTwoFingerAnchor(
    { x: 135, y: 422 },
    { x: 255, y: 422 },
    baseParams
  );

  // A: Pure two-finger vertical slide up by 140px -> increases Shepard Riser without triggering pinch or rotate
  const upSlide = evaluateTwoFingerGesture(
    anchor,
    { x: 135, y: 282 },
    { x: 255, y: 282 },
    390,
    844
  );
  assert.ok((upSlide.patch.shepardRiserMix ?? 0) > baseParams.shepardRiserMix);
  assert.equal(upSlide.patch.targetCycleSeconds, undefined);
  assert.equal(upSlide.patch.direction, undefined);

  // B: Pure two-finger horizontal slide right by 110px -> increases 3:2 Hemiola without triggering pinch or rotate
  const rightSlide = evaluateTwoFingerGesture(
    anchor,
    { x: 245, y: 422 },
    { x: 365, y: 422 },
    390,
    844
  );
  assert.ok((rightSlide.patch.hemiolaMix ?? 0) > baseParams.hemiolaMix);
  assert.equal(rightSlide.patch.targetCycleSeconds, undefined);
  assert.equal(rightSlide.patch.direction, undefined);

  // C: Pure symmetric pinch outward (distance 120 -> 240) -> increases Cycle Period without pan/rotate
  const spread = evaluateTwoFingerGesture(
    anchor,
    { x: 75, y: 422 },
    { x: 315, y: 422 },
    390,
    844
  );
  assert.ok((spread.patch.targetCycleSeconds ?? 0) > baseParams.targetCycleSeconds);
  assert.equal(spread.patch.hemiolaMix, undefined);

  // D: Pure counter-clockwise two-finger twist (-45 deg) -> switches to decelerando
  const r = 60;
  const ang = -Math.PI / 4;
  const ccw = evaluateTwoFingerGesture(
    anchor,
    { x: 195 - Math.cos(ang) * r, y: 422 - Math.sin(ang) * r },
    { x: 195 + Math.cos(ang) * r, y: 422 + Math.sin(ang) * r },
    390,
    844
  );
  assert.equal(ccw.patch.direction, 'decelerando');

  const cloned = clonePattern(RISSET_PRESETS[0].pattern);
  assert.equal(cycleStepCell(cloned.tracks.low[0]).active, false);
  assert.equal(getShepardRiserPartials(0, 'accelerando', 5).length, 5);
});

test('Icct Hedral preset schedules D# minor MIDI ostinato notes and exports valid SMF .mid & RIFF .wav', async () => {
  const {
    buildIcctWavSamplePack,
    buildStandardMidiFile,
    generateIcctPcmSamples,
    midiToFreq,
    parseStandardMidiFileToPattern,
  } = await import('./icct-midi');

  const icct = RISSET_PRESETS[0];
  assert.equal(icct.id, 'icct-hedral');
  assert.equal(icct.params.centerBpm, 142);
  assert.equal(icct.params.soundKit, 'icct');

  // Verify D#4 = MIDI 63 (~311.13 Hz) and triggers carry midiNote
  assert.ok(Math.abs(midiToFreq(63) - 311.127) < 0.01);
  const events = computeTriggersInWindow(0, 2.0, 0, icct.params, icct.pattern);
  const highWithMidi = events.filter(
    (e) => e.trackId === 'high' && typeof e.midiNote === 'number'
  );
  assert.ok(highWithMidi.length > 0);
  assert.equal(highWithMidi[0].midiNote, 63);

  // Verify Standard MIDI File (.mid) binary header and round-trip import
  const midiBytes = buildStandardMidiFile(icct.pattern, icct.params, 4);
  assert.equal(
    String.fromCharCode(midiBytes[0], midiBytes[1], midiBytes[2], midiBytes[3]),
    'MThd'
  );
  const parsed = parseStandardMidiFileToPattern(midiBytes, 16);
  assert.ok(parsed !== null);
  assert.equal(parsed.detectedBpm, 142);
  assert.equal(parsed.pattern.tracks.high[0].active, true);
  assert.equal(parsed.pattern.tracks.high[0].midiNote, 63);

  // Verify FZ-10M PCM synthesis & 16-bit RIFF WAVE sample pack
  const pcm = generateIcctPcmSamples(22050);
  assert.ok(pcm.scrape.length > 1000);
  const wavBytes = buildIcctWavSamplePack(142, 22050);
  assert.equal(
    String.fromCharCode(wavBytes[0], wavBytes[1], wavBytes[2], wavBytes[3]),
    'RIFF'
  );
  assert.equal(
    String.fromCharCode(wavBytes[8], wavBytes[9], wavBytes[10], wavBytes[11]),
    'WAVE'
  );
});
