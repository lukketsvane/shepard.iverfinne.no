export type LayerRatio = 2 | 1.5 | 3;
export type DrumRole = 'kick' | 'snare' | 'hat' | 'perc';
export type PitchedRole = 'bass' | 'keys' | 'lead';
export type TrackRole = DrumRole | PitchedRole;
export const DRUM_ROLES: readonly DrumRole[] = ['kick', 'snare', 'hat', 'perc'];
export function isDrumRole(role: TrackRole): role is DrumRole {
  return (DRUM_ROLES as readonly string[]).includes(role);
}
export type KitId = 'troy' | 'aphex' | 'pure';
export type TimbreId = 'organ' | 'glass' | 'reed';
export interface Meter {
  label: string;
  beatsPerBar: number;
  barDivisions: number[];
  beatDivisions: number[];
}
export interface ClipNote {
  beat: number;
  dur: number;
  midi: number;
  vel: number;
  rate: number;
}
export interface Track {
  id: string;
  role: TrackRole;
  lengthBeats: number;
  notes: ClipNote[];
  gain: number;
  center: number;
  maxHz: number;
}
export interface MixLevels {
  drums: number;
  melody: number;
  pad: number;
  sweep: number;
  tape: number;
  reverb: number;
}
export interface StairParams {
  focusBpm: number;
  tempoSlope: number;
  pitchSlope: number;
  pitchLink: boolean;
  pitchStep: number;
  ratio: LayerRatio;
  spread: number;
  flutterHz: number;
  levels: MixLevels;
  master: number;
  solo: boolean;
}
export interface Preset {
  id: string;
  name: string;
  blurb: string;
  meter: Meter;
  kit: KitId;
  timbre: TimbreId;
  tracks: Track[];
  params: StairParams;
  tonic: number;
  padChord: number[];
}
export interface StairState {
  time: number;
  u: number;
  phi: number;
  relabels: number;
  q: number;
}
export interface LayerInfo {
  id: number;
  xOct: number;
  beatHz: number;
  phase: number;
  window: number;
}
export interface StairEvent {
  time: number;
  trackId: string;
  role: TrackRole;
  noteIndex: number;
  layerId: number;
  xOct: number;
  beatHz: number;
  streamHz: number;
  accent: number;
  gain: number;
  durSec: number;
  midi: number;
  pitchOct: number;
  pitchGlide: number;
}
export interface Partial {
  hz: number;
  gain: number;
}
export interface Snapshot {
  time: number;
  playing: boolean;
  tempoSlope: number;
  pitchSlope: number;
  focusHz: number;
  layers: LayerInfo[];
  soloLayerId: number | null;
  partials: Partial[];
  tapeHeads: Partial[];
  recent: Array<Pick<StairEvent, 'time' | 'layerId' | 'role' | 'beatHz' | 'gain'>>;
}
export interface SlopeTarget {
  tempo: number;
  pitch: number;
}
export type Partial_<T> = { [K in keyof T]?: T[K] extends object ? globalThis.Partial<T[K]> : T[K] };
export interface IStaircaseEngine {
  start(): Promise<void>;
  stop(): void;
  isPlaying(): boolean;
  setPreset(preset: Preset): void;
  setParams(patch: Partial_<StairParams>): void;
  getParams(): StairParams;
  kick(octavesPerMinute: number): void;
  getSnapshot(): Snapshot;
  loadTapeAudio(data: ArrayBuffer): Promise<boolean>;
  loadSampleAudio(data: ArrayBuffer): Promise<number>;
  getRecordingStream(): MediaStream;
  decodeRecording(data: ArrayBuffer): Promise<AudioBuffer>;
  renderLoop(sampleRate?: number): Promise<{ channels: Float32Array[]; sampleRate: number; seconds: number }>;
  dispose(): void;
}
