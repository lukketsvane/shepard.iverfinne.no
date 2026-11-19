import {
  DrumTrackId,
  RissetEngineParams,
  RissetPattern,
  StepCell,
  SubdivisionTier,
  getSubdivisionRetention,
} from './risset-math';

export interface IcctPcmSamples {
  kick: Float32Array;
  scrape: Float32Array;
  hat: Float32Array;
  stab: Float32Array;
}

/**
 * Converts MIDI note number (0..127) to frequency in Hz (A4 = 440 Hz).
 */
export function midiToFreq(midiNote: number): number {
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

/**
 * Deterministic PRNG (Mulberry32) so synthesized Casio FZ-10M 12-bit industrial
 * sample buffers are 100% reproducible across Web Audio and WAV export.
 */
function createSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Emulates Casio FZ-10M (1987/1995 RDJ sampler) 12-bit amplitude quantization
 * and sample-rate decimation (~18 kHz grit) with soft tape saturation.
 */
function quantizeFz10m(sample: number): number {
  const driven = Math.tanh(sample * 1.45);
  const levels = 2048; // 12-bit signed (-2048..2047)
  return Math.round(driven * levels) / levels;
}

/**
 * Synthesizes the four signature Aphex Twin "Icct Hedral" (1995) PCM sample buffers:
 * 1. `kick`: Heavy FZ-10M saturated sub-drum + bowed contrabass transient tuned to D#1 (38.89 Hz)
 * 2. `scrape`: Iconic industrial sheet-metal scrape snare / bit-crushed shrapnel burst
 * 3. `hat`: Crisp sample-held 12-bit metallic micro-tick
 * 4. `stab`: Icy D# minor cluster organ/string chord one-shot (D#4 + F#4 + A#4 + B4)
 */
export function generateIcctPcmSamples(sampleRate = 44100): IcctPcmSamples {
  const rng = createSeededRng(0x1cc71995);
  const holdFactor = Math.max(1, Math.round(sampleRate / 18000));

  // 1. FZ-10M Industrial Sub Kick (0.28s)
  const kickLen = Math.floor(sampleRate * 0.28);
  const kick = new Float32Array(kickLen);
  let phase = 0;
  let heldNoise = 0;
  for (let i = 0; i < kickLen; i++) {
    const t = i / sampleRate;
    if (i % holdFactor === 0) heldNoise = rng() * 2 - 1;
    // Pitch sweep from 168 Hz down to D#1 (38.891 Hz)
    const freq = 38.891 + 130 * Math.exp(-t * 36);
    phase += (2 * Math.PI * freq) / sampleRate;
    const body = Math.sin(phase) + 0.28 * Math.sin(phase * 2.02);
    const click = heldNoise * Math.exp(-t * 95) * 0.55;
    const env = Math.exp(-t * 11.5);
    kick[i] = quantizeFz10m((body * 0.85 + click) * env);
  }

  // 2. Iconic Icct Hedral Metallic Sheet-Scrape Snare (0.26s)
  const scrapeLen = Math.floor(sampleRate * 0.26);
  const scrape = new Float32Array(scrapeLen);
  // Inharmonic steel plate modal frequencies (D# minor industrial tension)
  const modes = [311.13, 478.5, 739.99, 1146.0, 1782.0, 2637.0];
  const modePhases = new Float64Array(modes.length);
  let scrapeHold = 0;
  const combDelay = Math.max(8, Math.floor(sampleRate / 622.25)); // D#5 metallic comb
  const combBuf = new Float32Array(combDelay);
  let combIdx = 0;

  for (let i = 0; i < scrapeLen; i++) {
    const t = i / sampleRate;
    if (i % holdFactor === 0) {
      scrapeHold = rng() * 2 - 1;
    }
    let modalSum = 0;
    for (let m = 0; m < modes.length; m++) {
      // Slight upward metallic bow/scrape FM bend
      const fm = 1 + 0.035 * scrapeHold * Math.exp(-t * 18);
      modePhases[m] += (2 * Math.PI * modes[m] * fm) / sampleRate;
      modalSum +=
        (Math.sin(modePhases[m]) / (1 + m * 0.42)) *
        Math.exp(-t * (12 + m * 4.5));
    }

    // Bowed / scraped comb-filtered shrapnel noise with bowed attack ramp (8ms)
    const attack = Math.min(1, t / 0.007);
    const rawExcite = scrapeHold * attack * Math.exp(-t * 13.5);
    const delayed = combBuf[combIdx];
    const combed = rawExcite + 0.66 * delayed;
    combBuf[combIdx] = combed;
    combIdx = (combIdx + 1) % combDelay;

    scrape[i] = quantizeFz10m(combed * 0.46 + modalSum * 0.38);
  }

  // 3. 12-Bit Sample-Aliased Metallic Tick / Hat (0.075s)
  const hatLen = Math.floor(sampleRate * 0.075);
  const hat = new Float32Array(hatLen);
  const hatRatios = [1244.5, 1975.5, 3322.4, 5187.0];
  const hatPhases = new Float64Array(hatRatios.length);
  let hatHold = 0;
  let prevSample = 0;
  for (let i = 0; i < hatLen; i++) {
    const t = i / sampleRate;
    if (i % (holdFactor + 1) === 0) {
      hatHold = rng() * 2 - 1;
    }
    let ring = 0;
    for (let r = 0; r < hatRatios.length; r++) {
      hatPhases[r] += (2 * Math.PI * hatRatios[r]) / sampleRate;
      ring += Math.sign(Math.sin(hatPhases[r])) * 0.16;
    }
    // Simple 1-pole highpass difference
    const hpNoise = hatHold - prevSample * 0.82;
    prevSample = hatHold;
    const env = Math.exp(-t * 52);
    hat[i] = quantizeFz10m((hpNoise * 0.52 + ring * 0.48) * env);
  }

  // 4. Icy D# Minor Cluster String/Organ One-Shot Stab (0.45s: D#4, F#4, A#4, B4)
  const stabLen = Math.floor(sampleRate * 0.45);
  const stab = new Float32Array(stabLen);
  const chordMidi = [63, 66, 70, 71]; // D#m(add b6) signature Icct Hedral tension
  const chordFreqs = chordMidi.map(midiToFreq);
  const oscPhasesA = new Float64Array(chordFreqs.length);
  const oscPhasesB = new Float64Array(chordFreqs.length);

  for (let i = 0; i < stabLen; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t / 0.014) * Math.exp(-t * 5.8);
    let chordSum = 0;
    for (let c = 0; c < chordFreqs.length; c++) {
      const f = chordFreqs[c];
      oscPhasesA[c] += (2 * Math.PI * f * 0.997) / sampleRate;
      oscPhasesB[c] += (2 * Math.PI * f * 1.003) / sampleRate;
      const sawA = ((oscPhasesA[c] / Math.PI) % 2) - 1;
      const sawB = ((oscPhasesB[c] / Math.PI) % 2) - 1;
      const hollowOrgan = Math.sin(oscPhasesA[c]) * 0.6 + (sawA + sawB) * 0.2;
      chordSum += hollowOrgan * 0.25;
    }
    stab[i] = quantizeFz10m(chordSum * env);
  }

  return { kick, scrape, hat, stab };
}

