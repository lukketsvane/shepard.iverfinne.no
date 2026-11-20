/**
 * Everything that makes sound. The engine decides *when* and *how loud*; the graph decides
 * what a hit, a note, the drone, the sweep and the tape actually sound like.
 *
 *   drums (glue compressor) --------------------------+
 *   melody (chorus on keys and lead) -----------------+
 *   pad ---+                                          +--> mix --+--------------------> saturation
 *   sweep -+--> gate (fades with the transport) ------+          +--> send -> hall ----> saturation
 *   tape --+
 *
 *   saturation -> subsonic filter -> air -> limiter -> ceiling -> master -> out
 */

import {
  DRUM_ROLES,
  DrumRole,
  KitId,
  MixLevels,
  PitchedRole,
  Preset,
  StairEvent,
  StairParams,
  StairState,
  Track,
  isDrumRole,
} from '../staircase/types';
import { createRandom, pause, renderHall } from './dsp';
import { Pad, Sweep } from './drone';
import { KIT_LEVEL_DB, Kit, VARIANTS, renderDrum } from './kits';
import { TapeLoop, createTapeNode, loopFromAudioBuffer, postFrame, postLoop, renderPulseLoop } from './tape';
import { Ringing } from './ringing';
import { PitchedVoices, loudness } from './voices';

/** State of both staircases at one instant of context time, with the slopes that apply from then on. */
export interface GraphFrame {
  /** AudioContext time at which `state` holds. */
  when: number;
  state: StairState;
  /** Slopes in effect from `when`, octaves per minute. */
  tempoSlope: number;
  pitchSlope: number;
  params: StairParams;
  soloLayerId: number | null;
}

export interface AudioGraph {
  /** Schedule one hit or note to start at context time `when`. */
  trigger(event: StairEvent, when: number): void;
  /** Move the continuous voices (drone, sweep, tape) to this frame. Called once per scheduled segment, in time order. */
  update(frame: GraphFrame): void;
  setLevels(levels: MixLevels, master: number): void;
  /** Fade the continuous voices in or out at context time `when`. */
  setPlaying(playing: boolean, when: number): void;
  /** Swap kit, timbre, drone and tape source (preset.tapeUrl) to another preset. */
  setPreset(preset: Preset): Promise<void>;
  /** Tracks changed while playing; the tape's pulse loop follows them. */
  setTracks(tracks: Track[]): void;
  /** MediaStream of the master output (created on first call). Null when the context cannot make one (offline). */
  recordingStream(): MediaStream | null;
  /** Use decoded audio as the tape loop instead of the preset's pulse pattern. Null restores the pattern. */
  setTapeAudio(buffer: AudioBuffer | null): void;
  dispose(): void;
}

export interface AudioGraphOptions {
  /** First frame, known up front. Required for offline rendering, where the whole render uses one segment. */
  initialFrame?: GraphFrame;
  /** Audio for the tape instead of the preset's own, decoded at the sample rate of the context. */
  tapeAudio?: AudioBuffer;
}

/** Seconds over which level changes and starting or stopping are smoothed. */
const LEVEL_SMOOTHING = 0.02;
const PLAY_FADE_SECONDS = 0.15;

/**
 * The engine already folds levels.drums and levels.melody into every event's gain (so that a
 * silent group is not even scheduled), so those two buses only carry a fixed trim.
 */
const DRUM_TRIM = 0.9;
const MELODY_TRIM = 0.6;
const SWEEP_TRIM = 2.8;
const TAPE_TRIM = 3.5;
const SEND_TRIM = 1.8;
/**
 * Hits and notes quieter than this (-40 dB) are masked by the rest and not worth their nodes.
 * The tails of the layer window produce many of them. They are not simply dropped, which would
 * replace the window's smooth fade to zero by a step: between half the threshold and the
 * threshold they fade out.
 */
const MIN_AUDIBLE_LEVEL = 0.01;

/** How much of a hit or note of this `level` is played: all of it from the threshold up, nothing below half of it. */
export function audibleFraction(level: number): number {
  const x = Math.min(1, Math.max(0, level / MIN_AUDIBLE_LEVEL - 0.5) * 2);
  return x * x * (3 - 2 * x);
}

/** Headroom before the saturator, whose input range is +-1: a unit of mix is half of it. */
const MIX_HEADROOM = 0.35;
const SATURATION_DRIVE = 2;
const HALL_SECONDS = 2.4;
const HALL_T60 = 2.2;
/**
 * Seconds from setPlaying(false) until nothing is left to hear: the notes fade, then the hall
 * rings out. A context suspended earlier would hold the tail and play it into the next start.
 */
