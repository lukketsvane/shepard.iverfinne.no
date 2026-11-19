import type { ClipNote, Preset, Track, TrackRole } from './types';
import { annotateTrack } from './meter';

export interface MidiNote { beat: number; dur: number; midi: number; vel: number; channel: number }
export interface MidiTrack { name: string; notes: MidiNote[] }
export interface MidiFile { format: number; ppq: number; bpm: number; tracks: MidiTrack[] }

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0) & 127);
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function vlq(n: number): number[] {
  let x = Math.max(0, Math.round(n));
  const b = [x & 127];
  while ((x >>>= 7) > 0) b.unshift((x & 127) | 128);
  return b;
}

export function writeMidi(preset: Preset, bars = 8): Uint8Array {
  const ppq = 480;
  const beats = preset.meter.beatsPerBar;
  const chunks: number[][] = [];
  const tempo = Math.round(60_000_000 / preset.params.focusBpm);
  const conductor = [0, 255, 81, 3, (tempo >>> 16) & 255, (tempo >>> 8) & 255, tempo & 255];
  chunks.push([...ascii('MTrk'), ...u32(conductor.length + 4), ...conductor, 0, 255, 47, 0]);
  for (let index = 0; index < preset.tracks.length; index++) {
    const track = preset.tracks[index];
    const channel = ['kick', 'snare', 'hat', 'perc'].includes(track.role) ? 9 : index % 9;
    const notes: { tick: number; on: boolean; note: number; vel: number }[] = [];
    for (let bar = 0; bar < bars; bar++) {
      for (const note of track.notes) {
        const tick = Math.round((bar * beats + note.beat) * ppq);
        const midi = Math.max(0, Math.min(127, note.midi));
        notes.push({ tick, on: true, note: midi, vel: Math.max(1, Math.min(127, Math.round(note.vel * 127))) });
        notes.push({ tick: tick + Math.max(1, Math.round(note.dur * ppq)), on: false, note: midi, vel: 0 });
      }
    }
    notes.sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on));
    const data = [0, 255, 3, ...vlq(track.id.length), ...ascii(track.id)];
    let lastTick = 0;
    for (const n of notes) {
      data.push(...vlq(n.tick - lastTick), (n.on ? 0x90 : 0x80) | channel, n.note, n.vel);
      lastTick = n.tick;
    }
    data.push(0, 255, 47, 0);
    chunks.push([...ascii('MTrk'), ...u32(data.length), ...data]);
  }
  return Uint8Array.from([...ascii('MThd'), ...u32(6), ...u16(1), ...u16(chunks.length), ...u16(ppq), ...chunks.flat()]);
}

export function readMidi(data: Uint8Array): MidiFile {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;
  const requireBytes = (n: number) => { if (pos + n > data.length) throw new Error('Truncated MIDI file'); };
  const read8 = () => { requireBytes(1); return data[pos++]; };
  const read16 = () => (read8() << 8) | read8();
  const read32 = () => ((read8() * 0x1000000) + (read8() << 16) + (read8() << 8) + read8()) >>> 0;
  const signature = () => String.fromCharCode(read8(), read8(), read8(), read8());
  const readVlq = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) { const b = read8(); v = (v << 7) | (b & 127); if (!(b & 128)) return v; }
    throw new Error('Invalid MIDI variable length integer');
  };
  if (signature() !== 'MThd') throw new Error('Not a Standard MIDI File');
  const headerLength = read32();
  if (headerLength < 6) throw new Error('Invalid MIDI header');
  const format = read16();
  const count = read16();
  const ppq = read16();
  if (ppq & 0x8000 || ppq === 0) throw new Error('SMPTE MIDI timing is not supported');
  pos += headerLength - 6;
  const tracks: MidiTrack[] = [];
  let bpm = 120;
  for (let t = 0; t < count; t++) {
    if (signature() !== 'MTrk') throw new Error('Invalid MIDI track');
    const length = read32();
    const end = pos + length;
    if (end > data.length) throw new Error('Truncated MIDI track');
    let tick = 0;
    let status = 0;
    let name = `TRACK ${t + 1}`;
    const active = new Map<string, Array<{ tick: number; vel: number }>>();
    const notes: MidiNote[] = [];
    while (pos < end) {
      tick += readVlq();
      let b = read8();
      if (b & 128) { status = b; b = read8(); }
      else if (!status) throw new Error('MIDI running status without previous status');
      if (status === 0xff) {
        const type = b;
        const len = readVlq();
        requireBytes(len);
        if (type === 0x03) name = new TextDecoder().decode(data.subarray(pos, pos + len));
        if (type === 0x51 && len === 3) bpm = 60_000_000 / ((data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2]);
        pos += len;
        status = 0;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const len = readVlq(); requireBytes(len); pos += len; status = 0; continue;
      }
      const eventType = status & 0xf0;
      const channel = status & 0x0f;
      const twoBytes = eventType !== 0xc0 && eventType !== 0xd0;
      const n = b;
      const velocity = twoBytes ? read8() : 0;
      if (eventType === 0x90 && velocity > 0) {
        const key = `${channel}:${n}`;
        const queue = active.get(key) || [];
        queue.push({ tick, vel: velocity });
        active.set(key, queue);
      } else if (eventType === 0x80 || (eventType === 0x90 && velocity === 0)) {
        const key = `${channel}:${n}`;
        const queue = active.get(key);
        const on = queue?.shift();
        if (on) notes.push({ beat: on.tick / ppq, dur: Math.max(1, tick - on.tick) / ppq, midi: n, vel: on.vel / 127, channel });
      }
    }
    pos = end;
    tracks.push({ name, notes: notes.sort((a, b) => a.beat - b.beat) });
  }
  return { format, ppq, bpm, tracks };
}

export function midiToPreset(data: Uint8Array, template: Preset): Preset {
  const midi = readMidi(data);
  const bar = template.meter.beatsPerBar;
  const tracks: Track[] = midi.tracks.filter((t) => t.notes.length > 0).map((t, i) => {
    const channel = t.notes[0].channel;
    const role: TrackRole = channel === 9 ? (i % 2 ? 'snare' : 'kick') : 'keys';
    const notes: ClipNote[] = t.notes.map((n) => ({ beat: ((n.beat % bar) + bar) % bar, dur: n.dur, midi: n.midi, vel: n.vel, rate: 1 }));
    return annotateTrack({ id: t.name, role, lengthBeats: bar, notes, gain: 0.5, center: 0, maxHz: 20 }, template.meter);
  });
  return { ...template, params: { ...template.params, focusBpm: midi.bpm }, tracks };
}
