/**
 * Everything that makes sound. The engine decides *when* and *how loud*; the graph decides
 * what a hit, a note, the drone, the sweep and the tape actually sound like.
 */

import { MixLevels, Preset, StairEvent, StairParams, StairState, Track } from '../staircase/types';

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
}

export async function createAudioGraph(
  _ctx: BaseAudioContext,
  _preset: Preset,
  _options: AudioGraphOptions = {}
): Promise<AudioGraph> {
  // Placeholder so the engine can run silently until the real graph lands.
  return {
    trigger() {},
    update() {},
    setLevels() {},
    setPlaying() {},
    async setPreset() {},
    setTracks() {},
    recordingStream: () => null,
    setTapeAudio() {},
    dispose() {},
  };
}