export const SETTLE_SECONDS = PLAY_FADE_SECONDS * 2 + HALL_SECONDS;
const SEND_HIGHPASS_HZ = 180;
/** Nothing below this carries music on any speaker, but it eats the limiter's headroom. */
const SUBSONIC_HZ = 30;
/**
 * A lift from the upper mids up. The octave-stacked tones carry almost nothing above 3 kHz, so
 * what the drums and clicks bring there needs it to keep up with the low end, and it is also the
 * part of the spectrum a small speaker plays.
 */
const AIR = { hz: 2500, gainDb: 3.5 };
const LIMITER = { threshold: -6, knee: 3, ratio: 20, attack: 0.002, release: 0.15 };
const GLUE = { threshold: -20, knee: 6, ratio: 3, attack: 0.012, release: 0.12 };

/** How far the two layer parities of each drum are panned apart: the kick stays near the centre, the hat is wide. */
const DRUM_PAN: Record<DrumRole, number> = { kick: 0.1, snare: 0.25, hat: 0.45, perc: 0.4 };
/** Accent at which the harder-struck sample is used instead of the plain one, and the extra level at full accent. */
const BRIGHT_ACCENT = 0.5;
const ACCENT_LEVEL = 0.25;
/** A drum is cut after this many periods of its own stream, so fast layers stay articulate. */
const ARTICULATION_PERIODS = 2.5;
const MIN_HIT_SECONDS = 0.03;
const HIT_FADE_SECONDS = 0.015;
/** Playback-rate scatter that keeps even the same variant from repeating exactly. */
const RATE_SCATTER = 0.03;

/** The preset's loudness trim as a gain. */
function trimGain(preset: Preset): number {
  return Math.pow(10, (preset.trimDb ?? 0) / 20);
}

/** tanh curve over [-1, 1], scaled to reach exactly +-1. */
function tanhCurve(drive: number): Float32Array<ArrayBuffer> {
  const size = 2049;
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / Math.tanh(drive);
  }
  return curve;
}

/**
 * The last guard: linear up to KNEE, then a smooth roll-off that never reaches 1. The limiter
 * reacts after a click has started, so sharp peaks overshoot it by several dB.
 */
const CEILING_KNEE = 0.85;
function ceilingCurve(): Float32Array<ArrayBuffer> {
  const size = 2049;
  const curve = new Float32Array(size);
  const room = 1 - CEILING_KNEE;
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    const over = Math.abs(x) - CEILING_KNEE;
    curve[i] = over <= 0 ? x : Math.sign(x) * (CEILING_KNEE + room * Math.tanh(over / room));
  }
  return curve;
}

function configure(compressor: DynamicsCompressorNode, spec: typeof LIMITER): void {
  compressor.threshold.value = spec.threshold;
  compressor.knee.value = spec.knee;
  compressor.ratio.value = spec.ratio;
  compressor.attack.value = spec.attack;
  compressor.release.value = spec.release;
}

type KitBuffers = Record<DrumRole, Array<{ plain: AudioBuffer; bright: AudioBuffer }>>;

function toBuffers(ctx: BaseAudioContext, kit: Kit): KitBuffers {
  const make = (samples: Float32Array) => {
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    return buffer;
  };
  const result = {} as KitBuffers;
  for (const role of Object.keys(kit) as DrumRole[]) {
    result[role] = kit[role].map((hit) => ({ plain: make(hit.plain), bright: make(hit.bright) }));
  }
  return result;
}

function pitchedRoles(tracks: Track[]): PitchedRole[] {
  const roles = new Set<PitchedRole>();
  for (const track of tracks) {
    if (!isDrumRole(track.role)) roles.add(track.role);
  }
  return [...roles];
}

class Graph implements AudioGraph {
  private preset: Preset;
  private kits = new Map<KitId, KitBuffers>();
  private kit!: KitBuffers;
  /** Counts the calls of prepare, so that a slow one never overwrites a newer one. */
  private prepared = 0;
  private round: Record<DrumRole, number> = { kick: 0, snare: 0, hat: 0, perc: 0 };
  private scatter = createRandom(1);
  private drumInputs = {} as Record<DrumRole, GainNode[]>;
  private voices: PitchedVoices;
  private ringing = new Ringing();

