import type { IStaircaseEngine, Preset, Snapshot, StairEvent, StairParams, StairState, Partial_ } from './types';
import { advanceState, effectivePitchSlope, eventsBetween, getLayers, getPadPartials, initialState, loopSeconds, wrapSeam } from './core';
import { clonePreset } from './presets';
import { detectSampleSlices, type SampleSlice } from './audio-slices';

export class StaircaseEngine implements IStaircaseEngine {
  private preset: Preset;
  private state: StairState = initialState();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private recordingDestination: MediaStreamAudioDestinationNode | null = null;
  private sampleCuts: SampleSlice[] = [];
  private sampleIndex: number[] = []; 
  private pad: Array<{ oscillator: OscillatorNode; gain: GainNode }> = [];
  private tape: AudioBuffer | null = null;
  private tapeHeads = new Map<number, { source: AudioBufferSourceNode; gain: GainNode }>();
  private lastClock = 0;
  private scheduled = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private playing = false;
  private kickValue = 0;
  private recent: StairEvent[] = [];
  private noise: AudioBuffer | null = null;

  constructor(preset: Preset) { this.preset = clonePreset(preset); }

  private params(): StairParams {
    return { ...this.preset.params, tempoSlope: this.preset.params.tempoSlope + this.kickValue };
  }

