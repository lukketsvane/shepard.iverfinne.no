'use client';

import { KeyboardEvent, RefObject, useEffect, useRef, useState } from 'react';
import { annotateTrack, metricPeriods, positiveMod } from '@/lib/staircase/meter';
import { IStaircaseEngine, Meter, Preset, Track, TrackRole, isDrumRole } from '@/lib/staircase/types';

interface Props {
  preset: Preset;
  engine: IStaircaseEngine;
  playing: boolean;
  /** Called with the full, edited track list; the caller passes it on to the engine. */
  onTracks: (tracks: Track[]) => void;
  /** Puts back the rhythm the preset came with. Without it there is no reset button. */
  onReset?: () => void;
  /** Fill the height of the parent (the phone in landscape) instead of using fixed-height rows. */
  fill?: boolean;
}

/** Off, soft, normal, accent. */
const LEVELS = [0, 0.5, 0.8, 1];
const LEVEL_NAMES = ['off', 'soft', 'normal', 'accent'];
const LEVEL_HEIGHTS = ['0%', '34%', '67%', '100%'];
/** Each step is at least this wide (2.75rem), the size of a touch target. */
const MIN_STEP_WIDTH = '2.75rem';
const ROLE_NAMES: Record<TrackRole, string> = {
  kick: 'Kick',
  snare: 'Snare',
  hat: 'Hi-hat',
  perc: 'Percussion',
  bass: 'Bass',
  keys: 'Keys',
  lead: 'Lead',
};
/** Notes this close to a step (in beats) belong to it. */
const ON_GRID = 1e-3;

/** Steps in one beat: the finest division of the meter. */
export function stepsPerBeat(meter: Meter): number {
  const periods = metricPeriods(meter);
  return Math.round(1 / periods[periods.length - 1]);
}

/** Level (0..3) of the note on a step. */
function levelAt(track: Track, step: number, perBeat: number): number {
  const note = track.notes.find((n) => Math.abs(n.beat - step / perBeat) < ON_GRID);
  if (!note) return 0;
  return note.vel <= 0.65 ? 1 : note.vel <= 0.9 ? 2 : 3;
}

/**
 * The track with one step set to `level`. Notes that sit off the grid (from an imported file)
 * are left alone, and the result is annotated again so the new note knows how fast its stream is.
 */
export function withStep(track: Track, step: number, level: number, perBeat: number, meter: Meter): Track {
  const beat = step / perBeat;
  const kept = track.notes.filter((n) => Math.abs(n.beat - beat) >= ON_GRID);
  const notes = level > 0 ? [...kept, { beat, dur: 1 / perBeat, midi: 0, vel: LEVELS[level], rate: 0 }] : kept;
  notes.sort((a, b) => a.beat - b.beat);
  return annotateTrack({ ...track, notes }, meter);
}

/** Whether there is more of the grid to the right of what is showing: a long rhythm has no other sign of it. */
function useMoreToTheRight(scroller: RefObject<HTMLElement | null>): boolean {
  const [more, setMore] = useState(false);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setMore(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => {
      element.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [scroller]);
  return more;
}

/** The four levels of a step, drawn as they are in the grid. */
function Legend() {
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-x-4 gap-y-1 p-0 hint" aria-label="Levels of a step">
      {LEVEL_NAMES.map((name, level) => (
        <li key={name} className="flex items-center gap-1.5">
          <span className="step-swatch" data-level={level} aria-hidden="true">
            <i style={{ height: LEVEL_HEIGHTS[level] }} />
          </span>
          {name}
        </li>
      ))}
    </ul>
  );
}

/**
 * One row per drum track, one cell per step. Tap a cell to go round off, soft, normal, accent.
 * Each row is one stop in the tab order; the arrow keys move between steps and rows.
 */