  // master chain
  private drumBus: GainNode;
  private melodyBus: GainNode;
  private padBus: GainNode;
  private sweepBus: GainNode;
  private tapeBus: GainNode;
  /** Fades the continuous voices in and out with the transport. */
  private gate: GainNode;
  /** Everything that is heard goes through here, at the headroom and the preset's loudness trim. */
  private mix: GainNode;
  /** The same for the scheduled drums and notes, which are not gated at their start. */
  private ring: GainNode;
  private send: GainNode;
  private master: GainNode;
  private recorder: MediaStreamAudioDestinationNode | null = null;

  private pad: Pad | null = null;
  private sweep: Sweep | null = null;
  private tapeNode: AudioWorkletNode | null = null;
  private tapePending: Promise<void> | null = null;
  private tapeAudio: AudioBuffer | null;
  /** Counts changes of the tape's source, so a slow load never overwrites a newer one. */
  private tapeVersion = 0;

  private lastFrame: GraphFrame | null;
  private levels: MixLevels | null = null;
  private disposed = false;

  constructor(
    private ctx: BaseAudioContext,
    preset: Preset,
    options: AudioGraphOptions
  ) {
    this.preset = preset;
    this.lastFrame = options.initialFrame ?? null;
    this.tapeAudio = options.tapeAudio ?? null;
    const gain = (value: number) => {
      const node = ctx.createGain();
      node.gain.value = value;
      return node;
    };

    this.master = gain(1);
    const limiter = ctx.createDynamicsCompressor();
    configure(limiter, LIMITER);
    const saturator = ctx.createWaveShaper();
    saturator.curve = tanhCurve(SATURATION_DRIVE);
    saturator.oversample = '2x';
    const subsonic = ctx.createBiquadFilter();
    subsonic.type = 'highpass';
    subsonic.frequency.value = SUBSONIC_HZ;
    const air = ctx.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = AIR.hz;
    air.gain.value = AIR.gainDb;
    // input beyond +-1 is held at the end of the curve, so nothing gets past it
    const ceiling = ctx.createWaveShaper();
    ceiling.curve = ceilingCurve();
    saturator.connect(subsonic);
    subsonic.connect(air);
    air.connect(limiter);
    limiter.connect(ceiling);
    ceiling.connect(this.master);
    this.master.connect(ctx.destination);

    this.mix = gain(MIX_HEADROOM * trimGain(preset));
    const mix = this.mix;
    mix.connect(saturator);
    this.send = gain(0);
    const sendHighpass = ctx.createBiquadFilter();
    sendHighpass.type = 'highpass';
    sendHighpass.frequency.value = SEND_HIGHPASS_HZ;
    const hall = ctx.createConvolver();
    const [left, right] = renderHall(ctx.sampleRate, HALL_SECONDS, HALL_T60, 1);
    const impulse = ctx.createBuffer(2, left.length, ctx.sampleRate);
    impulse.getChannelData(0).set(left);
    impulse.getChannelData(1).set(right);
    hall.buffer = impulse;
    mix.connect(this.send);
    this.send.connect(sendHighpass);
    sendHighpass.connect(hall);
    hall.connect(saturator);

    this.gate = gain(0);
    this.gate.connect(mix);
    this.drumBus = gain(DRUM_TRIM);
    this.melodyBus = gain(MELODY_TRIM);
    this.padBus = gain(0);
    this.sweepBus = gain(0);
    this.tapeBus = gain(0);
    // drums and melody are scheduled notes that end by themselves, so their first hit must not be faded in
    // by the gate; the ring only closes when the transport stops
    this.ring = gain(1);
    this.ring.connect(mix);
    this.drumBus.connect(this.ring);
    this.melodyBus.connect(this.ring);
    for (const bus of [this.padBus, this.sweepBus, this.tapeBus]) bus.connect(this.gate);

    // the glue compressor holds the drums together and lets the first milliseconds of each hit through
    const glue = ctx.createDynamicsCompressor();
    configure(glue, GLUE);
    glue.connect(this.drumBus);
    for (const role of Object.keys(DRUM_PAN) as DrumRole[]) {
      const pan = DRUM_PAN[role];
      this.drumInputs[role] = [-pan, pan].map((position) => {
        const input = gain(1);
        const panner = ctx.createStereoPanner();
        panner.pan.value = position;
        input.connect(panner);
        panner.connect(glue);
        return input;
      });
    }
    this.voices = new PitchedVoices(ctx, this.melodyBus, this.ringing);
  }

