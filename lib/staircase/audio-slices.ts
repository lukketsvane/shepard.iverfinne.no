export interface SampleSlice {
  start: number;
  duration: number;
  energy: number;
  brightness: number;
}

export function detectSampleSlices(channels: readonly Float32Array[], sampleRate: number): SampleSlice[] {
  if (channels.length === 0 || sampleRate <= 0 || channels[0].length < 2) return [];
  const length = channels[0].length;
  const frame = Math.max(128, Math.round(sampleRate * 0.01));
  const count = Math.ceil(length / frame);
  const rms = new Float32Array(count);
  const brightness = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let power = 0;
    let crossings = 0;
    let previous = 0;
    let samples = 0;
    for (let j = i * frame; j < Math.min(length, (i + 1) * frame); j++) {
      let value = 0;
      for (const channel of channels) value += channel[j] / channels.length;
      power += value * value;
      if (samples && (value < 0) !== (previous < 0)) crossings++;
      previous = value;
      samples++;
    }
    rms[i] = Math.sqrt(power / Math.max(1, samples));
    brightness[i] = crossings / Math.max(1, samples);
  }
  const maximum = rms.reduce((max, n) => Math.max(max, n), 0);
  const duration = length / sampleRate;
  if (maximum < 0.0001) return [];
  const candidates: { index: number; strength: number }[] = [];
  let average = rms[0];
  for (let i = 1; i < count; i++) {
    const rise = Math.max(0, rms[i] - rms[i - 1]);
    const strength = rise / Math.max(0.001, average + maximum * 0.02);
    if (rms[i] > maximum * 0.055 && strength > 0.36) {
      const prior = candidates[candidates.length - 1];
      if (!prior || (i - prior.index) * frame / sampleRate > 0.1) {
        candidates.push({ index: i, strength });
      } else if (strength > prior.strength) {
        prior.index = i;
        prior.strength = strength;
      }
    }
    average = 0.965 * average + 0.035 * rms[i];
  }
  const strongest = candidates.sort((a, b) => b.strength - a.strength).slice(0, 16).sort((a, b) => a.index - b.index);
  const starts = [0, ...strongest.map((c) => Math.max(0, c.index * frame / sampleRate - 0.008))];
  const unique = starts.filter((time, i) => i === 0 || time - starts[i - 1] > 0.08);
  if (unique.length < 3 && duration > 0.6) {
    const n = Math.min(16, Math.max(4, Math.round(duration / 0.4)));
    unique.length = 0;
    for (let i = 0; i < n; i++) unique.push(i * duration / n);
  }
  return unique.map((start, i) => {
    const end = Math.min(duration, start + 0.65, unique[i + 1] ?? duration);
    const stop = Math.max(start + Math.min(0.05, duration - start), end);
    let energy = 0;
    let high = 0;
    let n = 0;
    const first = Math.max(0, Math.floor(start * sampleRate / frame));
    const last = Math.min(count, Math.ceil(stop * sampleRate / frame));
    for (let j = first; j < last; j++) { energy += rms[j]; high += brightness[j]; n++; }
    return { start, duration: stop - start, energy: energy / Math.max(1, n), brightness: high / Math.max(1, n) };
  }).filter((slice) => slice.duration > 0.01);
}
