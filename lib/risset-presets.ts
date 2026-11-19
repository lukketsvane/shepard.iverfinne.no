import {
  DrumTrackId,
  RissetEngineParams,
  RissetPattern,
  StepCell,
  SubdivisionTier,
} from './risset-math';

export interface RissetPreset {
  id: string;
  name: string;
  shortLabel: string;
  subtitle: string;
  description: string;
  params: RissetEngineParams;
  pattern: RissetPattern;
}

function cell(
  active: boolean,
  tier: SubdivisionTier = 2,
  velocity = 0.85
): StepCell {
  return { active, tier, velocity };
}

export function clonePattern(pattern: RissetPattern): RissetPattern {
  const tracks = {} as Record<DrumTrackId, StepCell[]>;
  for (const key of ['low', 'mid', 'high', 'hemiola'] as DrumTrackId[]) {
    tracks[key] = pattern.tracks[key].map((c) => ({ ...c }));
  }
  return {
    stepsPerBar: pattern.stepsPerBar,
    beatsPerBar: pattern.beatsPerBar,
    meterLabel: pattern.meterLabel,
    tracks,
  };
}

/**
 * Cycle a step cell interactively through 4 musically meaningful states:
 * Off -> Tier 2 (Subdivision) -> Tier 1 (Pulse) -> Tier 0 (Anchor) -> Off
 */
export function cycleStepCell(current: StepCell): StepCell {
  if (!current.active) {
    return { active: true, tier: 2, velocity: 0.72 };
  }
  if (current.tier === 2) {
    return { active: true, tier: 1, velocity: 0.86 };
  }
  if (current.tier === 1) {
    return { active: true, tier: 0, velocity: 1.0 };
  }
  return { active: false, tier: 2, velocity: 0.72 };
}