  /**
   * Synthesis and buffers for the preset's kit and timbre. A sound is rendered at a time with a
   * pause between, so that switching presets does not hold up the scheduling of the music that
   * is playing; the old kit and timbre play until the new ones are all there.
   */
  async prepare(preset: Preset): Promise<void> {
    const version = ++this.prepared;
    let kit = this.kits.get(preset.kit);
    if (!kit) {
      const rendered = {} as Kit;
      for (const role of DRUM_ROLES) {
        rendered[role] = [];
        for (let variant = 0; variant < VARIANTS; variant++) {
          const rate = this.ctx.sampleRate;
          rendered[role].push({
            plain: renderDrum(preset.kit, role, variant, false, rate),
            bright: renderDrum(preset.kit, role, variant, true, rate),
          });
          await pause();
        }
      }
      kit = toBuffers(this.ctx, rendered);
      this.kits.set(preset.kit, kit);
    }
    await this.voices.setTimbre(preset.timbre, pitchedRoles(preset.tracks));
    // a newer preset chosen in the meantime wins
    if (version !== this.prepared) return;
    this.kit = kit;
    for (const role of DRUM_ROLES) {
      for (const input of this.drumInputs[role]) input.gain.value = Math.pow(10, KIT_LEVEL_DB[preset.kit][role] / 20);
    }
  }

  trigger(event: StairEvent, when: number): void {
    if (isDrumRole(event.role)) {
      this.hit(event, event.role, when);
      return;
    }
    const fade = audibleFraction(loudness(event.gain));
    if (fade > 0) this.voices.play(event, when, fade);
  }

  private hit(event: StairEvent, role: DrumRole, when: number): void {
    const loud = loudness(event.gain) * (1 + ACCENT_LEVEL * event.accent);
    const level = loud * audibleFraction(loud);
    if (level <= 0) return;
    const variant = this.kit[role][this.round[role]++ % VARIANTS];
    const buffer = event.accent >= BRIGHT_ACCENT ? variant.bright : variant.plain;
    const rate = 1 + (this.scatter() - 0.5) * RATE_SCATTER;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const gain = this.ctx.createGain();
    gain.gain.value = level;
    source.connect(gain);
    gain.connect(this.drumInputs[role][((event.layerId % 2) + 2) % 2]);
    source.start(when);
    this.ringing.add(source);

    const natural = buffer.duration / rate;
    const length = Math.max(MIN_HIT_SECONDS, Math.min(natural, ARTICULATION_PERIODS / event.streamHz));
    if (length < natural) {
      const fade = Math.min(HIT_FADE_SECONDS, length / 2);
      gain.gain.setValueAtTime(level, when + length - fade);
      gain.gain.linearRampToValueAtTime(0, when + length);
      source.stop(when + length);
    }
  }

  update(frame: GraphFrame): void {
    this.lastFrame = frame;
    this.pad?.update(frame);
    this.sweep?.update(frame);
    if (this.tapeNode) postFrame(this.tapeNode, frame);
  }

  setLevels(levels: MixLevels, master: number): void {
    const first = this.levels === null;
    this.levels = levels;
    const set = (param: AudioParam, value: number) => {
      if (first) param.value = value;
      else param.setTargetAtTime(value, this.ctx.currentTime, LEVEL_SMOOTHING);
    };
    set(this.padBus.gain, levels.pad);
    set(this.sweepBus.gain, levels.sweep * SWEEP_TRIM);
    set(this.tapeBus.gain, levels.tape * TAPE_TRIM);
    set(this.send.gain, levels.reverb * SEND_TRIM);
    set(this.master.gain, master);

    // voices that are off cost nothing: they are built when first wanted and dropped at level 0
    if (levels.pad > 0 && !this.pad) {
      this.pad = new Pad(this.ctx, this.padBus, this.preset);
      if (this.lastFrame) this.pad.update(this.lastFrame);
    } else if (levels.pad === 0 && this.pad) {
      this.pad.dispose(this.ctx.currentTime);
      this.pad = null;
    }
    if (levels.sweep > 0 && !this.sweep) {
      this.sweep = new Sweep(this.ctx, this.sweepBus);
      if (this.lastFrame) this.sweep.update(this.lastFrame);
    } else if (levels.sweep === 0 && this.sweep) {
      this.sweep.dispose(this.ctx.currentTime);
      this.sweep = null;
    }
    if (levels.tape > 0) void this.ensureTape();
  }

