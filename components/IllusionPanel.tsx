'use client';

import { ChevronDown } from 'lucide-react';
import { Segmented, SlopeSlider, Slider, Switch } from '@/components/Controls';
import { LayerRatio, ParamsPatch, StairParams } from '@/lib/staircase/types';

interface Props {
  params: StairParams;
  update: (patch: ParamsPatch) => void;
}

const RATIOS: Array<{ value: LayerRatio; label: string }> = [
  { value: 2, label: '2:1 octaves' },
  { value: 1.5, label: '3:2' },
  { value: 3, label: '3:1' },
];

const PITCH_MODES = [
  { value: 'follow', label: 'Follows tempo' },
  { value: 'free', label: 'Independent' },
];

const PITCH_STEPS = [
  { value: 0, label: 'Glide' },
  { value: 0.5, label: 'Quarter tones' },
  { value: 1, label: 'Semitones' },
  { value: 2, label: 'Whole tones' },
];

/** The controls that change the trick itself, each with one sentence on what it does. */
export default function IllusionPanel({ params, update }: Props) {
  return (
    <details className="group border-b border-line">
      <summary className="flex min-h-[56px] cursor-pointer list-none items-center justify-between gap-3 px-4 [&::-webkit-details-marker]:hidden">
        <span>
          <h2 className="heading">Illusion</h2>
          <span className="hint block">Layers, window, pitch and focus</span>
        </span>
        <ChevronDown size={20} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="flex flex-col gap-5 px-4 pb-5 pt-2">
        <Segmented
          legend="Layer ratio"
          hint="How much faster each copy is than the one below it. 2:1 doubles; 3:2 makes every copy a hemiola of its neighbour; 3:1 nests triplets."
          options={RATIOS}
          value={params.ratio}
          onChange={(ratio) => update({ ratio })}
        />
        <Slider
          label="Window width"
          hint="How many copies you hear at once. Narrow is one clear groove, wide is a thick crowd."
          value={params.spread}
          min={0.5}
          max={1.5}
          step={0.05}
          format={(v) => `${v.toFixed(2)} octaves`}
          onChange={(spread) => update({ spread })}
        />
        <Slider
          label="Flutter limit"
          hint="Notes faster than this per second fade out. Lower it and the busiest notes go sooner."
          value={params.flutterHz}
          min={6}
          max={20}
          step={1}
          format={(v) => `${v} per second`}
          onChange={(flutterHz) => update({ flutterHz })}
        />
        <Segmented
          legend="Pitch"
          hint="Follows the tempo, as on a tape speeding up, or moves on its own: it can fall while the tempo rises."
          options={PITCH_MODES}
          value={params.pitchLink ? 'follow' : 'free'}
          onChange={(mode) => update({ pitchLink: mode === 'follow' })}
        />
        {!params.pitchLink && (
          <SlopeSlider
            label="Pitch speed"
            value={params.pitchSlope}
            up="rises an octave"
            down="falls an octave"
            captions={['Falling', 'Steady', 'Rising']}
            onChange={(pitchSlope) => update({ pitchSlope })}
          />
        )}
        <Segmented
          legend="Pitch moves by"
          hint="Glide is smooth. Steps jump, as in the original Shepard scale."
          options={PITCH_STEPS}
          value={params.pitchStep}
          onChange={(pitchStep) => update({ pitchStep })}
        />
        <Slider
          label="Focus tempo"
          hint="The tempo you perceive. The copy playing at this tempo is the loudest."
          value={params.focusBpm}
          min={60}
          max={180}
          step={1}
          format={(v) => `${v} BPM`}
          onChange={(focusBpm) => update({ focusBpm })}
        />
        <Switch
          label="Hear one layer alone"
          hint="Plays a single copy of the groove. Listen to it climb from a crawl to a blur, then fade away as the next one takes over."
          checked={params.solo}
          onChange={(solo) => update({ solo })}
        />
      </div>
    </details>
  );
}
