'use client';

import { CSSProperties, KeyboardEvent, ReactNode, useId } from 'react';
import { MAX_SLOPE, describeSlope } from '@/lib/staircase/control';

/** Fraction of the slider's throw, each side of the middle, where the speed holds still at zero. */
const DEAD_ZONE = 0.06;
/** Octaves per minute added by one arrow key. */
const NUDGE = 0.25;

/**
 * Slider position in [-1, 1] to a slope in octaves per minute. The middle holds still (a
 * detent), and the curve is squared so the slow, musical speeds take up the middle of each half.
 */
export function slopeFromPosition(position: number): number {
  const beyond = (Math.abs(position) - DEAD_ZONE) / (1 - DEAD_ZONE);
  if (beyond <= 0) return 0;
  return Math.round(Math.sign(position) * MAX_SLOPE * beyond * beyond * 100) / 100;
}

export function positionFromSlope(slope: number): number {
  const fraction = Math.min(Math.abs(slope) / MAX_SLOPE, 1);
  if (fraction === 0) return 0;
  return Math.sign(slope) * (DEAD_ZONE + (1 - DEAD_ZONE) * Math.sqrt(fraction));
}

/** A slope moved by `steps` arrow-key presses, kept on the grid of presses and inside the range. */
export function nudgeSlope(slope: number, steps: number): number {
  const next = Math.round(slope / NUDGE + steps) * NUDGE;
  return Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, next));
}

function fillStyle(from: number, to: number): CSSProperties {
  return { '--from': `${from * 100}%`, '--to': `${to * 100}%` } as CSSProperties;
}

interface SliderProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

/** A labelled range with its value in words beside the label. */
export function Slider({ label, hint, value, min, max, step, format, onChange }: SliderProps) {
  const id = useId();
  const text = format(value);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="font-semibold">
          {label}
        </label>
        <span aria-hidden="true" className="num text-muted">
          {text}
        </span>
      </div>
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
      <input
        id={id}
        type="range"
        className="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={text}
        aria-describedby={hint ? `${id}-hint` : undefined}
        style={fillStyle(0, (value - min) / (max - min))}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

interface SlopeSliderProps {
  label: string;
  hint?: string;
  /** Octaves per minute. */
  value: number;
  /** Words for a positive and a negative slope, passed to describeSlope. */
  up: string;
  down: string;
  /** Words at the left end, the middle and the right end. */
  captions: [string, string, string];
  /** Shown instead of the value when something else is steering. */
  note?: ReactNode;
  /** Label and value above the slider and nothing else, for a toolbar. */
  compact?: boolean;
  onChange: (slope: number) => void;
}

/** A bipolar slider: left slows, the middle holds still, right speeds up. */
export function SlopeSlider({ label, hint, value, up, down, captions, note, compact, onChange }: SlopeSliderProps) {
  const id = useId();
  const text = describeSlope(value, up, down);
  const position = positionFromSlope(value);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -4, PageUp: 4 };
    const press = steps[event.key];
    if (press === undefined) return;
    event.preventDefault();
    onChange(nudgeSlope(value, press));
  };

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="font-semibold">
          {label}
        </label>
        <span aria-hidden="true" className="num text-muted">
          {text}
        </span>
      </div>
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
      <div className="range-detent">
        <input
          id={id}
          type="range"
          className="range"
          min={-1}
          max={1}
          step={0.005}
          value={position}
          aria-valuetext={text}
          aria-describedby={hint ? `${id}-hint` : undefined}
          style={fillStyle(Math.min(0.5, 0.5 + position / 2), Math.max(0.5, 0.5 + position / 2))}
          onChange={(event) => onChange(slopeFromPosition(Number(event.target.value)))}
          onKeyDown={onKeyDown}
        />
      </div>
      {!compact && (
        <div className="grid grid-cols-3 text-[14px] text-muted" aria-hidden="true">
          <span>{captions[0]}</span>
          <span className="text-center">{captions[1]}</span>
          <span className="text-right">{captions[2]}</span>
        </div>
      )}
      {note}
    </div>
  );
}

interface SegmentedProps<T extends string | number> {
  legend: string;
  hint?: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}

/** A radio group drawn as segments; arrow keys move between them. */
export function Segmented<T extends string | number>({ legend, hint, options, value, onChange }: SegmentedProps<T>) {
  const name = useId();
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="p-0 font-semibold">{legend}</legend>
      {hint && <p className="hint mb-1.5">{hint}</p>}
      <div className="seg">
        {options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={name}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface SwitchProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function Switch({ label, hint, checked, onChange }: SwitchProps) {
  const id = useId();
  return (
    <div>
      <label className="switch">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="track" aria-hidden="true" />
        <span>{label}</span>
      </label>
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
    </div>
  );
}
