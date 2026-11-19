export type IllusionDirection = 'accelerando' | 'decelerando';

export type SubdivisionTier = 0 | 1 | 2;
// 0 = Anchor (primary downbeats, never thinned by subdivision drop)
// 1 = Pulse (secondary beats / backbeats, thinned gently only at extreme high speed)
// 2 = Subdivision (fast inner 8th/16th/triplet subdivisions, progressively dropped as tempo doubles)

export type DrumTrackId = 'low' | 'mid' | 'high' | 'hemiola';

export type SoundKitId =
  | 'icct'
  | 'odyssey'
  | 'studio'
  | 'woodblock'
  | 'custom';

export interface StepCell {
  active: boolean;
  tier: SubdivisionTier;
  velocity: number; // 0..1
  midiNote?: number; // Optional MIDI pitch (0..127), e.g., D# minor Icct Hedral ostinato
}

export interface RissetPattern {
  stepsPerBar: 12 | 16;
  beatsPerBar: number; // e.g., 2 (compound duple 6/8) or 4 (4/4)
  meterLabel: string; // e.g., "6/8 Compound" or "4/4 Simple"
  tracks: Record<DrumTrackId, StepCell[]>;
}

export interface RissetEngineParams {
  direction: IllusionDirection;
  numVoices: number; // 4 or 5 tempo octaves
  centerBpm: number; // Perceived focal tempo at u = numVoices / 2
  targetCycleSeconds: number; // Requested cycle period before integer-bar phase-lock quantization
  bellFocus: number; // 0.6..2.2 exponent controlling bell envelope sharpness
  droppedSubdivisions: number; // 0..1 amount of progressive subdivision thinning
  hemiolaMix: number; // 0..1 level of 3:2 polymetric cross-accent layer
  shepardRiserMix: number; // 0..1 level of phase-locked Shepard pitch riser
  soloVoiceIndex: number | null; // null = full illusion, 0..numVoices-1 = isolate single voice
  soundKit: SoundKitId;
  masterVolume: number; // 0..1
  rootHz?: number; // Tonic Hz for Shepard drone (e.g., 38.891 = D#1 for Icct Hedral, 36.708 = D1 for Troy)
}

export interface QuantizedCycleSpec {
  baseBpm: number; // BPM at u = 0
  maxBpm: number; // BPM at u = numVoices
  baseBarRate: number; // Bars per second at u = 0
  quantizedBarsN0: number; // Integer N0 ensuring exact 2:1 phase alignment & seamless wrap
  exactCycleSeconds: number; // T = (N0 * ln(2)) / baseBarRate
}

export interface VoiceSnapshot {
  voiceIndex: number; // Fixed stream identity tracking a voice across 0..1 cycle
  octavePosition: number; // u in [0, numVoices]
  instantaneousBpm: number;
  bellGain: number; // Main Risset window W(u) in [0, 1]
  effectiveGain: number; // Accounting for soloVoiceIndex
  subdivisionGainTier1: number; // Multiplier for tier-1 pulses at current u
  subdivisionGainTier2: number; // Multiplier for tier-2 inner subdivisions at current u
  barPhase: number; // Cumulative bar count Phi(u)
  barFraction: number; // Fractional position within current bar [0, 1)
  currentStep: number; // Active step index [0, stepsPerBar - 1]
}

export interface ScheduledTriggerEvent {
  audioTime: number;
  voiceIndex: number;
  octavePosition: number;
  trackId: DrumTrackId;
  stepIndex: number;
  tier: SubdivisionTier;
  gain: number;
  instantaneousBpm: number;
  midiNote?: number;
}

const LN2 = Math.LN2;

/**
 * Computes the Stowell-Risset phase-locked cycle specification.
 * Quantizing N0 = round((baseBarRate * targetCycleSeconds) / ln(2)) to a positive integer
 * guarantees that at every instant, Voice k+1 is at exact 2:1 bar phase with Voice k,
 * and every voice hands off seamlessly on an exact bar boundary when the cycle wraps.
 */
