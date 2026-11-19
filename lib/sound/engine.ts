/**
 * Transport and clock of the staircase. Integrates the state a little ahead of the audio
 * clock, hands every onset to the audio graph, and reports where things are for drawing.
 */

import {
  activeLayers,
  advanceState,
  createState,
  focusHz,
  layersInRange,
  loopSpec,
  pickSoloLayer,
  scheduleSegment,
} from '../staircase/core';
import { SlopeMotion, appliedSlopes, createSlopeMotion, stepSlopes } from '../staircase/control';
import { shepardPartials } from '../staircase/pitch';
import {
  IStaircaseEngine,
  ParamsPatch,
  Preset,
  Snapshot,
  StairEvent,
  StairParams,
  StairState,
  Track,
  isDrumRole,
} from '../staircase/types';
import { AudioGraph, GraphFrame, createAudioGraph } from './graph';

const TICK_MS = 25;
/** How far ahead of the audio clock onsets are scheduled. */
const LOOKAHEAD_SECONDS = 0.15;
/** Longest stretch integrated with one constant slope. */
const MAX_SEGMENT_SECONDS = 0.05;
/** After a stall longer than this (a backgrounded tab), skip ahead silently instead of bursting. */
const MAX_CATCH_UP_SECONDS = 0.5;
const RECENT_EVENT_SECONDS = 0.4;
const HISTORY_SECONDS = 1;
/** Extra time rendered before an exported loop so tails already ring at its first sample. */
const LOOP_PREROLL_SECONDS = 6;
const LONGEST_LOOP_SECONDS = 180;
/** Range of tape read heads in octaves relative to the focus tempo, as drawn. */
export const TAPE_RANGE_OCT: [number, number] = [-3, 9];

interface Segment {
  state: StairState;
  tempoSlope: number;
  pitchSlope: number;
}

function mergeParams(params: StairParams, patch: ParamsPatch): StairParams {
  return { ...params, ...patch, levels: { ...params.levels, ...patch.levels } };
}

export class StaircaseEngine implements IStaircaseEngine {
  private preset: Preset;
  private params: StairParams;
  private ctx: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private graphReady: Promise<void> | null = null;

  private playing = false;
  /** Whether engine time follows the audio clock (true) or the wall clock (no audio available). */
  private audioClock = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Context (or wall-clock) time that corresponds to engine time 0. */
  private origin = 0;
  /** State at the scheduling horizon. */
  private state: StairState = createState();
  private motion: SlopeMotion;
  private soloLayerId: number | null = null;
  private history: Segment[] = [];
  private recent: StairEvent[] = [];

  constructor(preset: Preset) {
    this.preset = preset;
    this.params = mergeParams(preset.params, {});
    this.motion = createSlopeMotion({ tempo: this.params.tempoSlope, pitch: this.params.pitchSlope });
  }

  private clock(): number {
    return this.audioClock && this.ctx ? this.ctx.currentTime : performance.now() / 1000;
  }

  private now(): number {
    return this.playing ? this.clock() - this.origin : this.state.time;
  }

  private ensureGraph(): Promise<void> {
    if (this.graphReady) return this.graphReady;
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return Promise.resolve();
    const ctx = new AudioCtx();
    this.ctx = ctx;
    this.graphReady = createAudioGraph(ctx, this.preset).then((graph) => {
      graph.setLevels(this.params.levels, this.params.master);
      this.graph = graph;
    });
    return this.graphReady;
  }

  async start(): Promise<void> {
    if (this.playing) return;
    const ready = this.ensureGraph();
    // Resume inside the user gesture, before anything is awaited.
    const resumed = this.ctx?.state === 'suspended' ? this.ctx.resume().catch(() => undefined) : null;
    await Promise.all([ready, resumed]);
    if (this.playing) return;

    this.playing = true;
    this.audioClock = this.ctx?.state === 'running';
    this.origin = this.clock() - this.state.time;
    this.history = [];
    this.graph?.setPlaying(true, this.clock());
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (!this.playing) return;
    const now = this.now();
    this.state = this.stateAt(now);
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.history = [];
    this.recent = [];
    this.graph?.setPlaying(false, this.clock());
  }