function encodeVlq(value: number): number[] {
  let v = Math.max(0, Math.floor(value));
  const bytes = [v & 0x7f];
  v >>>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return bytes;
}

function writeAscii(str: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    out.push(str.charCodeAt(i) & 0x7f);
  }
  return out;
}

function writeUint32BE(val: number): number[] {
  return [
    (val >>> 24) & 0xff,
    (val >>> 16) & 0xff,
    (val >>> 8) & 0xff,
    val & 0xff,
  ];
}

function writeUint16BE(val: number): number[] {
  return [(val >>> 8) & 0xff, val & 0xff];
}

interface MidiNoteEvent {
  tick: number;
  type: 'on' | 'off';
  channel: number;
  note: number;
  velocity: number;
}

function buildMidiTrackChunk(
  trackName: string,
  programNumber: number | null,
  channel: number,
  events: MidiNoteEvent[],
  tempoBpm?: number,
  beatsPerBar?: number
): Uint8Array {
  const data: number[] = [];

  // Track Name meta event (FF 03 len text)
  const nameBytes = writeAscii(trackName);
  data.push(0x00, 0xff, 0x03, nameBytes.length, ...nameBytes);

  // Optional conductor meta events (Tempo + Time Signature)
  if (typeof tempoBpm === 'number') {
    const mpqn = Math.max(
      1,
      Math.round(60_000_000 / Math.max(30, Math.min(300, tempoBpm)))
    );
    data.push(
      0x00,
      0xff,
      0x51,
      0x03,
      (mpqn >>> 16) & 0xff,
      (mpqn >>> 8) & 0xff,
      mpqn & 0xff
    );
    const num = beatsPerBar === 2 ? 6 : 4;
    const denPow = beatsPerBar === 2 ? 3 : 2; // 2^3 = 8 (6/8) or 2^2 = 4 (4/4)
    data.push(0x00, 0xff, 0x58, 0x04, num, denPow, 0x18, 0x08);
  }

  if (programNumber !== null && channel !== 9) {
    data.push(0x00, 0xc0 | (channel & 0x0f), programNumber & 0x7f);
  }

  const sorted = [...events].sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    // Process Note Off before Note On at identical tick to avoid hanging re-triggers
    if (a.type !== b.type) return a.type === 'off' ? -1 : 1;
    return a.note - b.note;
  });

  let lastTick = 0;
  for (const ev of sorted) {
    const delta = Math.max(0, ev.tick - lastTick);
    lastTick = ev.tick;
    data.push(...encodeVlq(delta));
    const status =
      (ev.type === 'on' ? 0x90 : 0x80) | (ev.channel & 0x0f);
    const note = Math.max(0, Math.min(127, Math.round(ev.note)));
    const vel =
      ev.type === 'on'
        ? Math.max(1, Math.min(127, Math.round(ev.velocity)))
        : 0;
    data.push(status, note, vel);
  }

  // End of Track (FF 2F 00)
  data.push(0x00, 0xff, 0x2f, 0x00);

  const header = [...writeAscii('MTrk'), ...writeUint32BE(data.length)];
  return new Uint8Array([...header, ...data]);
}