export function computeQuantizedCycle(
  centerBpm: number,
  numVoices: number,
  beatsPerBar: number,
  targetCycleSeconds: number
): QuantizedCycleSpec {
  const safeVoices = Math.max(3, Math.min(6, Math.round(numVoices)));
  const safeCenterBpm = Math.max(40, Math.min(240, centerBpm));
  const safeBeatsPerBar = Math.max(1, beatsPerBar);
  const safeTargetSeconds = Math.max(4, Math.min(90, targetCycleSeconds));

  const baseBpm = safeCenterBpm * Math.pow(2, -safeVoices / 2);
  const maxBpm = safeCenterBpm * Math.pow(2, safeVoices / 2);
  const baseBeatRate = baseBpm / 60;
  const baseBarRate = baseBeatRate / safeBeatsPerBar;

  const rawN0 = (baseBarRate * safeTargetSeconds) / LN2;
  const quantizedBarsN0 = Math.max(1, Math.round(rawN0));
  const exactCycleSeconds = (quantizedBarsN0 * LN2) / baseBarRate;

  return {
    baseBpm,
    maxBpm,
    baseBarRate,
    quantizedBarsN0,
    exactCycleSeconds,
  };
}

/**
 * Raised-cosine bell window over u in [0, numVoices].
 * Smoothly vanishes with zero derivative at u = 0 and u = numVoices.
 */
export function getBellGain(
  octavePosition: number,
  numVoices: number,
  bellFocus = 1.15
): number {
  if (octavePosition <= 0 || octavePosition >= numVoices) {
    return 0;
  }
  const normalized = octavePosition / numVoices; // (0, 1)
  const baseSin = Math.sin(Math.PI * normalized);
  if (baseSin <= 0) return 0;
  const exponent = Math.max(0.5, Math.min(3.0, bellFocus)) * 2;
  return Math.pow(baseSin, exponent);
}

/**
 * Models "Dropped Subdivisions" (Trick #2 from Signals Music Studio's Odyssey breakdown).
 * As a voice accelerates into higher tempo octaves, dense inner subdivisions (tier 2)
 * thin out first so the listener's ear re-parses the remaining anchor beats as the slower pulse.
 */
export function getSubdivisionRetention(
  octavePosition: number,
  numVoices: number,
  tier: SubdivisionTier,
  dropAmount: number
): number {
  const clampedDrop = Math.max(0, Math.min(1, dropAmount));
  if (tier === 0 || clampedDrop <= 0.001) {
    return 1;
  }

  const normU = Math.max(0, Math.min(1, octavePosition / numVoices));

  if (tier === 2) {
    // Inner 8th/16th subdivisions begin fading around 34%..74% of the octave span
    const startFade = 0.52 - 0.2 * clampedDrop; // 0.32 at max drop
    const endFade = 0.88 - 0.22 * clampedDrop; // 0.66 at max drop
    if (normU <= startFade) return 1;
    if (normU >= endFade) return 1 - clampedDrop;
    const progress = (normU - startFade) / (endFade - startFade);
    const smoothDrop = 0.5 * (1 - Math.cos(Math.PI * progress));
    return 1 - clampedDrop * smoothDrop;
  }

  // Tier 1 (secondary pulses / backbeats) thin gently only near upper octaves
  const startFade = 0.66 - 0.12 * clampedDrop;
  const endFade = 0.95 - 0.1 * clampedDrop;
  const maxTier1Drop = clampedDrop * 0.65;
  if (normU <= startFade) return 1;
  if (normU >= endFade) return 1 - maxTier1Drop;
  const progress = (normU - startFade) / (endFade - startFade);
  const smoothDrop = 0.5 * (1 - Math.cos(Math.PI * progress));
  return 1 - maxTier1Drop * smoothDrop;
}

/**
 * Positive modulo helper returning [0, mod).
 */
export function positiveMod(value: number, mod: number): number {
  const rem = value % mod;
  return rem < 0 ? rem + mod : rem;
}

/**
 * Computes a complete snapshot of all tempo-octave voices at elapsed time `elapsedSeconds`.
 * Note on `voiceIndex`:
 * - To let users "Solo a Single Voice" across its full multi-octave journey from u=0 to u=L
 *   (instead of jumping back after 1 octave!), stream `s` sweeps across ALL `L` octaves over `L` cycles:
 *   u_s(t) = (elapsed / T + s) mod L  (accelerando)
 *   u_s(t) = L - ((elapsed / T + s) mod L)  (decelerando)
 * Notice that at any cycle fraction xi = (elapsed / T) mod 1, the set of active octave positions
 * is STILL {0 + xi, 1 + xi, ..., L - 1 + xi}, while soloing voice `s` lets you follow a single
 * rhythmic layer all the way from 30 BPM -> 60 -> 120 -> 240 -> 480 BPM before it wraps!
 */
