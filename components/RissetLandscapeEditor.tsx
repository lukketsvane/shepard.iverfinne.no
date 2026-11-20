'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Play, Square, Upload, SkipForward } from 'lucide-react';
import { DrumTrackId, RissetEngineParams, RissetPattern, getVoicesSnapshotAtTime } from '@/lib/risset-math';
import { RissetAudioEngine } from '@/lib/risset-audio';

const TRACKS: DrumTrackId[] = ['low', 'mid', 'high', 'hemiola'];

interface Props {
  engineRef: React.MutableRefObject<RissetAudioEngine | null>;
  params: RissetEngineParams;
  pattern: RissetPattern;
  isPlaying: boolean;
  recordingState: 'idle' | 'recording' | 'processing' | 'ready';
  recordingSeconds: number;
  onTogglePlay: () => Promise<void>;
  onRecord: (event: React.MouseEvent) => void;
  onExportMidi: (event: React.MouseEvent) => void;
  onOpenFile: (event: React.MouseEvent) => void;
  onCyclePreset: (event: React.MouseEvent) => void;
  onCycleStep: (track: DrumTrackId, step: number) => void;
  onVelocity: (track: DrumTrackId, step: number, value: number) => void;
  onShiftTrack: (track: DrumTrackId, delta: number) => void;
}

function TrackMark({ role }: { role: DrumTrackId }) {
  if (role === 'low') {
    return <svg viewBox="0 0 28 28" aria-hidden="true" className="h-6 w-6"><circle cx="14" cy="14" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="14" cy="14" r="3" fill="currentColor" /></svg>;
  }
  if (role === 'mid') {
    return <svg viewBox="0 0 28 28" aria-hidden="true" className="h-6 w-6"><path d="M3 14H7L10 6L15 22L19 11L22 14H25" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
  }
  if (role === 'high') {
    return <svg viewBox="0 0 28 28" aria-hidden="true" className="h-6 w-6"><path d="M4 8V20M9 4V24M14 8V20M19 4V24M24 8V20" stroke="currentColor" strokeWidth="1.5" /></svg>;
  }
  return <svg viewBox="0 0 28 28" aria-hidden="true" className="h-6 w-6"><circle cx="10" cy="14" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="18" cy="14" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
}

