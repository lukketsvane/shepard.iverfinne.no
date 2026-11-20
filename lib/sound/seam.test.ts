import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { closeLoop } from './seam';

/** A 50 Hz tone plus a slow drift that does not repeat with the cycle. */
function signal(length: number, sampleRate: number): Float32Array {
  const x = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    x[i] = 0.5 * Math.sin((2 * Math.PI * 50 * i) / sampleRate) + 0.2 * Math.sin((2 * Math.PI * 3.1 * i) / sampleRate);
  }
  return x;
}

describe('closeLoop', () => {
  const sampleRate = 8000;
  const skip = 4000;
  const length = 12000;
  const fade = 800;
  const rendered = signal(skip + length, sampleRate);

  it('leaves everything before the fade as rendered', () => {
    const cycle = closeLoop(rendered, skip, length, fade);
    assert.equal(cycle.length, length);
    for (let i = 0; i < length - fade; i++) assert.equal(cycle[i], rendered[skip + i]);
  });

  it('ends on the sample that precedes the start, so the repeat is continuous', () => {
    const cycle = closeLoop(rendered, skip, length, fade);
    assert.equal(cycle[length - 1], rendered[skip - 1]);
    const step = Math.abs(rendered[skip] - rendered[skip - 1]);
    assert.ok(Math.abs(cycle[0] - cycle[length - 1]) <= step + 1e-9);
  });

  it('removes the jump a plain cut has when the signal is not periodic in the cycle', () => {
    const cut = rendered.slice(skip, skip + length);
    const jumpBefore = Math.abs(cut[0] - cut[length - 1]);
    const cycle = closeLoop(rendered, skip, length, fade);
    const jumpAfter = Math.abs(cycle[0] - cycle[length - 1]);
    assert.ok(jumpBefore > 0.1, `test signal should have a seam, got ${jumpBefore}`);
    assert.ok(jumpAfter < jumpBefore / 10);
  });

  it('keeps a perfectly periodic signal unchanged', () => {
    // 50 Hz at 8 kHz repeats every 160 samples; both lengths are whole numbers of periods.
    const tone = new Float32Array(skip + length);
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * i) / 160);
    const cycle = closeLoop(tone, skip, length, fade);
    for (let i = 0; i < length; i++) assert.ok(Math.abs(cycle[i] - tone[skip + i]) < 1e-5);
  });

  it('copes with a fade longer than the preroll or the cycle', () => {
    const cycle = closeLoop(rendered, 100, 300, 5000);
    assert.equal(cycle.length, 300);
    assert.equal(cycle[299], rendered[99]);
  });
});
