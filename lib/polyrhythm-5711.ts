export const POLY_PULSES = [5, 7, 11] as const;
export type PolyPulse = typeof POLY_PULSES[number];
export const EXACT_PPQ = 4620;
export const EXACT_TICKS_PER_BAR = EXACT_PPQ * 4;

export interface PolyHit {
  second: number;
  pulse: PolyPulse;
  step: number;
  bar: number;
}

export function polyrhythmEventsBetween(start: number, end: number, bpm: number): PolyHit[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(bpm) || bpm <= 0 || end <= start) return [];
  const secondsPerBar = 240 / bpm;
  const firstBar = Math.max(0, Math.floor(start / secondsPerBar));
  const lastBar = Math.floor((end - Number.EPSILON) / secondsPerBar);
  const hits: PolyHit[] = [];
  for (let bar = firstBar; bar <= lastBar; bar++) {
    for (const pulse of POLY_PULSES) {
      for (let step = 0; step < pulse; step++) {
        const second = (bar + step / pulse) * secondsPerBar;
        if (second >= start && second < end) hits.push({ second, pulse, step, bar });
      }
    }
  }
  return hits.sort((a, b) => a.second - b.second || a.pulse - b.pulse);
}

function be16(value: number): number[] {
  return [(value >>> 8) & 255, value & 255];
}

function be32(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function ascii(text: string): number[] {
  return Array.from(text, char => char.charCodeAt(0));
}

function vlq(value: number): number[] {
  const result = [value & 127];
  for (let n = value >>> 7; n > 0; n >>>= 7) result.unshift((n & 127) | 128);
  return result;
}

function track(bytes: number[]): number[] {
  return [...ascii('MTrk'), ...be32(bytes.length), ...bytes];
}

export function buildExact5711Midi(bpm = 142, bars = 8): Uint8Array {
  const clampedBpm = Math.max(40, Math.min(240, bpm));
  const barCount = Math.max(1, Math.min(32, Math.round(bars)));
  const microseconds = Math.round(60000000 / clampedBpm);
  const conductor = [
    0, 255, 81, 3, (microseconds >>> 16) & 255, (microseconds >>> 8) & 255, microseconds & 255,
    0, 255, 88, 4, 4, 2, 24, 8,
    0, 255, 47, 0,
  ];
  const channels = [36, 38, 42];
  const tracks = POLY_PULSES.map((pulse, index) => {
    const events: Array<{ tick: number; status: number; note: number; vel: number; order: number }> = [];
    const interval = EXACT_TICKS_PER_BAR / pulse;
    const length = Math.floor(interval / 3);
    for (let bar = 0; bar < barCount; bar++) {
      for (let step = 0; step < pulse; step++) {
        const tick = bar * EXACT_TICKS_PER_BAR + step * interval;
        events.push({ tick, status: 0x99, note: channels[index], vel: 105 - index * 12, order: 1 });
        events.push({ tick: tick + length, status: 0x89, note: channels[index], vel: 0, order: 0 });
      }
    }
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const bytes: number[] = [];
    let previous = 0;
    for (const event of events) {
      bytes.push(...vlq(event.tick - previous), event.status, event.note, event.vel);
      previous = event.tick;
    }
    bytes.push(...vlq(barCount * EXACT_TICKS_PER_BAR - previous), 255, 47, 0);
    return track(bytes);
  });
  const chunks = [track(conductor), ...tracks];
  return new Uint8Array([
    ...ascii('MThd'), ...be32(6), ...be16(1), ...be16(chunks.length), ...be16(EXACT_PPQ),
    ...chunks.flat(),
  ]);
}