/**
 * Exports a spec-compliant Standard MIDI File (Format 1, 480 PPQ) containing:
 * - Track 0: Conductor Tempo & Meter
 * - Track 1: Icct Hedral / Glass Ostinato Arpeggio (Ch 1, Strings/Harp)
 * - Track 2: Sub Bass Sequence in D# Minor (Ch 2, Synth Bass)
 * - Track 3: 3:2 Hemiola / Icy Pipe Organ Cluster (Ch 3, Church Organ)
 * - Track 4: FZ-10M Industrial Drum Map (Ch 10 GM Percussion)
 * - Track 5: Risset 2:1 Double-Time Octave Layer (with Dropped Subdivision velocity curve)
 */
export function buildStandardMidiFile(
  pattern: RissetPattern,
  params: RissetEngineParams,
  bars = 8
): Uint8Array {
  const ppq = 480;
  const steps = pattern.stepsPerBar;
  const barTicks = steps === 12 ? ppq * 3 : ppq * 4;
  const stepTicks = Math.floor(barTicks / steps);
  const totalBars = Math.max(2, Math.min(32, Math.round(bars)));

  const ostinatoEvents: MidiNoteEvent[] = [];
  const bassEvents: MidiNoteEvent[] = [];
  const hemiolaEvents: MidiNoteEvent[] = [];
  const drumEvents: MidiNoteEvent[] = [];
  const rissetDoubleEvents: MidiNoteEvent[] = [];

  const defaultOstinatoNotes = [
    63, 66, 70, 71, 63, 66, 70, 73, 63, 66, 70, 71, 68, 66, 65, 62,
  ];
  const defaultBassNotes = [39, 39, 42, 42, 39, 39, 40, 39, 39, 39, 42, 34, 39, 39, 34, 39];
  const defaultHemiolaNotes = [75, 78, 71, 70, 76];

  for (let b = 0; b < totalBars; b++) {
    const barStart = b * barTicks;
    const cycleNorm = b / totalBars; // Sweeps 0..1 across exported bars to encode subdivision thinning

    for (let s = 0; s < steps; s++) {
      const tick = barStart + s * stepTicks;

      // 1. High / Ostinato Lead
      const highCell = pattern.tracks.high[s];
      if (highCell?.active) {
        const note =
          highCell.midiNote ??
          defaultOstinatoNotes[s % defaultOstinatoNotes.length];
        const vel = Math.round(highCell.velocity * 112);
        ostinatoEvents.push(
          { tick, type: 'on', channel: 0, note, velocity: vel },
          {
            tick: tick + Math.max(40, Math.floor(stepTicks * 0.82)),
            type: 'off',
            channel: 0,
            note,
            velocity: 0,
          }
        );
        // Industrial 12-bit hi-hat on GM Drum Ch 10 (index 9)
        drumEvents.push(
          {
            tick,
            type: 'on',
            channel: 9,
            note: s % 4 === 0 ? 44 : 42,
            velocity: Math.round(highCell.velocity * 92),
          },
          {
            tick: tick + Math.floor(stepTicks * 0.5),
            type: 'off',
            channel: 9,
            note: s % 4 === 0 ? 44 : 42,
            velocity: 0,
          }
        );
      }

      // 2. Low / Bass + Kick
      const lowCell = pattern.tracks.low[s];
      if (lowCell?.active) {
        const bassNote =
          lowCell.midiNote ?? defaultBassNotes[s % defaultBassNotes.length];
        const vel = Math.round(lowCell.velocity * 120);
        bassEvents.push(
          { tick, type: 'on', channel: 1, note: bassNote, velocity: vel },
          {
            tick: tick + Math.floor(stepTicks * 1.6),
            type: 'off',
            channel: 1,
            note: bassNote,
            velocity: 0,
          }
        );
        drumEvents.push(
          { tick, type: 'on', channel: 9, note: 36, velocity: vel },
          {
            tick: tick + Math.floor(stepTicks * 0.75),
            type: 'off',
            channel: 9,
            note: 36,
            velocity: 0,
          }
        );
      }

      // 3. Mid / FZ-10M Metallic Scrape Snare
      const midCell = pattern.tracks.mid[s];
      if (midCell?.active) {
        const drumNote = midCell.midiNote ?? (midCell.tier <= 1 ? 38 : 40);
        const vel = Math.round(midCell.velocity * 118);
        drumEvents.push(
          { tick, type: 'on', channel: 9, note: drumNote, velocity: vel },
          {
            tick: tick + Math.floor(stepTicks * 0.75),
            type: 'off',
            channel: 9,
            note: drumNote,
            velocity: 0,
          }
        );
      }

      // 4. Hemiola / Cluster Organ Stabs
      const hemiCell = pattern.tracks.hemiola[s];
      if (hemiCell?.active && params.hemiolaMix > 0.02) {
        const hemiNote =
          hemiCell.midiNote ??
          defaultHemiolaNotes[s % defaultHemiolaNotes.length];
        const vel = Math.max(
          12,
          Math.round(hemiCell.velocity * params.hemiolaMix * 115)
        );
        hemiolaEvents.push(
          { tick, type: 'on', channel: 2, note: hemiNote, velocity: vel },
          {
            tick: tick + Math.floor(stepTicks * 2.4),
            type: 'off',
            channel: 2,
            note: hemiNote,
            velocity: 0,
          }
        );
      }
    }

    // 5. Risset Double-Time 2:1 Octave Stream (2 bars compressed into 1 bar, thinned by Dropped Subdivisions)
    const doubleStepTicks = Math.max(20, Math.floor(stepTicks / 2));
    const uDouble = 2.0 + cycleNorm * 1.6; // Sweeps upper Risset octave [2.0 .. 3.6]
    for (let rep = 0; rep < 2; rep++) {
      for (let s = 0; s < steps; s++) {
        const cell = pattern.tracks.high[s];
        if (!cell?.active) continue;
        const retention = getSubdivisionRetention(
          uDouble,
          Math.max(3, params.numVoices),
          cell.tier,
          params.droppedSubdivisions
        );
        const bellFade = Math.sin(Math.PI * Math.min(0.98, 0.5 + cycleNorm * 0.45));
        const vel = Math.round(cell.velocity * retention * bellFade * 105);
        if (vel < 10) continue;

        const tick = barStart + (rep * steps + s) * doubleStepTicks;
        const baseNote =
          cell.midiNote ?? defaultOstinatoNotes[s % defaultOstinatoNotes.length];
        const upperNote = Math.min(108, baseNote + 12);
        rissetDoubleEvents.push(
          { tick, type: 'on', channel: 3, note: upperNote, velocity: vel },
          {
            tick: tick + Math.max(18, Math.floor(doubleStepTicks * 0.8)),
            type: 'off',
            channel: 3,
            note: upperNote,
            velocity: 0,
          }
        );
      }
    }
  }

  const chunks: Uint8Array[] = [
    buildMidiTrackChunk(
      'Icct Hedral — Risset Lab Conductor',
      null,
      0,
      [],
      params.centerBpm,
      pattern.beatsPerBar
    ),
    buildMidiTrackChunk('Icct Ostinato Arpeggio (D#m)', 48, 0, ostinatoEvents),
    buildMidiTrackChunk('FZ-10M Industrial Bass', 38, 1, bassEvents),
    buildMidiTrackChunk('Philip Glass Cluster Organ (3:2)', 19, 2, hemiolaEvents),
    buildMidiTrackChunk('FZ-10M Metallic Scrape Drums', null, 9, drumEvents),
    buildMidiTrackChunk('Risset 2:1 Octave Stream', 45, 3, rissetDoubleEvents),
  ];

  const header = new Uint8Array([
    ...writeAscii('MThd'),
    ...writeUint32BE(6),
    ...writeUint16BE(1), // SMF Format 1 (multi-track synchronous)
    ...writeUint16BE(chunks.length),
    ...writeUint16BE(ppq),
  ]);

  let totalBytes = header.length;
  for (const c of chunks) totalBytes += c.length;

  const out = new Uint8Array(totalBytes);
  let offset = 0;
  out.set(header, offset);
  offset += header.length;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Parses an imported Standard MIDI File (.mid) into a RissetPattern so users can
 * drop any Aphex Twin / Philip Glass / custom MIDI clip directly onto the studio.
 */
export function parseStandardMidiFileToPattern(
  bytes: Uint8Array,
  stepsPerBar: 12 | 16 = 16
): { pattern: RissetPattern; detectedBpm: number | null } | null {
  if (bytes.length < 18) return null;
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'MThd') return null;

  const headerLen =
    ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
  const numTracks = (bytes[10] << 8) | bytes[11];
  const division = (bytes[12] << 8) | bytes[13];
  if (division & 0x8000 || division === 0) return null; // Ignore SMPTE frame timecode
  const ppq = division;

  let pos = 8 + headerLen;
  let detectedBpm: number | null = null;
  const extractedNotes: Array<{
    tick: number;
    channel: number;
    note: number;
    velocity: number;
  }> = [];

  for (let t = 0; t < numTracks && pos + 8 <= bytes.length; t++) {
    const trkMagic = String.fromCharCode(
      bytes[pos],
      bytes[pos + 1],
      bytes[pos + 2],
      bytes[pos + 3]
    );
    const trkLen =
      ((bytes[pos + 4] << 24) |
        (bytes[pos + 5] << 16) |
        (bytes[pos + 6] << 8) |
        bytes[pos + 7]) >>>
      0;
    pos += 8;
    if (trkMagic !== 'MTrk') {
      pos += trkLen;
      continue;
    }

    const trkEnd = Math.min(bytes.length, pos + trkLen);
    let cursor = pos;
    let tick = 0;
    let runningStatus = 0;

    while (cursor < trkEnd) {
      let delta = 0;
      while (cursor < trkEnd) {
        const b = bytes[cursor++];
        delta = (delta << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) break;
      }
      tick += delta;
      if (cursor >= trkEnd) break;

      let status = bytes[cursor];
      if (status < 0x80) {
        status = runningStatus;
      } else {
        cursor++;
        if (status < 0xf0) runningStatus = status;
      }

      if (status === 0xff) {
        if (cursor >= trkEnd) break;
        const metaType = bytes[cursor++];
        let metaLen = 0;
        while (cursor < trkEnd) {
          const b = bytes[cursor++];
          metaLen = (metaLen << 7) | (b & 0x7f);
          if ((b & 0x80) === 0) break;
        }
        if (metaType === 0x51 && metaLen === 3 && cursor + 3 <= trkEnd) {
          const mpqn =
            (bytes[cursor] << 16) | (bytes[cursor + 1] << 8) | bytes[cursor + 2];
          if (mpqn > 0 && detectedBpm === null) {
            detectedBpm = Math.round(60_000_000 / mpqn);
          }
        }
        cursor += metaLen;
      } else if (status === 0xf0 || status === 0xf7) {
        let sysexLen = 0;
        while (cursor < trkEnd) {
          const b = bytes[cursor++];
          sysexLen = (sysexLen << 7) | (b & 0x7f);
          if ((b & 0x80) === 0) break;
        }
        cursor += sysexLen;
      } else {
        const highNibble = status & 0xf0;
        const ch = status & 0x0f;
        if (highNibble === 0xc0 || highNibble === 0xd0) {
          cursor += 1;
        } else if (cursor + 2 <= trkEnd) {
          const d1 = bytes[cursor++];
          const d2 = bytes[cursor++];
          if (highNibble === 0x90 && d2 > 0) {
            extractedNotes.push({
              tick,
              channel: ch,
              note: d1,
              velocity: d2 / 127,
            });
          }
        } else {
          break;
        }
      }
    }

    pos = trkEnd;
  }

  if (extractedNotes.length === 0) return null;

  const emptyRow = (): StepCell[] =>
    Array.from({ length: stepsPerBar }, () => ({
      active: false,
      tier: 2 as SubdivisionTier,
      velocity: 0.75,
    }));

  const tracks: Record<DrumTrackId, StepCell[]> = {
    low: emptyRow(),
    mid: emptyRow(),
    high: emptyRow(),
    hemiola: emptyRow(),
  };

  const barTicks = stepsPerBar === 12 ? ppq * 3 : ppq * 4;
  const stepTicks = barTicks / stepsPerBar;

  // Map first 2 bars of MIDI notes into our 4 Risset tracks by register / GM drum channel
  const maxImportTick = barTicks * 2;
  for (const n of extractedNotes) {
    if (n.tick >= maxImportTick) continue;
    const stepIdx = Math.round(n.tick / stepTicks) % stepsPerBar;
    const tier: SubdivisionTier =
      stepIdx % 4 === 0 ? 0 : stepIdx % 2 === 0 ? 1 : 2;
    const vel = Math.max(0.45, Math.min(1, n.velocity));

    if (n.channel === 9) {
      // GM Percussion mapping
      if (n.note <= 37 || n.note === 41 || n.note === 45) {
        tracks.low[stepIdx] = { active: true, tier, velocity: vel };
      } else if (n.note === 38 || n.note === 39 || n.note === 40) {
        tracks.mid[stepIdx] = { active: true, tier, velocity: vel, midiNote: n.note };
      } else {
        tracks.high[stepIdx] = {
          active: true,
          tier,
          velocity: vel,
          midiNote: tracks.high[stepIdx].midiNote,
        };
      }
    } else if (n.note < 48) {
      tracks.low[stepIdx] = { active: true, tier, velocity: vel, midiNote: n.note };
    } else if (n.note >= 72) {
      tracks.hemiola[stepIdx] = {
        active: true,
        tier: stepIdx % 3 === 0 ? 1 : tier,
        velocity: vel,
        midiNote: n.note,
      };
    } else {
      tracks.high[stepIdx] = { active: true, tier, velocity: vel, midiNote: n.note };
    }
  }

  return {
    pattern: {
      stepsPerBar,
      beatsPerBar: stepsPerBar === 12 ? 2 : 4,
      meterLabel: 'Imported MIDI Ostinato',
      tracks,
    },
    detectedBpm,
  };
}

