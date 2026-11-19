'use client';

import React, { useEffect, useRef, useState } from 'react';
import { RissetAudioEngine } from '@/lib/risset-audio';

interface Props {
  engineRef: React.MutableRefObject<RissetAudioEngine | null>;
  sampleId: string;
}

const instruments = [
  { name: 'Kick', symbol: 'kick' },
  { name: 'Snare', symbol: 'snare' },
  { name: 'Hi-hat', symbol: 'hat' },
  { name: 'Percussion', symbol: 'perc' },
  { name: 'Bass', symbol: 'bass' },
  { name: 'Keys', symbol: 'keys' },
  { name: 'Lead', symbol: 'lead' },
  { name: 'Chord', symbol: 'chord' },
] as const;

function InstrumentSymbol({ index }: { index: number }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 };
  if (index === 0) return <svg viewBox="0 0 32 24" className="h-6 w-8" aria-hidden="true"><circle cx="16" cy="12" r="9" {...common} /><circle cx="16" cy="12" r="3" fill="currentColor" /></svg>;
  if (index === 1) return <svg viewBox="0 0 32 24" className="h-6 w-8" aria-hidden="true"><path d="M2 12H8L11 4L17 20L21 8L24 12H30" {...common} /></svg>;
  if (index === 2) return <svg viewBox="0 0 32 24" className="h-6 w-8" aria-hidden="true"><path d="M5 7V17M12 3V21M19 7V17M26 3V21" {...common} /></svg>;
  if (index === 3) return <svg viewBox="0 0 32 24" className="h-6 w-8" aria-hidden="true"><path d="M3 12L8 5L13 19L19 7L24 17L29 12" {...common} /></svg>;
  if (index === 4) return <svg viewBox="0 0 32 24" className="h-6 w-8" aria-hidden="true"><path d="M2 12C7 2 11 2 16 12S25 22 30 12" {...common} /></svg>;
  if (index === 5) return <svg viewBox="0 0 32 24" className="h-6 w-8" aria-hidden="true"><path d="M2 12H8V5H14V12H20V19H26V12H30" {...common} /></svg>;
  if (index === 6) return <svg viewBox="0 0 32 24" className="h-6 w-8" aria-hidden="true"><path d="M2 20L9 4V20L16 4V20L23 4V20L30 4" {...common} /></svg>;
  return <svg viewBox="0 0 32 24" className="h-6 w-8" aria-hidden="true"><path d="M3 19L10 5M10 19L17 5M17 19L24 5M24 19L31 5" {...common} /></svg>;
}

export default function RissetPerformanceSurface({ engineRef, sampleId }: Props) {
  const [active, setActive] = useState<number[]>([]);
  const [peaks, setPeaks] = useState<number[]>([]);
  const scratchRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; time: number }>());

  useEffect(() => {
    setPeaks(engineRef.current?.getScratchPeaks(128) ?? []);
  }, [engineRef, sampleId]);

  const startPad = (event: React.PointerEvent<HTMLButtonElement>, index: number) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const velocity = event.pressure > 0 && event.pressure !== 0.5 ? event.pressure : 0.85 - fraction * 0.35;
    const pitchShift = index >= 4 ? Math.round((0.5 - fraction) * 12) : 0;
    engineRef.current?.triggerFingerInstrument(index, velocity, pitchShift);
    setActive((previous) => [...previous, index]);
  };

  const endPad = (event: React.PointerEvent<HTMLButtonElement>, index: number) => {
    event.stopPropagation();
    setActive((previous) => previous.filter((item) => item !== index));
  };

  const scratchPosition = (x: number) => {
    const rect = scratchRef.current?.getBoundingClientRect();
    return rect ? Math.max(0, Math.min(1, (x - rect.left) / rect.width)) : 0;
  };

  const updateCursor = (fraction: number) => {
    if (cursorRef.current) cursorRef.current.style.left = String(fraction * 100) + '%';
  };

  const startScratch = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const fraction = scratchPosition(event.clientX);
    updateCursor(fraction);
    pointers.current.set(event.pointerId, { x: event.clientX, time: performance.now() });
    engineRef.current?.scratchAt(fraction, 0.7);
  };

  const moveScratch = (event: React.PointerEvent<HTMLDivElement>) => {
    const last = pointers.current.get(event.pointerId);
    if (!last) return;
    event.stopPropagation();
    event.preventDefault();
    const now = performance.now();
    const dx = event.clientX - last.x;
    const dt = now - last.time;
    if (Math.abs(dx) < 2 || dt < 14) return;
    const fraction = scratchPosition(event.clientX);
    updateCursor(fraction);
    engineRef.current?.scratchAt(fraction, dx / dt);
    pointers.current.set(event.pointerId, { x: event.clientX, time: now });
  };

  const endScratch = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    pointers.current.delete(event.pointerId);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-black text-white" aria-label="Fingertip instruments and scratch sampler">
      <div className="grid min-h-0 flex-1 grid-cols-4 grid-rows-2">
        {instruments.map((instrument, index) => (
          <button
            key={instrument.name}
            type="button"
            data-pad={index}
            aria-label={instrument.name + ', play with fingertip'}
            aria-pressed={active.includes(index)}
            onPointerDown={(event) => startPad(event, index)}
            onPointerUp={(event) => endPad(event, index)}
            onPointerCancel={(event) => endPad(event, index)}
            className={'flex min-h-0 min-w-0 select-none items-center justify-center border-r border-b border-white/30 touch-none focus-visible:outline focus-visible:outline-white ' +
              (active.includes(index) ? 'bg-white text-black' : 'bg-black text-white')}
          >
            <InstrumentSymbol index={index} />
          </button>
        ))}
      </div>
      <div
        ref={scratchRef}
        role="slider"
        aria-label="Scratch through the current audio sample by dragging horizontally, in either direction"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={50}
        tabIndex={0}
        onPointerDown={startScratch}
        onPointerMove={moveScratch}
        onPointerUp={endScratch}
        onPointerCancel={endScratch}
        className="relative flex h-[82px] min-h-[62px] shrink-0 touch-none items-center overflow-hidden border-t border-white/50 bg-black"
      >
        <div className="pointer-events-none grid h-4/5 w-full grid-flow-col items-center gap-px px-2" style={{ gridTemplateColumns: 'repeat(' + Math.max(1, peaks.length) + ', minmax(0, 1fr))' }}>
          {peaks.map((peak, index) => (
            <span key={index} className="block w-full bg-white/80" style={{ height: String(Math.max(2, Math.round(peak * 100))) + '%' }} />
          ))}
        </div>
        <div ref={cursorRef} className="pointer-events-none absolute bottom-0 top-0 left-1/2 w-px bg-white" />
      </div>
    </div>
  );
}