  isPlaying(): boolean {
    return this.playing;
  }

  setPreset(preset: Preset): void {
    this.preset = preset;
    this.params = mergeParams(preset.params, { master: this.params.master });
    this.motion = createSlopeMotion({ tempo: this.params.tempoSlope, pitch: this.params.pitchSlope });
    // Start the new music from the top of its pattern, without moving the clock.
    this.state = createState(this.state.time);
    this.history = [];
    this.soloLayerId = null;
    this.recent = [];
    void this.graph?.setPreset(preset).then(() => {
      this.graph?.setLevels(this.params.levels, this.params.master);
    });
  }

  setParams(patch: ParamsPatch): void {
    this.params = mergeParams(this.params, patch);
    if (patch.levels || patch.master !== undefined) {
      this.graph?.setLevels(this.params.levels, this.params.master);
    }
    if (!this.params.solo) this.soloLayerId = null;
  }

  getParams(): StairParams {
    return this.params;
  }

  setTracks(tracks: Track[]): void {
    this.preset = { ...this.preset, tracks };
    this.graph?.setTracks(tracks);
  }

  recordingStream(): MediaStream | null {
    return this.graph?.recordingStream() ?? null;
  }

  kick(octavesPerMinute: number): void {
    this.motion = { ...this.motion, kick: this.motion.kick + octavesPerMinute };
  }

  /** Integrate up to the lookahead horizon, scheduling every onset on the way. */
  private tick(): void {
    if (!this.playing) return;
    const now = this.now();
    if (now - this.state.time > MAX_CATCH_UP_SECONDS) {
      // The timer stalled. Carry the state forward without sound; the tape keeps its own time.
      const slopes = appliedSlopes(this.motion, this.params.pitchLink);
      this.state = advanceState(this.state, now - this.state.time, slopes.tempo, slopes.pitch, this.params);
      this.history = [];
    }

    const horizon = now + LOOKAHEAD_SECONDS;
    const target = { tempo: this.params.tempoSlope, pitch: this.params.pitchSlope };
    while (this.state.time < horizon) {
      const dt = Math.min(MAX_SEGMENT_SECONDS, horizon - this.state.time);
      this.motion = stepSlopes(this.motion, target, dt);
      const slopes = appliedSlopes(this.motion, this.params.pitchLink);
      if (this.params.solo) {
        this.soloLayerId = pickSoloLayer(this.soloLayerId, this.state, this.params, slopes.tempo);
      }

      const frame: GraphFrame = {
        when: this.origin + this.state.time,
        state: this.state,
        tempoSlope: slopes.tempo,
        pitchSlope: slopes.pitch,
        params: this.params,
        soloLayerId: this.soloLayerId,
      };
      this.graph?.update(frame);

      const events = scheduleSegment(
        this.state,
        dt,
        slopes.tempo,
        slopes.pitch,
        this.params,
        this.audibleTracks(),
        this.soloLayerId
      );
      for (const event of events) {
        this.graph?.trigger(event, Math.max(this.origin + event.time, this.clock()));
        this.recent.push(event);
      }

      this.history.push({ state: this.state, tempoSlope: slopes.tempo, pitchSlope: slopes.pitch });
      this.state = advanceState(this.state, dt, slopes.tempo, slopes.pitch, this.params);
    }

    this.history = this.history.filter((seg) => seg.state.time > now - HISTORY_SECONDS);
    this.recent = this.recent.filter((event) => event.time > now - RECENT_EVENT_SECONDS);
  }

  /** Tracks with their mix level folded in; silent groups are skipped entirely. */
  private audibleTracks(): Track[] {
    const { drums, melody } = this.params.levels;
    return this.preset.tracks
      .map((track) => ({ ...track, gain: track.gain * (isDrumRole(track.role) ? drums : melody) }))
      .filter((track) => track.gain > 0);
  }

  /** Segment in effect at engine time `time`: the last one that starts at or before it. */
  private segmentAt(time: number): Segment | null {
    let found: Segment | null = null;
    for (const seg of this.history) {
      if (seg.state.time <= time) found = seg;
      else break;
    }
    return found;
  }

