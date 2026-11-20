'use client';

import { Check } from 'lucide-react';
import { PRESETS } from '@/lib/presets/index';

interface Props {
  currentId: string;
  onChoose: (index: number) => void;
}

/** Every preset with what you will hear. Choosing the current one again puts back its original rhythm. */
export default function PresetList({ currentId, onChoose }: Props) {
  return (
    <ul className="m-0 list-none p-0">
      {PRESETS.map((preset, index) => {
        const current = preset.id === currentId;
        return (
          <li key={preset.id} className="border-b border-line last:border-b-0">
            <button
              type="button"
              aria-current={current ? 'true' : undefined}
              className="flex min-h-[44px] w-full items-start gap-3 py-3 text-left"
              onClick={() => onChoose(index)}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[17px] font-bold">{preset.name}</span>
                <span className="hint block">{preset.blurb}</span>
              </span>
              {current && <Check size={20} className="mt-1 shrink-0 text-accent" aria-hidden="true" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