export default function StepEditor({ preset, engine, playing, onTracks, onReset, fill }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const moreToTheRight = useMoreToTheRight(gridRef);
  const [focused, setFocused] = useState({ row: 0, step: 0 });
  const perBeat = stepsPerBeat(preset.meter);
  const drums = preset.tracks.filter((track) => isDrumRole(track.role));

  // The playhead follows the loudest copy of the groove, the one you are following by ear.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const loop = () => {
      const { layers } = engine.getSnapshot();
      const lead = layers.reduce((best, layer) => (layer.window > best.window ? layer : best), layers[0]);
      if (lead) {
        for (const head of gridRef.current?.querySelectorAll<HTMLElement>('[data-playhead]') ?? []) {
          const length = Number(head.dataset.length);
          head.style.left = `${(positiveMod(lead.phase, length) / length) * 100}%`;
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [engine, playing]);

  if (drums.length === 0) {
    return <p className="hint">This preset has no drum tracks to edit.</p>;
  }

  const cycle = (track: Track, step: number) => {
    const next = (levelAt(track, step, perBeat) + 1) % LEVELS.length;
    const edited = withStep(track, step, next, perBeat, preset.meter);
    onTracks(preset.tracks.map((t) => (t === track ? edited : t)));
  };

  const onKeyDown = (event: KeyboardEvent, row: number, step: number) => {
    const length = (r: number) => Math.round(drums[r].lengthBeats * perBeat);
    const target: Record<string, [number, number]> = {
      ArrowLeft: [row, Math.max(0, step - 1)],
      ArrowRight: [row, Math.min(length(row) - 1, step + 1)],
      ArrowUp: [Math.max(0, row - 1), step],
      ArrowDown: [Math.min(drums.length - 1, row + 1), step],
      Home: [row, 0],
      End: [row, length(row) - 1],
    };
    const next = target[event.key];
    if (!next) return;
    event.preventDefault();
    const [r, s] = [next[0], Math.min(next[1], length(next[0]) - 1)];
    gridRef.current?.querySelector<HTMLElement>(`[data-row="${r}"][data-step="${s}"]`)?.focus();
  };

  const name = (track: Track) => {
    const same = drums.filter((t) => t.role === track.role);
    const base = ROLE_NAMES[track.role];
    return same.length > 1 ? `${base} ${same.indexOf(track) + 1}` : base;
  };

  return (
    <div className={fill ? 'flex h-full flex-col' : ''}>
      <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div>
          <p className="hint">Tap a step to change it.</p>
          <Legend />
        </div>
        {onReset && (
          <button type="button" className="btn" onClick={onReset}>
            Reset rhythm
          </button>
        )}
      </div>
      <div className={`relative ${fill ? 'min-h-0 flex-1' : ''}`}>
        <div ref={gridRef} className={`overflow-x-auto overscroll-x-contain ${fill ? 'h-full' : ''}`}>
          <div className={`grid min-w-max ${fill ? 'h-full' : ''}`} style={{ gridAutoRows: fill ? '1fr' : 'minmax(3.5rem, auto)' }}>
            {drums.map((track, row) => {
              const steps = Math.round(track.lengthBeats * perBeat);
              const label = name(track);
              return (
                <div key={track.id} className="flex border-b border-line" role="group" aria-label={`${label}, ${steps} steps`}>
                  <div className="sticky left-0 z-10 flex w-[6.5rem] shrink-0 items-center bg-page pr-2 font-semibold">{label}</div>
                  <div
                    className="relative grid flex-1 border-r border-line"
                    style={{ gridTemplateColumns: `repeat(${steps}, minmax(${MIN_STEP_WIDTH}, 1fr))` }}
                  >
                    {Array.from({ length: steps }, (_, step) => {
                      const level = levelAt(track, step, perBeat);
                      const beat = step % perBeat === 0;
                      const bar = step % (perBeat * preset.meter.beatsPerBar) === 0;
                      return (
                        <button
                          key={step}
                          type="button"
                          data-level={level}
                          data-row={row}
                          data-step={step}
                          tabIndex={focused.row === row && Math.min(focused.step, steps - 1) === step ? 0 : -1}
                          className={`step ${beat ? 'beat' : ''} ${bar ? 'bar' : ''}`}
                          aria-label={`${label}, step ${step + 1} of ${steps}: ${LEVEL_NAMES[level]}`}
                          onFocus={() => setFocused({ row, step })}
                          onKeyDown={(event) => onKeyDown(event, row, step)}
                          onClick={() => cycle(track, step)}
                        >
                          <i style={{ height: LEVEL_HEIGHTS[level] }} />
                        </button>
                      );
                    })}
                    {playing && (
                      <div
                        data-playhead
                        data-length={track.lengthBeats}
                        className="pointer-events-none absolute inset-y-0 w-0.5 bg-ink"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {moreToTheRight && (
          <div
            className="pointer-events-none absolute inset-y-0 right-0 w-12"
            style={{ background: 'linear-gradient(to left, var(--page), transparent)' }}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}