  private stateAt(time: number): StairState {
    const seg = this.segmentAt(time);
    if (!seg) return this.state;
    return advanceState(seg.state, time - seg.state.time, seg.tempoSlope, seg.pitchSlope, this.params);
  }

  getSnapshot(): Snapshot {
    const now = this.now();
    const seg = this.playing ? this.segmentAt(now) : null;
    const state = this.playing ? this.stateAt(now) : this.state;
    const slopes = seg
      ? { tempo: seg.tempoSlope, pitch: seg.pitchSlope }
      : appliedSlopes(this.motion, this.params.pitchLink);
    const { levels } = this.params;

    const partials =
      levels.pad > 0
        ? this.preset.padChord.flatMap((offset) => shepardPartials(this.preset.tonic + offset, state.q))
        : [];
    const tapeHeads =
      levels.tape > 0
        ? layersInRange(state, this.params, TAPE_RANGE_OCT[0], TAPE_RANGE_OCT[1]).map((layer) => ({
            hz: layer.beatHz,
            gain: 1,
          }))
        : [];

    return {
      time: now,
      playing: this.playing,
      tempoSlope: slopes.tempo,
      pitchSlope: slopes.pitch,
      focusHz: focusHz(this.params),
      layers: activeLayers(state, this.params),
      soloLayerId: this.soloLayerId,
      partials,
      tapeHeads,
      recent: this.recent
        .filter((event) => event.time <= now)
        .map(({ time, layerId, role, beatHz, gain, trackId, noteIndex, xOct }) => ({
          time,
          layerId,
          role,
          beatHz,
          gain,
          trackId,
          noteIndex,
          xOct,
        })),
    };
  }

  async loadTapeAudio(data: ArrayBuffer): Promise<boolean> {
    await this.ensureGraph();
    if (!this.ctx || !this.graph) return false;
    try {
      const buffer = await this.ctx.decodeAudioData(data.slice(0));
      this.graph.setTapeAudio(buffer);
      return true;
    } catch {
      return false;
    }
  }

  async renderLoop(sampleRate = 44100): Promise<{ channels: Float32Array[]; sampleRate: number; seconds: number }> {
    const spec = loopSpec(this.params);
    if (!spec) throw new Error('A loop needs a tempo slope: with a steady tempo nothing cycles.');
    if (spec.seconds > LONGEST_LOOP_SECONDS) {
      throw new Error(`One cycle would be ${Math.round(spec.seconds)} s long. Use a steeper tempo slope.`);
    }
    const params: StairParams = { ...this.params, solo: false };
    const tempoSlope = params.tempoSlope;
    const preroll = Math.min(LOOP_PREROLL_SECONDS, spec.seconds);
    // Run the same staircase backwards to find the state `preroll` seconds before the loop point.
    let state = advanceState(spec.state, -preroll, tempoSlope, spec.pitchSlope, params);
    state = { ...state, time: 0 };

    const total = preroll + spec.seconds;
    const offline = new OfflineAudioContext(2, Math.ceil(total * sampleRate), sampleRate);
    const first: GraphFrame = {
      when: 0,
      state,
      tempoSlope,
      pitchSlope: spec.pitchSlope,
      params,
      soloLayerId: null,
    };
    const graph = await createAudioGraph(offline, this.preset, { initialFrame: first });
    graph.setLevels(params.levels, params.master);
    graph.setPlaying(true, 0);

    const tracks = this.audibleTracks();
    while (state.time < total) {
      const dt = Math.min(MAX_SEGMENT_SECONDS, total - state.time);
      graph.update({ ...first, when: state.time, state });
      for (const event of scheduleSegment(state, dt, tempoSlope, spec.pitchSlope, params, tracks)) {
        graph.trigger(event, event.time);
      }
      state = advanceState(state, dt, tempoSlope, spec.pitchSlope, params);
    }

    const rendered = await offline.startRendering();
    graph.dispose();
    const skip = Math.round(preroll * sampleRate);
    const length = Math.round(spec.seconds * sampleRate);
    const channels = [0, 1].map((ch) => rendered.getChannelData(ch).slice(skip, skip + length));
    return { channels, sampleRate, seconds: spec.seconds };
  }

  dispose(): void {
    this.stop();
    this.graph?.dispose();
    this.graph = null;
    this.graphReady = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
