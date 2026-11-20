/**
 * Make a rendered cycle repeat without a click. Reverb tails and slowly drifting voices are not
 * exactly periodic, so the last sample of the cycle need not run into its first. What the first
 * sample really follows is the audio just before it (the preroll), so the end of the cycle is
 * faded into that: its last sample becomes the preroll's last, which flows straight into the first.
 */
export function closeLoop(rendered: Float32Array, skip: number, length: number, fadeSamples: number): Float32Array {
  const cycle = rendered.slice(skip, skip + length);
  const n = Math.min(fadeSamples, skip, length);
  for (let i = 0; i < n; i++) {
    const weight = (i + 1) / n;
    cycle[length - n + i] = (1 - weight) * cycle[length - n + i] + weight * rendered[skip - n + i];
  }
  return cycle;
}