  private ensureAudio(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.preset.params.master;
      const compressor = this.ctx.createDynamicsCompressor();
      this.compressor = compressor;
      compressor.threshold.value = -12;
      compressor.ratio.value = 6;
      this.master.connect(compressor);
      compressor.connect(this.ctx.destination);
      this.noise = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * 0.45), this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      let seed = 123456789;
      for (let i = 0; i < data.length; i++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        data[i] = (seed >>> 0) / 2147483648 - 1;
      }
    }
    return this.ctx;
  }

  async start(): Promise<void> {
    if (this.playing) return;
    const ctx = this.ensureAudio();
    await ctx.resume();
    this.playing = true;
    this.lastClock = ctx.currentTime;
    this.scheduled = this.state.time;
    this.updatePad();
    this.tick();
    this.timer = setInterval(() => this.tick(), 25);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    this.stopTapeHeads();
    this.pad.forEach((p) => p.gain.gain.setTargetAtTime(0, this.ctx?.currentTime ?? 0, 0.015));
    this.state = initialState();
    this.scheduled = 0;
    this.kickValue = 0;
    this.recent = [];
  }

  isPlaying(): boolean { return this.playing; }

  setPreset(preset: Preset): void {
    const wasPlaying = this.playing;
    this.stop();
    this.preset = clonePreset(preset);
    if (wasPlaying) void this.start();
  }

  setParams(patch: Partial_<StairParams>): void {
    const p = this.preset.params;
    this.preset.params = { ...p, ...patch, levels: { ...p.levels, ...patch.levels } } as StairParams;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.preset.params.master, this.ctx.currentTime, 0.025);
  }

  getParams(): StairParams { return { ...this.preset.params, levels: { ...this.preset.params.levels } }; }

  kick(octavesPerMinute: number): void { this.kickValue += octavesPerMinute; }

  getSnapshot(): Snapshot {
    const p = this.params();
    const layers = getLayers(this.state, p);
    const soloLayerId = p.solo ? layers.reduce((a, b) => Math.abs(a.xOct) < Math.abs(b.xOct) ? a : b).id : null;
    return {
      time: this.state.time, playing: this.playing,
      tempoSlope: p.tempoSlope, pitchSlope: effectivePitchSlope(p),
      focusHz: p.focusBpm / 60, layers, soloLayerId,
      partials: getPadPartials(this.state, { ...this.preset, params: p }),
      tapeHeads: this.tape && p.levels.tape > 0 ? layers.filter((l) => l.window > 0.03).map((l) => ({ hz: l.beatHz / this.preset.params.focusBpm * 60, gain: l.window })) : [],
      recent: this.recent.filter((e) => this.state.time - e.time < 0.4).map((e) => ({ time: e.time, layerId: e.layerId, role: e.role, beatHz: e.beatHz, gain: e.gain })),
    };
  }

  async loadTapeAudio(data: ArrayBuffer): Promise<boolean> {
    try {
      const ctx = this.ensureAudio();
      const decoded = await ctx.decodeAudioData(data.slice(0));
      if (decoded.duration <= 0) return false;
      this.stopTapeHeads();
      this.tape = decoded;
      return true;
    } catch { return false; }
  }

  getRecordingStream(): MediaStream {
    const ctx = this.ensureAudio();
    if (!this.recordingDestination) {
      this.recordingDestination = ctx.createMediaStreamDestination();
      this.compressor!.connect(this.recordingDestination);
    }
    return this.recordingDestination.stream;
  }

  async decodeRecording(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ensureAudio().decodeAudioData(data.slice(0));
  }

  async loadSampleAudio(data: ArrayBuffer): Promise<number> {
    const ctx = this.ensureAudio();
    const buffer = await ctx.decodeAudioData(data.slice(0));
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const cuts = detectSampleSlices(channels, buffer.sampleRate);
    if (cuts.length === 0) throw new Error('No audible samples found in the recording');
    this.tape = buffer;
    this.sampleCuts = cuts;
    this.sampleIndex = cuts.map((_, i) => i).sort((a, b) => cuts[a].brightness - cuts[b].brightness);
    this.stopTapeHeads();
    return cuts.length;
  }

  private tick(): void {
    if (!this.playing || !this.ctx || !this.master) return;
    const ctx = this.ctx;
    const elapsed = Math.max(0, Math.min(0.2, ctx.currentTime - this.lastClock));
    const p = this.params();
    this.state = advanceState(this.state, elapsed, p);
    this.kickValue *= Math.exp(-elapsed * 1.5);
    this.lastClock = ctx.currentTime;
    const now = this.state.time;
    if (this.scheduled < now - 0.2) this.scheduled = now;
    if (this.scheduled < now + 0.12) {
      const from = advanceState(this.state, Math.max(0, this.scheduled - now), p);
      const events = eventsBetween(from, now + 0.12 - this.scheduled, { ...this.preset, params: p });
      for (const ev of events) {
        this.playEvent(ctx, this.master, ev, ctx.currentTime + ev.time - now);
        this.recent.push(ev);
      }
      this.scheduled = now + 0.12;
    }
    this.recent = this.recent.filter((e) => now - e.time < 0.5);
    this.updatePad();
    this.updateTape();
  }

  private playEvent(ctx: BaseAudioContext, output: AudioNode, ev: StairEvent, when: number): void {
    if (ev.gain <= 0) return;
    const gain = ctx.createGain();
    const begin = Math.max(ctx.currentTime, when);
    const duration = Math.min(1.8, Math.max(0.025, ev.durSec));
    gain.gain.setValueAtTime(0, begin);
    gain.gain.linearRampToValueAtTime(Math.min(0.28, ev.gain * 0.16 * (1 + ev.accent)), begin + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, begin + duration);
    gain.connect(output);
    if (this.tape && this.sampleCuts.length) {
      const n = this.sampleIndex.length;
      const pick = ev.role === 'kick' || ev.role === 'bass'
        ? this.sampleIndex[Math.min(n - 1, ev.noteIndex % Math.max(1, Math.ceil(n / 3)))]
        : ev.role === 'hat'
          ? this.sampleIndex[n - 1 - ev.noteIndex % Math.max(1, Math.ceil(n / 3))]
          : this.sampleIndex[(Math.floor(n / 3) + ev.noteIndex) % n];
      const cut = this.sampleCuts[pick];
      const sample = ctx.createBufferSource();
      sample.buffer = this.tape;
      sample.playbackRate.value = Math.max(0.25, Math.min(4, Math.pow(2, ev.xOct + ev.pitchOct)));
      sample.connect(gain);
      const elapsedDuration = Math.min(duration, cut.duration / sample.playbackRate.value);
      gain.gain.cancelScheduledValues(begin);
      gain.gain.setValueAtTime(0, begin);
      gain.gain.linearRampToValueAtTime(Math.min(0.5, ev.gain * 0.4), begin + Math.min(0.006, elapsedDuration / 4));
      gain.gain.setTargetAtTime(0.0001, begin + Math.max(0.01, elapsedDuration - 0.02), 0.007);
      sample.start(begin, cut.start, cut.duration);
      sample.stop(begin + elapsedDuration);
      sample.onended = () => { sample.disconnect(); gain.disconnect(); };
    } else if (ev.role === 'hat' || ev.role === 'snare' || ev.role === 'perc') {
      if (!this.noise) return;
      const sample = ctx.createBufferSource();
      sample.buffer = this.noise;
      const filter = ctx.createBiquadFilter();
      filter.type = ev.role === 'snare' ? 'bandpass' : 'highpass';
      filter.frequency.value = ev.role === 'snare' ? 1200 : 4500;
      sample.connect(filter);
      filter.connect(gain);
      sample.start(begin);
      sample.stop(begin + Math.min(this.noise.duration, duration));
      sample.onended = () => { sample.disconnect(); filter.disconnect(); gain.disconnect(); };
    } else {
      const oscillator = ctx.createOscillator();
      oscillator.type = ev.role === 'kick' ? 'sine' : ev.role === 'bass' ? 'triangle' : 'sawtooth';
      const hz = ev.role === 'kick' ? 55 : 440 * Math.pow(2, (ev.midi - 69) / 12 + ev.pitchOct + ev.xOct);
      const freq = Math.max(25, Math.min(12000, hz));
      oscillator.frequency.setValueAtTime(ev.role === 'kick' ? freq * 2.5 : freq, begin);
      oscillator.frequency.exponentialRampToValueAtTime(ev.role === 'kick' ? freq : Math.max(25, freq * Math.pow(2, ev.pitchGlide * duration)), begin + duration);
      oscillator.connect(gain);
      oscillator.start(begin);
      oscillator.stop(begin + duration + 0.005);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }
  }

  private updatePad(): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const partials = getPadPartials(this.state, this.preset);
    while (this.pad.length < partials.length) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = this.preset.timbre === 'glass' ? 'sine' : 'triangle';
      gain.gain.value = 0;
      oscillator.connect(gain);
      gain.connect(this.master);
      oscillator.start();
      this.pad.push({ oscillator, gain });
    }
    this.pad.forEach((node, i) => {
      const p = partials[i];
      node.oscillator.frequency.setTargetAtTime(p?.hz ?? 110, ctx.currentTime, 0.035);
      node.gain.gain.setTargetAtTime(this.playing ? (p?.gain ?? 0) * this.preset.params.levels.pad * 0.028 : 0, ctx.currentTime, 0.035);
    });
  }

  private stopTapeHeads(): void {
    for (const head of this.tapeHeads.values()) {
      head.gain.gain.setValueAtTime(0, this.ctx?.currentTime ?? 0);
      try { head.source.stop(); } catch {}
      head.source.disconnect();
      head.gain.disconnect();
    }
    this.tapeHeads.clear();
  }

  private updateTape(): void {
    if (!this.ctx || !this.master || !this.tape) return;
    const active = new Set<number>();
    const p = this.params();
    for (const layer of getLayers(this.state, p)) {
      if (layer.window < 0.035 || p.levels.tape <= 0) continue;
      active.add(layer.id);
      let head = this.tapeHeads.get(layer.id);
      if (!head) {
        const source = this.ctx.createBufferSource();
        const gain = this.ctx.createGain();
        source.buffer = this.tape;
        source.loop = true;
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(this.master);
        source.start(0, (this.state.phi * Math.pow(p.ratio, layer.id) * 60 / p.focusBpm) % this.tape.duration);
        head = { source, gain };
        this.tapeHeads.set(layer.id, head);
      }
      head.source.playbackRate.setTargetAtTime(layer.beatHz / (p.focusBpm / 60), this.ctx.currentTime, 0.035);
      head.gain.gain.setTargetAtTime(layer.window * p.levels.tape * 0.13, this.ctx.currentTime, 0.035);
    }
    for (const [id, head] of this.tapeHeads) {
      if (active.has(id)) continue;
      head.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.015);
      head.source.stop(this.ctx.currentTime + 0.1);
      this.tapeHeads.delete(id);
    }
  }

  async renderLoop(sampleRate = 44100): Promise<{ channels: Float32Array[]; sampleRate: number; seconds: number }> {
    const p = this.params();
    const seconds = loopSeconds(p);
    if (seconds > 120) throw new RangeError('Cycle is too long for offline rendering');
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
    let state = initialState();
    for (let start = 0; start < seconds; start += 0.2) {
      const n = Math.min(0.2, seconds - start);
      for (const event of eventsBetween(state, n, { ...this.preset, params: p })) this.playEvent(ctx, master, event, event.time);
      state = advanceState(state, n, p);
    }
    const output = await ctx.startRendering();
    const channels = Array.from({ length: output.numberOfChannels }, (_, i) => output.getChannelData(i).slice());
    for (const channel of channels) wrapSeam(channel, Math.round(sampleRate * 0.03));
    return { channels, sampleRate, seconds };
  }

  dispose(): void {
    this.stop();
    this.pad.forEach((p) => { p.oscillator.stop(); p.oscillator.disconnect(); p.gain.disconnect(); });
    this.pad = [];
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
    this.master = null;
    this.compressor = null;
    this.recordingDestination = null;
  }
}
