'use client';

import { useEffect, useState } from 'react';
import { IStaircaseEngine, Preset } from '@/lib/staircase/types';

interface Props {
  engine: IStaircaseEngine;
  words: NonNullable<Preset['words']>;
  playing: boolean;
}

/** How many words stay on screen: the current one and the ones before it, fading. */
const SHOWN = 4;

/**
 * The word being sung. Every copy of the music sings the words at its own tempo; the one you
 * follow is the loudest copy, so the current word is the last one its track played.
 */
export default function WordsView({ engine, words, playing }: Props) {
  const { trackId, list } = words;
  const [heard, setHeard] = useState<number[]>([]);

  useEffect(() => {
    if (!playing) return;
    let seen = -Infinity;
    let frame = 0;
    const loop = () => {
      const { layers, recent } = engine.getSnapshot();
      const loudest = layers.reduce((best, layer) => (layer.window > best.window ? layer : best), layers[0]);
      const fresh = loudest
        ? recent.filter((e) => e.trackId === trackId && e.layerId === loudest.id && e.time > seen)
        : [];
      if (fresh.length > 0) {
        seen = Math.max(...fresh.map((e) => e.time));
        setHeard((prev) => [...fresh.map((e) => e.noteIndex), ...prev].slice(0, SHOWN));
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [engine, playing, trackId]);

  return (
    <div className="words flex min-h-[3.5rem] items-baseline gap-4 overflow-hidden whitespace-nowrap" aria-hidden="true">
      {heard.length === 0 ? (
        <span className="hint self-center">The words appear here as they are sung.</span>
      ) : (
        heard.map((index, i) => (
          <span
            key={`${index}-${i}`}
            className={i === 0 ? 'word-now font-bold leading-tight' : 'text-[1.125rem] font-semibold'}
            style={{ opacity: i === 0 ? 1 : 0.6 / i }}
          >
            {list[index]}
          </span>
        ))
      )}
    </div>
  );
}