export function getVoicesSnapshotAtTime(
  elapsedSeconds: number,
  params: RissetEngineParams,
  stepsPerBar: number,
  beatsPerBar: number
): {
  cycleSpec: QuantizedCycleSpec;
  cycleProgress: number;
  voices: VoiceSnapshot[];
} {
  const L = Math.max(3, Math.min(6, Math.round(params.numVoices)));
  const cycleSpec = computeQuantizedCycle(
    params.centerBpm,
    L,
    beatsPerBar,
    params.targetCycleSeconds
  );
  const T = cycleSpec.exactCycleSeconds;
  const N0 = cycleSpec.quantizedBarsN0;

  const totalCycles = Math.max(0, elapsedSeconds) / T;
  const cycleProgress = positiveMod(totalCycles, 1);

  const voices: VoiceSnapshot[] = [];

  for (let s = 0; s < L; s++) {
    const wrappedSweep = positiveMod(totalCycles + s, L); // [0, L)
    const u =
      params.direction === 'accelerando' ? wrappedSweep : L - wrappedSweep;

    const instantaneousBpm = params.centerBpm * Math.pow(2, u - L / 2);
    const bellGain = getBellGain(u, L, params.bellFocus);

    // If soloVoiceIndex is active, boost clarity near edges slightly while still zeroing the wrap seam
    let effectiveGain = bellGain;
    if (params.soloVoiceIndex !== null) {
      if (params.soloVoiceIndex === s) {
        // Gentle tapered window so the user clearly hears the full 4-octave sweep without seam click
        const norm = u / L;
        const edgeTaper = Math.sin(Math.PI * Math.min(1, Math.max(0, norm)));
        effectiveGain = Math.pow(edgeTaper, 0.45);
      } else {
        effectiveGain = 0;
      }
    }

    const barPhase =
      params.direction === 'accelerando'
        ? N0 * (Math.pow(2, u) - 1)
        : N0 * (Math.pow(2, L) - Math.pow(2, u));

    const barFraction = positiveMod(barPhase, 1);
    const currentStep = Math.min(
      stepsPerBar - 1,
      Math.floor(barFraction * stepsPerBar)
    );

    voices.push({
      voiceIndex: s,
      octavePosition: u,
      instantaneousBpm,
      bellGain,
      effectiveGain,
      subdivisionGainTier1: getSubdivisionRetention(
        u,
        L,
        1,
        params.droppedSubdivisions
      ),
      subdivisionGainTier2: getSubdivisionRetention(
        u,
        L,
        2,
        params.droppedSubdivisions
      ),
      barPhase,
      barFraction,
      currentStep,
    });
  }

  return {
    cycleSpec,
    cycleProgress,
    voices,
  };
}

/**
 * Analytical closed-form scheduler for exact Web Audio trigger timestamps within
 * `[windowStartElapsed, windowEndElapsed)` (measured in seconds since playback start `startAudioTime`).
 *
 * Uses the exact inverse of the Stowell-Risset integral:
 * - Accelerando: Phi(u) = N0 * (2^u - 1)  =>  u(Phi) = log2(1 + Phi / N0)
 * - Decelerando: Phi(u) = N0 * (2^L - 2^u) => u(Phi) = log2(2^L - Phi / N0)
 */