/**
 * Encodes a mono 16-bit PCM RIFF WAVE file containing:
 * - 1 full bar of the 142 BPM Icct Hedral FZ-10M drum + D#m ostinato loop, followed by
 * - 4 clean DJ/sampler-ready one-shots (FZ-10M Kick, Metallic Scrape Snare, 12-Bit Hat, D#m Chord Stab)
 */
export function buildIcctWavSamplePack(
  bpm = 142,
  sampleRate = 44100
): Uint8Array {
  const samples = generateIcctPcmSamples(sampleRate);
  const safeBpm = Math.max(60, Math.min(220, bpm));
  const barSec = (60 / safeBpm) * 4;
  const stepSec = barSec / 16;

  // Total duration: 1 bar loop + 0.25s gap + 4 spaced one-shot hits (0.55s spacing)
  const totalSec = barSec + 0.25 + 4 * 0.55;
  const totalFrames = Math.ceil(totalSec * sampleRate);
  const mix = new Float32Array(totalFrames);

  const mixIn = (src: Float32Array, startSec: number, gain: number, rate = 1) => {
    const startFrame = Math.max(0, Math.floor(startSec * sampleRate));
    const outLen = Math.floor(src.length / rate);
    for (let i = 0; i < outLen; i++) {
      const dstIdx = startFrame + i;
      if (dstIdx >= totalFrames) break;
      const srcPos = i * rate;
      const idx0 = Math.floor(srcPos);
      const frac = srcPos - idx0;
      const s0 = src[idx0] ?? 0;
      const s1 = src[Math.min(src.length - 1, idx0 + 1)] ?? 0;
      mix[dstIdx] += (s0 + (s1 - s0) * frac) * gain;
    }
  };

  // Bar 1: 16-step Icct Hedral industrial break + D#m stabs
  const kickSteps = [0, 3, 6, 8, 10, 14];
  const scrapeSteps = [4, 7, 11, 12, 15];
  const stabSteps: Array<{ step: number; semitones: number }> = [
    { step: 0, semitones: 0 },
    { step: 6, semitones: 3 },
    { step: 12, semitones: -2 },
  ];

  for (let s = 0; s < 16; s++) {
    const t = s * stepSec;
    mixIn(samples.hat, t, s % 4 === 0 ? 0.55 : 0.34, s % 2 === 0 ? 1.0 : 1.12);
    if (kickSteps.includes(s)) {
      mixIn(samples.kick, t, s === 0 || s === 8 ? 0.92 : 0.72);
    }
    if (scrapeSteps.includes(s)) {
      const isBackbeat = s === 4 || s === 12;
      mixIn(samples.scrape, t, isBackbeat ? 0.88 : 0.48, isBackbeat ? 1.0 : 1.22);
    }
  }
  for (const st of stabSteps) {
    mixIn(
      samples.stab,
      st.step * stepSec,
      0.52,
      Math.pow(2, st.semitones / 12)
    );
  }

  // Stem Tail: Clean isolated FZ-10M One-Shot Kit Hits for sampler slicing
  const oneShotBase = barSec + 0.25;
  mixIn(samples.kick, oneShotBase + 0.0, 0.95);
  mixIn(samples.scrape, oneShotBase + 0.55, 0.92);
  mixIn(samples.hat, oneShotBase + 1.1, 0.85);
  mixIn(samples.stab, oneShotBase + 1.65, 0.9);

  // Encode 16-bit PCM RIFF WAVE
  const dataByteLen = totalFrames * 2;
  const wav = new Uint8Array(44 + dataByteLen);
  const view = new DataView(wav.buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) wav[offset + i] = s.charCodeAt(i);
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, 1, true); // NumChannels = 1 (Mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  writeStr(36, 'data');
  view.setUint32(40, dataByteLen, true);

  for (let i = 0; i < totalFrames; i++) {
    const clamped = Math.max(-1, Math.min(1, Math.tanh(mix[i] * 1.1)));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(44 + i * 2, Math.round(int16), true);
  }

  return wav;
}
