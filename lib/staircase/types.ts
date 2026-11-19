/**
 * Shared contract for the endless-staircase engine.
 *
 * Vocabulary
 * - layer:  one copy of the music. Adjacent layers differ in tempo by `ratio`.
 * - x:      a layer's distance from the focus tempo, in octaves (log2 of tempo ratio).
 * - window: the fixed bell over x that makes entering and leaving layers inaudible.
 * - stream: the metrical grid an event lives on (bar, beat, eighth, ...). Its absolute
 *           rate in Hz decides whether the event is still heard as rhythm.
 */

/** Tempo ratio between adjacent layers. 2 = tempo octaves, 1.5 = a 3:2 ladder, 3 = triple nesting. */
export type LayerRatio = 2 | 1.5 | 3;

export type DrumRole = 'kick' | 'snare' | 'hat' | 'perc';
export type PitchedRole = 'bass' | 'keys' | 'lead';
export type TrackRole = DrumRole | PitchedRole;

export const DRUM_ROLES: readonly DrumRole[] = ['kick', 'snare', 'hat', 'perc'];

export function isDrumRole(role: TrackRole): role is DrumRole {
  return (DRUM_ROLES as readonly string[]).includes(role);
}

/** Drum sound sets. troy: bronze, skins, sheet metal. aphex: 12-bit sampler grit. hand: cajón, congas, palmas. pure: clicks. */
export type KitId = 'troy' | 'aphex' | 'hand' | 'pure';

/**
 * Sound of pitched tracks. organ, glass and reed are octave-stacked ("Shepard") wavetables;
 * pluck is a plucked steel string. Every pitched voice is played in neighbouring octaves under
 * a fixed bell over log-frequency, so a pitch that keeps rising never jumps when it wraps.
 */
export type TimbreId = 'organ' | 'glass' | 'reed' | 'pluck';

export interface Meter {
  label: string;
  /** Tactus beats per bar. */
  beatsPerBar: number;
  /**
   * How the bar divides, level by level, down to the finest subdivision.
   * 4/4 = [2, 2, 2, 2] (half bar, beat, eighth, sixteenth); 6/8 with two dotted-quarter
   * beats = [2, 3, 2]; the same bar felt in three (the hemiola) = [3, 2, 2].
   */
  divisions: number[];
}

export interface ClipNote {
  /** Onset in beats from the start of the loop, 0 <= beat < lengthBeats. */
  beat: number;
  /** Duration in beats. */
  dur: number;
  /** MIDI note number for pitched roles, fractional for microtones (60.5 = C4 a quarter tone sharp); 0 for drums. */
  midi: number;
  /** 0..1 */
  vel: number;
  /**
   * Notes per beat of the metrical stream this event belongs to. Filled by `annotateTrack`.
   * 0.25 = once per 4/4 bar, 1 = every beat, 4 = sixteenths.
   */
  rate: number;
}

export interface Track {
  id: string;
  role: TrackRole;
  /** Loop length in beats. Tracks of one preset may differ in length. */
  lengthBeats: number;
  notes: ClipNote[];
  /** Linear level. */
  gain: number;
  /** Where this track's window peaks, in octaves relative to the focus tempo (bass below, lead above). */
  center: number;
  /** Events whose stream runs faster than this (Hz) fade out. */
  maxHz: number;
}

export interface MixLevels {
  drums: number;
  melody: number;
  /** Octave-stacked drone that carries the pitch staircase. */
  pad: number;
  /** Barber-pole filter sweep over noise. */
  sweep: number;
  /** Tape layers: the loop replayed by read heads from beat rate up to audio rate. */
  tape: number;
  reverb: number;
}

export interface StairParams {
  /** Tempo (BPM) at which a layer is loudest. This is the tempo you perceive. */
  focusBpm: number;
  /** Target tempo slope in octaves per minute, signed. +2 doubles the tempo every 30 s. 0 holds still. */
  tempoSlope: number;
  /** Target pitch slope in octaves per minute, signed. */
  pitchSlope: number;
  /** Pitch slope follows the tempo slope, as on a tape that is speeding up. */
  pitchLink: boolean;
  /** 0 = continuous glide. n > 0 = pitch moves in steps of n semitones (0.5 = quarter tones). */
  pitchStep: number;
  ratio: LayerRatio;
  /** Standard deviation of the layer window in octaves. */
  spread: number;
  /** Streams faster than this (Hz) are dropped: the point where rhythm turns into flutter. */
  flutterHz: number;
  levels: MixLevels;
  master: number;
  /** Play one layer alone so the trick can be heard. */
  solo: boolean;
}