export function computeTriggersInWindow(
  windowStartElapsed: number,
  windowEndElapsed: number,
  startAudioTime: number,
  params: RissetEngineParams,
  pattern: RissetPattern
): ScheduledTriggerEvent[] {
  if (windowEndElapsed <= windowStartElapsed) return [];

  const L = Math.max(3, Math.min(6, Math.round(params.numVoices)));
  const cycleSpec = computeQuantizedCycle(
    params.centerBpm,
    L,
    pattern.beatsPerBar,
    params.targetCycleSeconds
  );
  const T = cycleSpec.exactCycleSeconds;
  const N0 = cycleSpec.quantizedBarsN0;
  const stepsPerBar = pattern.stepsPerBar;
  const superPeriod = L * T; // Full multi-octave journey of a single named stream s

  const events: ScheduledTriggerEvent[] = [];
  const trackIds: DrumTrackId[] = ['low', 'mid', 'high', 'hemiola'];

  for (let s = 0; s < L; s++) {
    if (params.soloVoiceIndex !== null && params.soloVoiceIndex !== s) {
      continue;
    }

    // Stream `s` begins a fresh L-octave sweep whenever `elapsed + s * T = m * (L * T)`
    // i.e., sweepEpoch m starts at t_epoch = (m * L - s) * T and ends at t_epoch + L * T.
    const minEpoch = Math.floor((windowStartElapsed + s * T) / superPeriod);
    const maxEpoch = Math.floor((windowEndElapsed + s * T) / superPeriod);

    for (let m = minEpoch; m <= maxEpoch; m++) {
      const epochStart = (m * L - s) * T;
      const segStart = Math.max(windowStartElapsed, epochStart);
      const segEnd = Math.min(windowEndElapsed, epochStart + superPeriod);
      if (segEnd <= segStart) continue;

      // Normalized sweep progress within this L-octave epoch: w in [0, L)
      const wStart = Math.max(0, Math.min(L - 1e-9, (segStart - epochStart) / T));
      const wEnd = Math.max(0, Math.min(L, (segEnd - epochStart) / T));
      if (wEnd <= wStart) continue;

      let phiStart: number;
      let phiEnd: number;

      if (params.direction === 'accelerando') {
        // u = w increases from wStart to wEnd
        phiStart = N0 * (Math.pow(2, wStart) - 1);
        phiEnd = N0 * (Math.pow(2, wEnd) - 1);
      } else {
        // u = L - w decreases from L - wStart down to L - wEnd; Phi increases!
        phiStart = N0 * (Math.pow(2, L) - Math.pow(2, L - wStart));
        phiEnd = N0 * (Math.pow(2, L) - Math.pow(2, L - wEnd));
      }

      // Integer step index n corresponds to bar phase phi = n / stepsPerBar
      const minStepGlobal = Math.ceil(phiStart * stepsPerBar - 1e-9);
      const maxStepGlobal = Math.ceil(phiEnd * stepsPerBar - 1e-9) - 1;

      for (let n = minStepGlobal; n <= maxStepGlobal; n++) {
        const phi = n / stepsPerBar;
        if (phi < phiStart - 1e-9 || phi >= phiEnd - 1e-12) continue;

        let u: number;
        let w: number;
        if (params.direction === 'accelerando') {
          u = Math.log2(1 + phi / N0);
          w = u;
        } else {
          const arg = Math.pow(2, L) - phi / N0;
          if (arg <= 0) continue;
          u = Math.log2(arg);
          w = L - u;
        }

        const eventElapsed = epochStart + w * T;
        if (
          eventElapsed < windowStartElapsed - 1e-7 ||
          eventElapsed >= windowEndElapsed - 1e-7
        ) {
          continue;
        }

        const stepIndex = positiveMod(n, stepsPerBar);
        const instantaneousBpm = params.centerBpm * Math.pow(2, u - L / 2);

        // Prevent extreme ultrasonic trigger density (> 1800 step rate/min) from wasting nodes when gain ~ 0
        let voiceGain = getBellGain(u, L, params.bellFocus);
        if (params.soloVoiceIndex === s) {
          const norm = Math.max(0, Math.min(1, u / L));
          voiceGain = Math.pow(Math.sin(Math.PI * norm), 0.45);
        }
        if (voiceGain < 0.004) continue;

        for (const trackId of trackIds) {
          if (trackId === 'hemiola' && params.hemiolaMix <= 0.005) continue;

          const cell = pattern.tracks[trackId][stepIndex];
          if (!cell || !cell.active) continue;

          const subRetention = getSubdivisionRetention(
            u,
            L,
            cell.tier,
            params.droppedSubdivisions
          );
          const trackScale = trackId === 'hemiola' ? params.hemiolaMix : 1.0;
          const finalGain =
            voiceGain * subRetention * cell.velocity * trackScale;

          if (finalGain < 0.005) continue;

          events.push({
            audioTime: startAudioTime + eventElapsed,
            voiceIndex: s,
            octavePosition: u,
            trackId,
            stepIndex,
            tier: cell.tier,
            gain: Math.min(1, finalGain),
            instantaneousBpm,
            midiNote: cell.midiNote,
          });
        }
      }
    }
  }

  events.sort((a, b) => a.audioTime - b.audioTime);
  return events;
}

/**
 * Computes instantaneous frequencies and bell gains for the coupled Shepard Pitch Riser
 * locked to the exact same normalized cycle progress `cycleProgress` in [0, 1).
 */
export function getShepardRiserPartials(
  cycleProgress: number,
  direction: IllusionDirection,
  numPartials = 5,
  rootHz = 36.708 // D1 (Trojan Dorian/Phrygian tonic)
): Array<{ partialIndex: number; frequencyHz: number; gain: number }> {
  const partials: Array<{
    partialIndex: number;
    frequencyHz: number;
    gain: number;
  }> = [];
  const xi = positiveMod(cycleProgress, 1);

  for (let k = 0; k < numPartials; k++) {
    const u = direction === 'accelerando' ? k + xi : k + 1 - xi;
    const frequencyHz = rootHz * Math.pow(2, u);
    const norm = u / numPartials;
    const gain = Math.pow(Math.sin(Math.PI * norm), 2);
    partials.push({
      partialIndex: k,
      frequencyHz,
      gain,
    });
  }

  return partials;
}