export const RISSET_PRESETS: RissetPreset[] = [
  {
    id: 'troy-odyssey',
    name: "Troy — 'The Odyssey' 6/8 Illusion",
    shortLabel: 'Troy (6/8)',
    subtitle: 'Compound 6/8 · Dropped Subdivisions · 3:2 Hemiola · Shepard Riser',
    description:
      'Inspired by the Signals Music Studio breakdown of "Troy": a driving 6/8 war-drum & bronze groove that drops rapid inner subdivisions as each voice accelerates, destabilizes bar perception with a 3:2 hemiola cross-accent, and locks to a rising Shepard drone.',
    params: {
      direction: 'accelerando',
      numVoices: 4,
      centerBpm: 118,
      targetCycleSeconds: 22,
      bellFocus: 1.15,
      droppedSubdivisions: 0.78,
      hemiolaMix: 0.65,
      shepardRiserMix: 0.42,
      soloVoiceIndex: null,
      soundKit: 'odyssey',
      masterVolume: 0.82,
    },
    pattern: {
      stepsPerBar: 12,
      beatsPerBar: 2, // Two compound dotted-quarter macro-beats per 6/8 bar
      meterLabel: '6/8 Compound (12 Subdivisions)',
      tracks: {
        // War Drum: Anchor on 1 (step 0), Pulse on 4 (step 6), pickup subdivision on step 10
        low: [
          cell(true, 0, 1.0),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 2, 0.65),
          cell(false, 2, 0.7),
          cell(true, 1, 0.92),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 2, 0.72),
          cell(false, 2, 0.7),
        ],
        // Bronze Anvil / Frame Snare: Backbeat on step 6, syncopated accents
        mid: [
          cell(false, 0, 0.9),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 2, 0.68),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.95),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 2, 0.74),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
        ],
        // Driving 6/8 eighth & sixteenth subdivisions (thinned out at high speed!)
        high: [
          cell(true, 0, 0.9),
          cell(true, 2, 0.52),
          cell(true, 2, 0.76),
          cell(false, 2, 0.5),
          cell(true, 2, 0.78),
          cell(true, 2, 0.52),
          cell(true, 1, 0.88),
          cell(true, 2, 0.52),
          cell(true, 2, 0.76),
          cell(false, 2, 0.5),
          cell(true, 2, 0.78),
          cell(true, 2, 0.56),
        ],
        // 3:2 Hemiola: Divides 12 steps into THREE equal groups of 4 (steps 0, 4, 8 = 3/4 against 6/8!)
        hemiola: [
          cell(true, 0, 0.95),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.9),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.9),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
        ],
      },
    },
  },
  {
    id: 'classic-4-4',
    name: 'Classic Risset 4/4 Studio Groove',
    shortLabel: 'Studio (4/4)',
    subtitle: 'Simple 4/4 · 16th-Note Thinning · Acoustic Drum Synthesis',
    description:
      'A crisp 4/4 breakbeat across 4 simultaneous tempo octaves. Watch 16th-note hi-hats dissolve into 8th notes and quarter notes as each voice doubles from half-time into double-time.',
    params: {
      direction: 'accelerando',
      numVoices: 4,
      centerBpm: 124,
      targetCycleSeconds: 22,
      bellFocus: 1.2,
      droppedSubdivisions: 0.68,
      hemiolaMix: 0.25,
      shepardRiserMix: 0.18,
      soloVoiceIndex: null,
      soundKit: 'studio',
      masterVolume: 0.82,
    },
    pattern: {
      stepsPerBar: 16,
      beatsPerBar: 4,
      meterLabel: '4/4 Simple (16 Subdivisions)',
      tracks: {
        low: [
          cell(true, 0, 1.0),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 1, 0.8),
          cell(false, 2, 0.7),
          cell(true, 2, 0.76),
          cell(false, 2, 0.7),
          cell(true, 0, 0.94),
          cell(false, 2, 0.7),
          cell(true, 2, 0.74),
          cell(false, 2, 0.7),
          cell(false, 1, 0.8),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
        ],
        mid: [
          cell(false, 0, 0.9),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.96),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 2, 0.58),
          cell(false, 0, 0.9),
          cell(true, 2, 0.56),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.96),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 2, 0.62),
        ],
        high: [
          cell(true, 0, 0.88),
          cell(true, 2, 0.52),
          cell(true, 2, 0.74),
          cell(true, 2, 0.52),
          cell(true, 1, 0.84),
          cell(true, 2, 0.52),
          cell(true, 2, 0.74),
          cell(true, 2, 0.52),
          cell(true, 0, 0.88),
          cell(true, 2, 0.52),
          cell(true, 2, 0.74),
          cell(true, 2, 0.52),
          cell(true, 1, 0.84),
          cell(true, 2, 0.52),
          cell(true, 2, 0.74),
          cell(true, 2, 0.56),
        ],
        // 3+3+3+3+4 cross-accent over 16 steps
        hemiola: [
          cell(true, 0, 0.92),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 2, 0.78),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.86),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 2, 0.78),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.86),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
        ],
      },
    },
  },
  {
    id: 'pure-risset-click',
    name: 'Pure Psychoacoustic Pulse (Jean-Claude Risset)',
    shortLabel: 'Pure Pulse',
    subtitle: '4/4 Lab Woodblocks · Naked Tempo-Octave Crossfade',
    description:
      'Strips away pitch risers and heavy orchestration to expose Jean-Claude Risset’s foundational barberpole tempo illusion using calibrated resonant woodblocks. Toggle tricks back on one by one to hear how each deepens the illusion.',
    params: {
      direction: 'accelerando',
      numVoices: 4,
      centerBpm: 120,
      targetCycleSeconds: 18,
      bellFocus: 1.1,
      droppedSubdivisions: 0.25,
      hemiolaMix: 0.0,
      shepardRiserMix: 0.0,
      soloVoiceIndex: null,
      soundKit: 'woodblock',
      masterVolume: 0.82,
    },
    pattern: {
      stepsPerBar: 16,
      beatsPerBar: 4,
      meterLabel: '4/4 Laboratory Pulse',
      tracks: {
        low: [
          cell(true, 0, 1.0),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 1, 0.8),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.88),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 1, 0.8),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
        ],
        mid: [
          cell(false, 0, 0.9),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.9),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 0, 0.9),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.9),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
        ],
        high: [
          cell(true, 0, 0.82),
          cell(false, 2, 0.6),
          cell(true, 2, 0.68),
          cell(false, 2, 0.6),
          cell(true, 1, 0.78),
          cell(false, 2, 0.6),
          cell(true, 2, 0.68),
          cell(false, 2, 0.6),
          cell(true, 0, 0.82),
          cell(false, 2, 0.6),
          cell(true, 2, 0.68),
          cell(false, 2, 0.6),
          cell(true, 1, 0.78),
          cell(false, 2, 0.6),
          cell(true, 2, 0.68),
          cell(false, 2, 0.6),
        ],
        hemiola: [
          cell(true, 0, 0.9),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 2, 0.8),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.85),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 2, 0.8),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.85),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
        ],
      },
    },
  },
  {
    id: 'endless-decelerando',
    name: 'Infinite Decelerando — Time Dilation',
    shortLabel: 'Decelerando',
    subtitle: '6/8 Reverse Slope · Perpetual Slowdown · Falling Shepard Drone',
    description:
      'Inverts the Stowell-Risset integral while keeping forward pattern order intact: every rhythmic stream continuously halves in tempo while faster subdivisions emerge from above, creating a groove that slows down forever without stopping.',
    params: {
      direction: 'decelerando',
      numVoices: 4,
      centerBpm: 112,
      targetCycleSeconds: 22,
      bellFocus: 1.15,
      droppedSubdivisions: 0.72,
      hemiolaMix: 0.55,
      shepardRiserMix: 0.38,
      soloVoiceIndex: null,
      soundKit: 'odyssey',
      masterVolume: 0.82,
    },
    pattern: {
      stepsPerBar: 12,
      beatsPerBar: 2,
      meterLabel: '6/8 Compound (Decelerando)',
      tracks: {
        low: [
          cell(true, 0, 1.0),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 2, 0.64),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.9),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 2, 0.68),
          cell(false, 2, 0.7),
        ],
        mid: [
          cell(false, 0, 0.9),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.94),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 2, 0.68),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
        ],
        high: [
          cell(true, 0, 0.86),
          cell(false, 2, 0.52),
          cell(true, 2, 0.74),
          cell(true, 2, 0.5),
          cell(true, 2, 0.74),
          cell(false, 2, 0.52),
          cell(true, 1, 0.84),
          cell(false, 2, 0.52),
          cell(true, 2, 0.74),
          cell(true, 2, 0.5),
          cell(true, 2, 0.74),
          cell(false, 2, 0.52),
        ],
        hemiola: [
          cell(true, 0, 0.92),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.88),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(true, 1, 0.88),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
          cell(false, 2, 0.7),
        ],
      },
    },
  },
];
