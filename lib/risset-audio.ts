import {
  DrumTrackId,
  RissetEngineParams,
  RissetPattern,
  ScheduledTriggerEvent,
  SoundKitId,
  computeQuantizedCycle,
  computeTriggersInWindow,
  getShepardRiserPartials,
} from './risset-math';

export interface VisualFlashEvent {
  elapsedTime: number;
  voiceIndex: number;
  octavePosition: number;
  trackId: DrumTrackId;
  stepIndex: number;
  gain: number;
}

interface ShepardOscNode {
  osc: OscillatorNode;
  subHarmonicOsc: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
}

const LOOKAHEAD_INTERVAL_MS = 25;
const SCHEDULE_AHEAD_SECONDS = 0.11;
const NUM_SHEPARD_PARTIALS = 5;

export class RissetAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private riserBus: GainNode | null = null;
  private riserNodes: ShepardOscNode[] = [];

  private isPlaying = false;
  private startAudioTime = 0;
  private startWallTimeSec = 0;
  private pausedElapsedSeconds = 0;
  private scheduledUntilElapsed = 0;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;

  private params: RissetEngineParams;
  private pattern: RissetPattern;
  private recentFlashes: VisualFlashEvent[] = [];

  constructor(initialParams: RissetEngineParams, initialPattern: RissetPattern) {
    this.params = { ...initialParams };
    this.pattern = initialPattern;
  }

  private ensureAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) return null;

      const ctx = new AudioCtx();
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -12;
      compressor.knee.value = 14;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.14;

      const masterGain = ctx.createGain();
      masterGain.gain.value = this.params.masterVolume;

      compressor.connect(masterGain);
      masterGain.connect(ctx.destination);

      this.ctx = ctx;
      this.compressor = compressor;
      this.masterGain = masterGain;
      this.noiseBuffer = this.createNoiseBuffer(ctx);
      this.setupShepardRiserBank(ctx, compressor);
    }
    return this.ctx;
  }

  private createNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 0.5);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private setupShepardRiserBank(ctx: AudioContext, destination: AudioNode) {
    const riserBus = ctx.createGain();
    riserBus.gain.value = 0;
    riserBus.connect(destination);
    this.riserBus = riserBus;
    this.riserNodes = [];

    for (let k = 0; k < NUM_SHEPARD_PARTIALS; k++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';

      const subHarmonicOsc = ctx.createOscillator();
      subHarmonicOsc.type = 'sine';

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 2.6;

      const sawMix = ctx.createGain();
      sawMix.gain.value = 0.28;
      const sineMix = ctx.createGain();
      sineMix.gain.value = 0.72;

      const partialGain = ctx.createGain();
      partialGain.gain.value = 0;

      osc.connect(filter);
      filter.connect(sawMix);
      sawMix.connect(partialGain);

      subHarmonicOsc.connect(sineMix);
      sineMix.connect(partialGain);

      partialGain.connect(riserBus);

      osc.start();
      subHarmonicOsc.start();

      this.riserNodes.push({
        osc,
        subHarmonicOsc,
        filter,
        gain: partialGain,
      });
    }
  }

  public async start(): Promise<void> {
    if (this.isPlaying) return;
    const ctx = this.ensureAudioContext();
    if (ctx) {
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch {
          // Fallback to wall-clock timing if autoplay-gated
        }
      }
      // iOS WebKit silent 1-frame buffer unlock
      try {
        const silent = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = silent;
        src.connect(ctx.destination);
        src.start(0);
      } catch {
        // Ignore if context unavailable
      }
    }

    const nowWall = performance.now() / 1000;
    this.startWallTimeSec = nowWall - this.pausedElapsedSeconds;
    if (ctx) {
      this.startAudioTime = ctx.currentTime - this.pausedElapsedSeconds;
    }
    this.scheduledUntilElapsed = this.pausedElapsedSeconds;
    this.isPlaying = true;

    if (this.riserBus && ctx) {
      const targetRiser = this.params.shepardRiserMix * 0.22;
      this.riserBus.gain.setTargetAtTime(targetRiser, ctx.currentTime, 0.06);
    }

    this.schedulerTick();
    this.schedulerTimer = setInterval(
      () => this.schedulerTick(),
      LOOKAHEAD_INTERVAL_MS
    );
  }

  public pause(): void {
    if (!this.isPlaying) return;
    this.pausedElapsedSeconds = this.getElapsedSeconds();
    this.isPlaying = false;
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.riserBus && this.ctx) {
      this.riserBus.gain.setTargetAtTime(0, this.ctx.currentTime, 0.04);
    }
  }

  public resetCycle(): void {
    this.pausedElapsedSeconds = 0;
    this.recentFlashes = [];
    if (this.isPlaying) {
      const nowWall = performance.now() / 1000;
      this.startWallTimeSec = nowWall;
      if (this.ctx) {
        this.startAudioTime = this.ctx.currentTime;
      }
      this.scheduledUntilElapsed = 0;
    }
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  /**
   * Returns exact elapsed seconds since cycle start.
   * Uses hardware AudioContext clock when running, or high-res performance.now()
   * if AudioContext is suspended (e.g., `?autostart=1` before first gesture).
   */
  public getElapsedSeconds(): number {
    if (!this.isPlaying) {
      return this.pausedElapsedSeconds;
    }
    if (this.ctx && this.ctx.state === 'running') {
      return Math.max(0, this.ctx.currentTime - this.startAudioTime);
    }
    return Math.max(0, performance.now() / 1000 - this.startWallTimeSec);
  }

  public updateParams(nextParams: RissetEngineParams): void {
    const prevCycle = computeQuantizedCycle(
      this.params.centerBpm,
      this.params.numVoices,
      this.pattern.beatsPerBar,
      this.params.targetCycleSeconds
    );
    const nextCycle = computeQuantizedCycle(
      nextParams.centerBpm,
      nextParams.numVoices,
      this.pattern.beatsPerBar,
      nextParams.targetCycleSeconds
    );

    // Preserve normalized cycle phase smoothly when tempo or cycle duration changes!
    if (
      Math.abs(prevCycle.exactCycleSeconds - nextCycle.exactCycleSeconds) >
      1e-4
    ) {
      const currentElapsed = this.getElapsedSeconds();
      const cycleRatio = currentElapsed / prevCycle.exactCycleSeconds;
      const remappedElapsed = cycleRatio * nextCycle.exactCycleSeconds;
      this.pausedElapsedSeconds = remappedElapsed;
      if (this.isPlaying) {
        this.startWallTimeSec = performance.now() / 1000 - remappedElapsed;
        if (this.ctx) {
          this.startAudioTime = this.ctx.currentTime - remappedElapsed;
        }
        this.scheduledUntilElapsed = remappedElapsed;
      }
    }

    this.params = { ...nextParams };

    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(
        this.params.masterVolume,
        this.ctx.currentTime,
        0.025
      );
    }
    if (this.riserBus && this.ctx) {
      const target =
        this.isPlaying && this.params.soloVoiceIndex === null
          ? this.params.shepardRiserMix * 0.22
          : 0;
      this.riserBus.gain.setTargetAtTime(target, this.ctx.currentTime, 0.04);
    }
  }

  public updatePattern(nextPattern: RissetPattern): void {
    const beatsChanged =
      this.pattern.beatsPerBar !== nextPattern.beatsPerBar;
    this.pattern = nextPattern;
    if (beatsChanged) {
      this.scheduledUntilElapsed = this.getElapsedSeconds();
    }
  }

  public getRecentFlashes(currentElapsed: number): VisualFlashEvent[] {
    // Prune flashes older than 0.35s
    this.recentFlashes = this.recentFlashes.filter(
      (f) => currentElapsed - f.elapsedTime < 0.35 && f.elapsedTime <= currentElapsed + 0.2
    );
    return this.recentFlashes;
  }

  public dispose(): void {
    this.pause();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }

  private schedulerTick(): void {
    if (!this.isPlaying) return;

    const currentElapsed = this.getElapsedSeconds();
    // Guard against tab-backgrounding leaps (> 0.5s)
    if (currentElapsed - this.scheduledUntilElapsed > 0.5) {
      this.scheduledUntilElapsed = currentElapsed;
    }

    const windowStart = this.scheduledUntilElapsed;
    const windowEnd = currentElapsed + SCHEDULE_AHEAD_SECONDS;

    if (windowEnd > windowStart) {
      const audioBase =
        this.ctx && this.ctx.state === 'running'
          ? this.startAudioTime
          : currentElapsed;

      const triggers = computeTriggersInWindow(
        windowStart,
        windowEnd,
        audioBase,
        this.params,
        this.pattern
      );

      for (const ev of triggers) {
        const eventElapsed = ev.audioTime - audioBase;
        this.recentFlashes.push({
          elapsedTime: eventElapsed,
          voiceIndex: ev.voiceIndex,
          octavePosition: ev.octavePosition,
          trackId: ev.trackId,
          stepIndex: ev.stepIndex,
          gain: ev.gain,
        });

        if (this.ctx && this.ctx.state === 'running' && this.compressor) {
          this.triggerPercussionVoice(this.ctx, this.compressor, ev);
        }
      }

      this.scheduledUntilElapsed = windowEnd;
    }

    // Update continuous Shepard Pitch Riser frequencies & bell gains
    if (
      this.ctx &&
      this.ctx.state === 'running' &&
      this.riserNodes.length === NUM_SHEPARD_PARTIALS
    ) {
      const cycleSpec = computeQuantizedCycle(
        this.params.centerBpm,
        this.params.numVoices,
        this.pattern.beatsPerBar,
        this.params.targetCycleSeconds
      );
      const cycleProgress =
        (currentElapsed / cycleSpec.exactCycleSeconds) % 1.0;
      const partials = getShepardRiserPartials(
        cycleProgress,
        this.params.direction,
        NUM_SHEPARD_PARTIALS,
        36.708 // D1 Dorian/Phrygian root
      );

      const now = this.ctx.currentTime;
      const activeRiser =
        this.params.soloVoiceIndex === null
          ? this.params.shepardRiserMix * 0.22
          : 0;
      if (this.riserBus) {
        this.riserBus.gain.setTargetAtTime(activeRiser, now, 0.04);
      }

      for (let k = 0; k < partials.length; k++) {
        const node = this.riserNodes[k];
        const p = partials[k];
        node.osc.frequency.setTargetAtTime(p.frequencyHz, now, 0.03);
        node.subHarmonicOsc.frequency.setTargetAtTime(
          p.frequencyHz * 1.5, // Perfect fifth harmonic shimmer (A above D)
          now,
          0.03
        );
        node.filter.frequency.setTargetAtTime(
          Math.min(8000, p.frequencyHz * 2.5),
          now,
          0.03
        );
        node.gain.gain.setTargetAtTime(p.gain * 0.45, now, 0.03);
      }
    }
  }

  private triggerPercussionVoice(
    ctx: AudioContext,
    dest: AudioNode,
    ev: ScheduledTriggerEvent
  ): void {
    const t = Math.max(ctx.currentTime, ev.audioTime);
    const kit: SoundKitId = this.params.soundKit;
    // Shorten decay subtly at extreme high BPM so hits stay articulate instead of muddying
    const speedTightness = Math.max(
      0.38,
      Math.min(1.25, 120 / Math.max(30, ev.instantaneousBpm))
    );
    // Subtle brightness nudge with octave u (without cartoon chipmunk pitch-shifting!)
    const octaveNorm = ev.octavePosition / Math.max(3, this.params.numVoices);

    if (kit === 'woodblock') {
      this.playWoodblock(ctx, dest, t, ev.trackId, ev.gain, speedTightness);
      return;
    }

    if (kit === 'studio') {
      this.playStudioDrum(
        ctx,
        dest,
        t,
        ev.trackId,
        ev.gain,
        speedTightness,
        octaveNorm
      );
      return;
    }

    // Default: 'odyssey' (Troy War Drums, Bronze Anvil, Shaker Subdivision & Hemiola Chime)
    this.playOdysseyDrum(
      ctx,
      dest,
      t,
      ev.trackId,
      ev.gain,
      speedTightness,
      octaveNorm
    );
  }

  private playOdysseyDrum(
    ctx: AudioContext,
    dest: AudioNode,
    t: number,
    track: DrumTrackId,
    gainVal: number,
    tightness: number,
    octaveNorm: number
  ): void {
    if (track === 'low') {
      // Deep Trojan War Tom / Taiko Drum
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      const startFreq = 128 + octaveNorm * 24;
      const endFreq = 46 + octaveNorm * 6;
      const dur = 0.24 * tightness;

      osc.frequency.setValueAtTime(startFreq, t);
      osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur * 0.55);

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(gainVal * 0.85, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0008, t + dur);

      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + dur + 0.01);

      // Drumhead transient thud
      if (this.noiseBuffer) {
        const noise = ctx.createBufferSource();
        noise.buffer = this.noiseBuffer;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 320 + octaveNorm * 220;
        filter.Q.value = 1.4;
        const nGain = ctx.createGain();
        nGain.gain.setValueAtTime(gainVal * 0.32, t);
        nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
        noise.connect(filter);
        filter.connect(nGain);
        nGain.connect(dest);
        noise.start(t);
        noise.stop(t + 0.04);
      }
      return;
    }

    if (track === 'mid') {
      // Bronze Anvil + Frame Snare Strike
      const ratios = [293.66, 458.0, 742.0];
      const dur = 0.16 * tightness;
      for (let i = 0; i < ratios.length; i++) {
        const osc = ctx.createOscillator();
        osc.type = i === 0 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(ratios[i] * (0.95 + octaveNorm * 0.12), t);
        const pGain = ctx.createGain();
        const amp = (gainVal * 0.34) / (i + 1);
        pGain.gain.setValueAtTime(amp, t);
        pGain.gain.exponentialRampToValueAtTime(0.0008, t + dur / (1 + i * 0.4));
        osc.connect(pGain);
        pGain.connect(dest);
        osc.start(t);
        osc.stop(t + dur + 0.01);
      }

      if (this.noiseBuffer) {
        const noise = ctx.createBufferSource();
        noise.buffer = this.noiseBuffer;
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 1100;
        const nGain = ctx.createGain();
        nGain.gain.setValueAtTime(gainVal * 0.42, t);
        nGain.gain.exponentialRampToValueAtTime(0.0008, t + 0.09 * tightness);
        noise.connect(filter);
        filter.connect(nGain);
        nGain.connect(dest);
        noise.start(t);
        noise.stop(t + 0.1 * tightness + 0.01);
      }
      return;
    }

    if (track === 'high') {
      // Crisp Metallic Subdivision Pulse
      if (!this.noiseBuffer) return;
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 5400 + octaveNorm * 2200;
      filter.Q.value = 2.2;
      const nGain = ctx.createGain();
      const dur = 0.048 * tightness;
      nGain.gain.setValueAtTime(0.0001, t);
      nGain.gain.linearRampToValueAtTime(gainVal * 0.36, t + 0.002);
      nGain.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      noise.connect(filter);
      filter.connect(nGain);
      nGain.connect(dest);
      noise.start(t);
      noise.stop(t + dur + 0.01);
      return;
    }

    // 'hemiola': Tuned Bronze Bell / Hemiola 3:2 Cross-Pulse (D4 + A4 modal fifth)
    const freqs = [293.66, 440.0];
    const dur = 0.22 * tightness;
    freqs.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(
        gainVal * (idx === 0 ? 0.38 : 0.22),
        t + 0.003
      );
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      osc.connect(g);
      g.connect(dest);
      osc.start(t);
      osc.stop(t + dur + 0.01);
    });
  }

  private playStudioDrum(
    ctx: AudioContext,
    dest: AudioNode,
    t: number,
    track: DrumTrackId,
    gainVal: number,
    tightness: number,
    octaveNorm: number
  ): void {
    if (track === 'low') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(48, t + 0.07);
      const dur = 0.2 * tightness;
      gain.gain.setValueAtTime(gainVal * 0.9, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + dur + 0.01);
      return;
    }

    if (track === 'mid') {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(195, t);
      osc.frequency.exponentialRampToValueAtTime(125, t + 0.05);
      const oGain = ctx.createGain();
      oGain.gain.setValueAtTime(gainVal * 0.42, t);
      oGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08 * tightness);
      osc.connect(oGain);
      oGain.connect(dest);
      osc.start(t);
      osc.stop(t + 0.09);

      if (this.noiseBuffer) {
        const noise = ctx.createBufferSource();
        noise.buffer = this.noiseBuffer;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 1500;
        const nGain = ctx.createGain();
        nGain.gain.setValueAtTime(gainVal * 0.48, t);
        nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.11 * tightness);
        noise.connect(hp);
        hp.connect(nGain);
        nGain.connect(dest);
        noise.start(t);
        noise.stop(t + 0.12 * tightness + 0.01);
      }
      return;
    }

    if (track === 'high') {
      if (!this.noiseBuffer) return;
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 6800 + octaveNorm * 1800;
      const nGain = ctx.createGain();
      const dur = 0.042 * tightness;
      nGain.gain.setValueAtTime(gainVal * 0.34, t);
      nGain.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      noise.connect(hp);
      hp.connect(nGain);
      nGain.connect(dest);
      noise.start(t);
      noise.stop(t + dur + 0.01);
      return;
    }

    // Studio rimshot hemiola
    this.playWoodblock(ctx, dest, t, 'hemiola', gainVal * 0.85, tightness);
  }

  private playWoodblock(
    ctx: AudioContext,
    dest: AudioNode,
    t: number,
    track: DrumTrackId,
    gainVal: number,
    tightness: number
  ): void {
    const pitchMap: Record<DrumTrackId, number> = {
      low: 392.0, // G4
      mid: 587.33, // D5
      high: 880.0, // A5
      hemiola: 523.25, // C5
    };
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const baseF = pitchMap[track];
    osc.frequency.setValueAtTime(baseF * 1.06, t);
    osc.frequency.exponentialRampToValueAtTime(baseF, t + 0.015);

    const dur = (track === 'high' ? 0.045 : 0.075) * tightness;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(gainVal * 0.55, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0008, t + dur);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }
}
