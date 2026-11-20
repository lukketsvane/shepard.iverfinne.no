import test from 'node:test';
import assert from 'node:assert/strict';
import { audibleFraction } from './graph';

test('quiet hits and notes fade out smoothly instead of stopping at a threshold', () => {
  assert.equal(audibleFraction(0), 0);
  assert.equal(audibleFraction(0.004), 0);
  assert.equal(audibleFraction(0.01), 1);
  assert.equal(audibleFraction(0.5), 1);
  let last = 0;
  for (let level = 0.004; level <= 0.011; level += 0.0001) {
    const fraction = audibleFraction(level);
    assert.ok(fraction >= last - 1e-12, 'never falls as the level rises');
    assert.ok(fraction - last < 0.04, `no step: ${last} to ${fraction} at ${level}`);
    last = fraction;
  }
});
