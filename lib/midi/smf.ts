/** Reading and writing Standard MIDI Files, in beats and seconds instead of ticks. */

export interface MidiNote {
  /** Onset in quarter-note beats from the start of the file. */
  beat: number;
  /** Duration in beats. */
  dur: number;
  midi: number;
  /** 0..1 */
  vel: number;
  /** 0..15; channel 9 is General MIDI percussion. */
  channel: number;
}

export interface ParsedMidi {
  /** First tempo found, or null when the file sets none. */
  bpm: number | null;
  /** First time signature found, or null when the file sets none. */
  timeSignature: { numerator: number; denominator: number } | null;
  /** Sorted by onset, then pitch. */
  notes: MidiNote[];
  /** Beats until the last note ends. */
  lengthBeats: number;
}

const EXPORT_PPQ = 960;
const EXPORT_BPM = 120;

function readUint32(bytes: Uint8Array, pos: number): number {
  return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
}

/** Parses format 0 and 1 files with metrical (ticks per quarter note) timing. Returns null for anything else. */
export function parseMidi(bytes: Uint8Array): ParsedMidi | null {
  if (bytes.length < 14 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'MThd') return null;
  const headerLength = readUint32(bytes, 4);
  const trackCount = (bytes[10] << 8) | bytes[11];
  const division = (bytes[12] << 8) | bytes[13];
  if (division === 0 || division & 0x8000) return null;

  let bpm: number | null = null;
  let timeSignature: ParsedMidi['timeSignature'] = null;
  const notes: MidiNote[] = [];
  let pos = 8 + headerLength;

  for (let t = 0; t < trackCount && pos + 8 <= bytes.length; t++) {
    const isTrack = String.fromCharCode(...bytes.subarray(pos, pos + 4)) === 'MTrk';
    const end = Math.min(bytes.length, pos + 8 + readUint32(bytes, pos + 4));
    let cursor = pos + 8;
    pos = end;
    if (!isTrack) continue;

    // A damaged file can name events and lengths that run past the track: the track stops there, keeping what was read.
    /** Moves past `count` bytes and returns where they started. */
    const take = (count: number): number => {
      if (count > end - cursor) throw new RangeError('The event runs past the end of its track.');
      cursor += count;
      return cursor - count;
    };
    const byte = (): number => bytes[take(1)];
    /** Variable-length quantity: at most four bytes, and no 32-bit shifts, which would turn a long one negative. */
    const readVarLen = (): number => {
      let value = 0;
      for (let i = 0; i < 4; i++) {
        const next = byte();
        value = value * 128 + (next & 0x7f);
        if (!(next & 0x80)) return value;
      }
      throw new RangeError('A variable-length quantity is longer than four bytes.');
    };

    let tick = 0;
    let runningStatus = 0;
    /** Start tick and velocity of sounding notes, keyed by channel and pitch. */
    const open = new Map<number, Array<{ tick: number; vel: number }>>();

    try {
      while (cursor < end) {
        tick += readVarLen();
        let status = byte();
        if (status & 0x80) {
          if (status < 0xf0) runningStatus = status;
        } else {
          cursor--;
          status = runningStatus;
        }

        if (status === 0xff) {
          const type = byte();
          const length = readVarLen();
          const at = take(length);
          if (type === 0x51 && length === 3 && bpm === null) {
            const microsPerBeat = (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2];
            if (microsPerBeat > 0) bpm = 60_000_000 / microsPerBeat;
          } else if (type === 0x58 && length >= 2 && timeSignature === null) {
            timeSignature = { numerator: bytes[at], denominator: 2 ** bytes[at + 1] };
          }
        } else if (status === 0xf0 || status === 0xf7) {
          take(readVarLen());
        } else {
          const kind = status & 0xf0;
          const channel = status & 0x0f;
          if (kind === 0xc0 || kind === 0xd0) {
            byte();
            continue;
          }
          const data1 = byte();
          const data2 = byte();
          const key = (channel << 7) | data1;
          if (kind === 0x90 && data2 > 0) {
            const stack = open.get(key) ?? [];
            stack.push({ tick, vel: data2 / 127 });
            open.set(key, stack);
          } else if (kind === 0x80 || kind === 0x90) {
            const started = open.get(key)?.shift();
            if (started) {
              notes.push({
                beat: started.tick / division,
                dur: (tick - started.tick) / division,
                midi: data1,
                vel: started.vel,
                channel,
              });
            }
          }
        }
      }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }

  if (notes.length === 0) return null;
  notes.sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  const lengthBeats = notes.reduce((last, n) => Math.max(last, n.beat + n.dur), 0);
  return { bpm, timeSignature, notes, lengthBeats };
}

export interface TimedNote {
  /** Seconds from the start of the file. */
  time: number;
  /** Seconds. */
  dur: number;
  midi: number;
  /** 0..1 */
  vel: number;
  channel: number;
}

function varLen(value: number): number[] {
  const bytes = [value & 0x7f];
  for (let rest = value >>> 7; rest > 0; rest >>>= 7) bytes.unshift((rest & 0x7f) | 0x80);
  return bytes;
}

/**
 * Writes notes with free timing into a single-track file at a fixed 120 BPM, padded to
 * `seconds` so the clip loops at exactly that length.
 */
export function encodeMidi(notes: TimedNote[], seconds: number): Uint8Array {
  const ticksPerSecond = (EXPORT_PPQ * EXPORT_BPM) / 60;
  const toTick = (time: number) => Math.max(0, Math.round(time * ticksPerSecond));
  const endTick = toTick(seconds);

  const messages: Array<{ tick: number; on: boolean; data: number[] }> = [];
  for (const note of notes) {
    const midi = Math.min(127, Math.max(0, Math.round(note.midi)));
    const start = Math.min(toTick(note.time), endTick);
    const stop = Math.min(Math.max(start + 1, toTick(note.time + note.dur)), endTick);
    if (stop <= start) continue;
    const vel = Math.min(127, Math.max(1, Math.round(note.vel * 127)));
    messages.push({ tick: start, on: true, data: [0x90 | note.channel, midi, vel] });
    messages.push({ tick: stop, on: false, data: [0x80 | note.channel, midi, 0] });
  }
  // note-offs first, so a re-struck pitch is released before it sounds again
  messages.sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on));

  const microsPerBeat = Math.round(60_000_000 / EXPORT_BPM);
  const body: number[] = [0x00, 0xff, 0x51, 0x03, microsPerBeat >> 16, (microsPerBeat >> 8) & 0xff, microsPerBeat & 0xff];
  let last = 0;
  for (const message of messages) {
    body.push(...varLen(message.tick - last), ...message.data);
    last = message.tick;
  }
  body.push(...varLen(Math.max(0, endTick - last)), 0xff, 0x2f, 0x00);

  const uint32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  return new Uint8Array([
    ...[0x4d, 0x54, 0x68, 0x64], // MThd
    ...uint32(6),
    0, 0, // format 0
    0, 1, // one track
    EXPORT_PPQ >> 8, EXPORT_PPQ & 0xff,
    ...[0x4d, 0x54, 0x72, 0x6b], // MTrk
    ...uint32(body.length),
    ...body,
  ]);
}
