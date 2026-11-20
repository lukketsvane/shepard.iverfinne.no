'use client';

import { Slider } from '@/components/Controls';
import { MixLevels, ParamsPatch, StairParams } from '@/lib/staircase/types';

interface Props {
  params: StairParams;
  update: (patch: ParamsPatch) => void;
}

const CHANNELS: Array<{ key: keyof MixLevels; label: string; hint?: string }> = [
  { key: 'drums', label: 'Drums' },
  { key: 'melody', label: 'Melody' },
  { key: 'pad', label: 'Drone', hint: 'A held chord whose pitch climbs. Turn it up to see its pitch axis.' },
  { key: 'sweep', label: 'Sweep', hint: 'Filtered noise that seems to rise forever.' },
  { key: 'tape', label: 'Tape', hint: 'The loop replayed ever faster, until the beats become a tone.' },
  { key: 'reverb', label: 'Room' },
];

const percent = (value: number) => `${Math.round(value * 100)}%`;

export default function MixPanel({ params, update }: Props) {
  return (
    <section aria-labelledby="mix-heading" className="border-b border-line px-4 py-4">
      <h2 id="mix-heading" className="heading mb-1">
        Mix
      </h2>
      <div className="flex flex-col gap-1">
        {CHANNELS.map(({ key, label, hint }) => (
          <Slider
            key={key}
            label={label}
            hint={hint}
            value={params.levels[key]}
            min={0}
            max={1}
            step={0.01}
            format={percent}
            onChange={(value) => update({ levels: { [key]: value } })}
          />
        ))}
        <Slider
          label="Volume"
          value={params.master}
          min={0}
          max={1}
          step={0.01}
          format={percent}
          onChange={(value) => update({ master: value })}
        />
      </div>
    </section>
  );
}