export default function RissetLandscapeEditor({
  engineRef,
  params,
  pattern,
  isPlaying,
  recordingState,
  recordingSeconds,
  onTogglePlay,
  onRecord,
  onExportMidi,
  onOpenFile,
  onCyclePreset,
  onCycleStep,
  onVelocity,
  onShiftTrack,
}: Props) {
  const [selectedTrack, setSelectedTrack] = useState<DrumTrackId>('low');
  const [playhead, setPlayhead] = useState(0);
  const velocityRef = useRef<HTMLDivElement>(null);
  const steps = pattern.stepsPerBar;

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    const tick = () => {
      const elapsed = engineRef.current?.getElapsedSeconds() ?? 0;
      const voices = getVoicesSnapshotAtTime(elapsed, params, steps, pattern.beatsPerBar).voices;
      const dominant = voices.reduce((best, voice) =>
        voice.effectiveGain > best.effectiveGain ? voice : best
      );
      setPlayhead(dominant.currentStep);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [engineRef, isPlaying, params, steps, pattern.beatsPerBar]);

  const setVelocityFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = velocityRef.current?.getBoundingClientRect();
    if (!rect) return;
    const index = Math.max(0, Math.min(steps - 1, Math.floor(((event.clientX - rect.left) / rect.width) * steps)));
    const value = Math.max(0.05, Math.min(1, 1 - (event.clientY - rect.top) / rect.height));
    onVelocity(selectedTrack, index, value);
  };

  const iconButton = 'flex h-10 w-10 shrink-0 items-center justify-center text-white/80 active:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-white';
  const notes = pattern.tracks[selectedTrack];

  return (
    <section
      aria-label="Landscape rhythm editor"
      className="absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden bg-black text-white pl-[max(12px,env(safe-area-inset-left))] pr-[max(12px,env(safe-area-inset-right))] pt-[max(4px,env(safe-area-inset-top))] pb-[max(4px,env(safe-area-inset-bottom))]"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/30">
        <button className={iconButton} onClick={onTogglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? <Square size={18} fill="currentColor" strokeWidth={1} /> : <Play size={20} fill="currentColor" strokeWidth={1} />}
        </button>
        <button className={iconButton} onClick={onCyclePreset} aria-label="Next preset"><SkipForward size={18} /></button>
        <a
          href="/fingertip.html"
          aria-label="Open Fingertip sound laboratory"
          className="flex h-10 items-center px-2 text-[11px] font-semibold tracking-[0.08em] text-white/80 active:text-white"
        >
          FINGERTIP
        </a>
        <div className="flex-1" />
        <button className={iconButton} onClick={onOpenFile} aria-label="Load audio or MIDI"><Upload size={19} /></button>
        <button className={iconButton} onClick={onExportMidi} aria-label="Download MIDI"><Download size={19} /></button>
        <button
          className={`${iconButton} min-w-[52px] font-[family-name:var(--font-mono)] text-[11px] font-semibold ${recordingState === 'recording' ? '!text-red-600 animate-pulse' : ''}`}
          onClick={onRecord}
          disabled={recordingState === 'processing'}
          aria-label={recordingState === 'recording' ? 'Stop recording' : recordingState === 'ready' ? 'Download WAV recording' : 'Record'}
        >
          {recordingState === 'ready'
            ? `${String(Math.floor(recordingSeconds / 60)).padStart(2, '0')}:${String(recordingSeconds % 60).padStart(2, '0')}`
            : recordingState === 'processing' ? '...' : 'REC'}
        </button>
      </div>

      <div className="ml-[52px] mr-[1px] grid h-6 shrink-0 items-center border-b border-white/20" style={{ gridTemplateColumns: `repeat(${steps}, minmax(0, 1fr))` }}>
        {Array.from({ length: steps }, (_, index) => (
          <span key={index} className={`mx-auto w-px ${index % 4 === 0 ? 'h-3 bg-white' : 'h-1.5 bg-white/40'}`} />
        ))}
      </div>

      <div className="relative flex min-h-[112px] flex-1 flex-col">
        <div className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-white" style={{ left: `calc(52px + (100% - 52px) * ${(playhead + 0.5) / steps})` }} />
        {TRACKS.map((role) => (
          <div key={role} className={`flex min-h-0 flex-1 border-b border-white/25 ${selectedTrack === role ? 'text-white' : 'text-white/60'}`}>
            <button
              className="flex w-[52px] shrink-0 items-center justify-center focus-visible:outline focus-visible:outline-1 focus-visible:outline-white"
              aria-pressed={selectedTrack === role}
              aria-label={`Edit ${role} track velocities`}
              onClick={() => setSelectedTrack(role)}
            >
              <TrackMark role={role} />
            </button>
            <div className="grid min-w-0 flex-1" style={{ gridTemplateColumns: `repeat(${steps}, minmax(0, 1fr))` }}>
              {pattern.tracks[role].map((note, index) => (
                <button
                  key={index}
                  aria-label={`${role} step ${index + 1}, ${note.active ? 'active' : 'inactive'}, velocity ${Math.round(note.velocity * 100)} percent`}
                  aria-pressed={note.active}
                  onClick={() => { setSelectedTrack(role); onCycleStep(role, index); }}
                  className="flex min-w-0 items-center justify-center border-r border-white/20 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white"
                >
                  {note.active ? (
                    <span className="block w-[74%] bg-white" style={{ height: note.tier === 0 ? '76%' : note.tier === 1 ? '50%' : '25%' }} />
                  ) : <span className="block h-[8%] w-[28%] bg-white/15" />}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex h-[76px] shrink-0 items-stretch gap-3 pt-2">
        <div className="flex w-[52px] shrink-0 items-center justify-center"><TrackMark role={selectedTrack} /></div>
        <div
          ref={velocityRef}
          role="slider"
          aria-label="Selected track step velocities; drag horizontally and vertically"
          aria-valuemin={5}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.max(0.05, ...notes.filter(note => note.active).map(note => note.velocity)) * 100)}
          tabIndex={0}
          className="grid min-w-0 flex-1 cursor-crosshair items-end border-b border-white/50"
          style={{ gridTemplateColumns: `repeat(${steps}, minmax(0, 1fr))` }}
          onPointerDown={(event) => {
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            setVelocityFromPointer(event);
          }}
          onPointerMove={(event) => {
            if ((event.buttons & 1) !== 0) {
              event.stopPropagation();
              setVelocityFromPointer(event);
            }
          }}
        >
          {notes.map((note, index) => (
            <div key={index} className="flex h-full min-w-0 items-end justify-center border-r border-white/10">
              {note.active && <span className="block w-[40%] bg-white" style={{ height: `${Math.round(note.velocity * 100)}%` }} />}
            </div>
          ))}
        </div>
        <button className={iconButton} onClick={() => onShiftTrack(selectedTrack, -1)} aria-label="Shift selected rhythm one step earlier"><ChevronLeft size={23} /></button>
        <button className={iconButton} onClick={() => onShiftTrack(selectedTrack, 1)} aria-label="Shift selected rhythm one step later"><ChevronRight size={23} /></button>
      </div>
    </section>
  );
}