  setPlaying(playing: boolean, when: number): void {
    this.gate.gain.setTargetAtTime(playing ? 1 : 0, when, PLAY_FADE_SECONDS / 4);
    if (playing) {
      this.ring.gain.setValueAtTime(1, when);
    } else {
      // what is already sounding or scheduled fades and is then ended, so it neither rings on nor waits for the next Play
      this.ring.gain.setTargetAtTime(0, when, PLAY_FADE_SECONDS / 4);
      this.ringing.stopAll(when + PLAY_FADE_SECONDS * 2);
    }
  }

  async setPreset(preset: Preset): Promise<void> {
    this.preset = preset;
    this.tapeAudio = null;
    this.mix.gain.setTargetAtTime(MIX_HEADROOM * trimGain(preset), this.ctx.currentTime, LEVEL_SMOOTHING);
    if (this.pad) {
      this.pad.dispose(this.ctx.currentTime);
      this.pad = new Pad(this.ctx, this.padBus, preset);
      if (this.lastFrame) this.pad.update(this.lastFrame);
    }
    await Promise.all([this.prepare(preset), this.tapeSourceChanged()]);
  }

  setTracks(tracks: Track[]): void {
    this.preset = { ...this.preset, tracks };
    void this.voices.setTimbre(this.preset.timbre, pitchedRoles(tracks));
    if (!this.tapeAudio && !this.preset.tapeUrl) void this.tapeSourceChanged();
  }

  setTapeAudio(buffer: AudioBuffer | null): void {
    this.tapeAudio = buffer;
    void this.tapeSourceChanged();
  }

  // -------------------------------------------------------------------------------------------
  // tape

  /** The loop the tape plays: decoded audio if one was loaded, else the preset's file, else its drum pulses. */
  private async loadLoop(): Promise<TapeLoop> {
    const focusHz = (this.lastFrame?.params ?? this.preset.params).focusBpm / 60;
    if (this.tapeAudio) return loopFromAudioBuffer(this.tapeAudio, focusHz);
    if (this.preset.tapeUrl) {
      try {
        const response = await fetch(this.preset.tapeUrl);
        const decoded = await this.ctx.decodeAudioData(await response.arrayBuffer());
        return loopFromAudioBuffer(decoded, focusHz);
      } catch {
        // a missing or undecodable file leaves the pulses, which are always there
      }
    }
    return renderPulseLoop(this.preset.tracks, this.preset.meter, focusHz, this.ctx.sampleRate);
  }

  ensureTape(): Promise<void> {
    this.tapePending ??= this.buildTape();
    return this.tapePending;
  }

  private async buildTape(): Promise<void> {
    const version = this.tapeVersion;
    try {
      const node = await createTapeNode(this.ctx, { frame: this.lastFrame ?? undefined, loop: await this.loadLoop() });
      if (this.disposed) return;
      node.connect(this.tapeBus);
      this.tapeNode = node;
      // the source changed while the worklet was loading: hand it the newer loop
      if (version !== this.tapeVersion) await this.tapeSourceChanged();
    } catch {
      // no AudioWorklet here: the rest of the graph plays on without the tape
    }
  }

  /** The tape's source changed. Once the tape exists, the worklet gets the new loop (unless a newer change overtakes it). */
  private async tapeSourceChanged(): Promise<void> {
    const version = ++this.tapeVersion;
    if (!this.tapeNode) {
      await this.tapePending;
      return;
    }
    const loop = await this.loadLoop();
    if (version === this.tapeVersion && this.tapeNode) postLoop(this.tapeNode, loop);
  }

  recordingStream(): MediaStream | null {
    if (typeof (this.ctx as AudioContext).createMediaStreamDestination !== 'function') return null;
    if (!this.recorder) {
      this.recorder = (this.ctx as AudioContext).createMediaStreamDestination();
      this.master.connect(this.recorder);
    }
    return this.recorder.stream;
  }

  dispose(): void {
    this.disposed = true;
    this.pad?.dispose(this.ctx.currentTime);
    this.sweep?.dispose(this.ctx.currentTime);
    this.tapeNode?.disconnect();
    this.voices.dispose();
    this.master.disconnect();
    this.recorder?.disconnect();
    this.pad = null;
    this.sweep = null;
    this.tapeNode = null;
  }
}

export async function createAudioGraph(
  ctx: BaseAudioContext,
  preset: Preset,
  options: AudioGraphOptions = {}
): Promise<AudioGraph> {
  const graph = new Graph(ctx, preset, options);
  await graph.prepare(preset);
  // Offline rendering has no later moment to wait for the worklet, so build the tape up front
  // when the first frame already asks for it.
  if (options.initialFrame && options.initialFrame.params.levels.tape > 0) await graph.ensureTape();
  return graph;
}