export interface Preset {
  id: string;
  name: string;
  /** One plain sentence describing what you will hear. */
  blurb: string;
  meter: Meter;
  kit: KitId;
  timbre: TimbreId;
  tracks: Track[];
  params: StairParams;
  /** MIDI note whose pitch class the drone sits on. */
  tonic: number;
  /** Drone chord as semitone offsets from the tonic, e.g. [0, 7]. */
  padChord: number[];
  /** Keep a fixed drone under the moving one: a riser against a held note, as in "Troy". */
  padAnchor: boolean;
  /** Audio file (under /public) played on the tape instead of the drum pulses. */
  tapeUrl?: string;
  /** Words sung by a track: word i belongs to note i of `trackId`. Shown as the music plays. */
  words?: { trackId: string; list: string[] };
  /** Text that goes with the preset, shown in full on request. Paragraphs separated by blank lines. */
  text?: string;
  /** Who or what the preset is after, with sources, in one line. */
  credit?: string;
}

/** Continuous state of the two staircases. */
export interface StairState {
  /** Seconds, on the caller's clock. */
  time: number;
  /** Position within one ratio step, kept in [0, 1). */
  u: number;
  /** Beat phase of the reference layer (index 0). May be negative when decelerating. */
  phi: number;
  /** Number of times `u` has wrapped; `layerId = index + relabels` names a physical layer for its whole life. */
  relabels: number;
  /** Pitch phase in octaves, kept in [0, 1). */
  q: number;
}

export interface LayerInfo {
  /** Stable id of the physical layer. */
  id: number;
  /** Octaves from the focus tempo. */
  xOct: number;
  beatHz: number;
  /** Beat phase of this layer. */
  phase: number;
  /** Window value at centre 0, 0..1. */
  window: number;
}

export interface StairEvent {
  /** Seconds, same clock as StairState.time. */
  time: number;
  trackId: string;
  role: TrackRole;
  noteIndex: number;
  layerId: number;
  xOct: number;
  /** Beat rate of the layer at the onset. */
  beatHz: number;
  /** Absolute rate of the stream this event belongs to: beatHz * note.rate. */
  streamHz: number;
  /** 0..1: how much slower this event's stream is than the busiest stream of its track (a downbeat scores high). */
  accent: number;
  /** Final linear gain after window, ceiling, velocity and track level. */
  gain: number;
  durSec: number;
  midi: number;
  /** Pitch offset in octaves, [0, 1), already quantised when stepping. */
  pitchOct: number;
  /** Pitch glide during the note in octaves per second (0 when stepping). */
  pitchGlide: number;
}

/** One sine component of an octave-stacked tone. */
export interface SpectralPartial {
  hz: number;
  /** 0..1 */
  gain: number;
}

/** What the visualisation needs, sampled at the current audio time. */
export interface Snapshot {
  time: number;
  playing: boolean;
  /** Smoothed slopes actually in effect, octaves per minute. */
  tempoSlope: number;
  pitchSlope: number;
  focusHz: number;
  layers: LayerInfo[];
  /** Layer currently soloed, or null. */
  soloLayerId: number | null;
  /** Drone partials: the pitch staircase. */
  partials: SpectralPartial[];
  /** Tape read heads as loop repetitions per second, with gains. Empty when the tape level is 0. */
  tapeHeads: SpectralPartial[];
  /** Events from the last ~400 ms, for flashes. */
  recent: Array<Pick<StairEvent, 'time' | 'layerId' | 'role' | 'beatHz' | 'gain' | 'trackId' | 'noteIndex' | 'xOct'>>;
}

export interface SlopeTarget {
  /** Octaves per minute. */
  tempo: number;
  pitch: number;
}

/** Public surface of the audio engine, as used by the UI. */
export interface IStaircaseEngine {
  start(): Promise<void>;
  stop(): void;
  isPlaying(): boolean;
  setPreset(preset: Preset): void;
  /** Replace the tracks of the current preset without restarting the staircase (live editing). */
  setTracks(tracks: Track[]): void;
  /** Shallow-merges into the current params (levels are merged one level deep). */
  setParams(patch: ParamsPatch): void;
  getParams(): StairParams;
  /** Momentary push on the tempo slope that decays away: a spin of the barber pole. */
  kick(octavesPerMinute: number): void;
  getSnapshot(): Snapshot;
  /** Replace the tape loop with decoded audio (speech, a recording). Resolves false if it cannot be decoded. */
  loadTapeAudio(data: ArrayBuffer): Promise<boolean>;
  /** Stream of the master output, for recording with MediaRecorder. Null before audio exists. */
  recordingStream(): MediaStream | null;
  /** Render exactly one seamless cycle offline. Rejects when the tempo slope is 0. */
  renderLoop(sampleRate?: number): Promise<{ channels: Float32Array[]; sampleRate: number; seconds: number }>;
  dispose(): void;
}

/** A partial update of the params; `levels` may itself be partial. */
export type ParamsPatch = Partial<Omit<StairParams, 'levels'>> & { levels?: Partial<MixLevels> };
