'use client';

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Play } from 'lucide-react';
import { RissetEngineParams, RissetPattern } from '@/lib/risset-math';
import { RISSET_PRESETS, clonePattern } from '@/lib/risset-presets';
import { RissetAudioEngine } from '@/lib/risset-audio';
import {
  TouchPoint,
  TwoFingerAnchor,
  applyOneFingerHorizontalSubdivisions,
  applyOneFingerVerticalTempo,
  clamp,
  createTwoFingerAnchor,
  evaluateTwoFingerGesture,
} from '@/lib/gesture-math';
import RissetPhaseCanvas from './RissetPhaseCanvas';
import {
  buildIcctWavSamplePack,
  buildStandardMidiFile,
  parseStandardMidiFileToPattern,
} from '@/lib/icct-midi';

const PRESET_SHORT_CODES = ['ICCT', 'TROY', '4/4', 'CLICK', 'DECEL'];

function subscribeColorScheme(callback: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', callback);
    return () => mql.removeEventListener('change', callback);
  }
  mql.addListener(callback);
  return () => mql.removeListener(callback);
}

function getColorSchemeSnapshot(): 'dark' | 'light' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function getServerColorSchemeSnapshot(): 'dark' | 'light' {
  return 'dark';
}

export default function RissetStudio() {
  const initialPreset = RISSET_PRESETS[0];
  const [presetIndex, setPresetIndex] = useState<number>(0);
  const [params, setParams] = useState<RissetEngineParams>(() => ({
    ...initialPreset.params,
  }));
  const [pattern, setPattern] = useState<RissetPattern>(() =>
    clonePattern(initialPreset.pattern)
  );
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const systemTheme = useSyncExternalStore(
    subscribeColorScheme,
    getColorSchemeSnapshot,
    getServerColorSchemeSnapshot
  );
  const [detailText, setDetailText] = useState<string | null>(null);

  const engineRef = useRef<RissetAudioEngine | null>(null);
  const paramsRef = useRef<RissetEngineParams>(params);
  const isPlayingRef = useRef<boolean>(isPlaying);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const detailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Gesture tracking refs
  const activePointersRef = useRef<Map<number, TouchPoint>>(new Map());
  const oneFingerStartRef = useRef<{
    point: TouchPoint;
    startBpm: number;
    startSubDrop: number;
    moved: boolean;
  } | null>(null);
  const twoFingerAnchorRef = useRef<TwoFingerAnchor | null>(null);
  const hadMultiTouchRef = useRef<boolean>(false);

  const showDetail = useCallback((label: string) => {
    setDetailText(label);
    if (detailTimerRef.current) clearTimeout(detailTimerRef.current);
    detailTimerRef.current = setTimeout(() => {
      setDetailText(null);
    }, 800);
  }, []);

  // Initialize Web Audio Engine & ?autostart=1
  useEffect(() => {
    const engine = new RissetAudioEngine(
      initialPreset.params,
      clonePattern(initialPreset.pattern)
    );
    engineRef.current = engine;

    if (typeof window !== 'undefined') {
      const search = new URLSearchParams(window.location.search);
      if (search.get('autostart') === '1') {
        engine.start().then(() => {
          setIsPlaying(true);
        });
      }
    }

    return () => {
      if (detailTimerRef.current) clearTimeout(detailTimerRef.current);
      engine.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lock iOS Safari native zoom, scroll, selection, and trackpad gestures
  useEffect(() => {
    const prevent = (e: Event) => {
      e.preventDefault();
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cur = paramsRef.current;

      // Trackpad pinch (ctrlKey) -> Cycle Period
      if (e.ctrlKey) {
        const nextCycle = Math.round(
          clamp(cur.targetCycleSeconds + e.deltaY * 0.12, 8, 40)
        );
        if (nextCycle !== cur.targetCycleSeconds) {
          setParams((prev) => ({ ...prev, targetCycleSeconds: nextCycle }));
          showDetail(`CYCLE ${nextCycle}S`);
        }
        return;
      }

      // Trackpad two-finger pan vertical (Shepard Riser) & horizontal (3:2 Hemiola)
      if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        const nextRiser = Number(
          clamp(cur.shepardRiserMix - e.deltaY * 0.0025, 0, 1).toFixed(3)
        );
        setParams((prev) => ({ ...prev, shepardRiserMix: nextRiser }));
        showDetail(`RISE ${Math.round(nextRiser * 100)}%`);
      } else {
        const nextHemi = Number(
          clamp(cur.hemiolaMix + e.deltaX * 0.0025, 0, 1).toFixed(3)
        );
        setParams((prev) => ({ ...prev, hemiolaMix: nextHemi }));
        showDetail(`3:2 ${Math.round(nextHemi * 100)}%`);
      }
    };

    const clearAllPointers = () => {
      activePointersRef.current.clear();
      oneFingerStartRef.current = null;
      twoFingerAnchorRef.current = null;
    };

    const onTouchResetCheck = (e: TouchEvent) => {
      if (e.touches.length === 0 && activePointersRef.current.size > 0) {
        clearAllPointers();
      }
    };

    document.addEventListener('gesturestart', prevent, { passive: false });
    document.addEventListener('gesturechange', prevent, { passive: false });
    document.addEventListener('gestureend', prevent, { passive: false });
    document.addEventListener('touchmove', prevent, { passive: false });
    document.addEventListener('touchend', onTouchResetCheck, { passive: true });
    document.addEventListener('touchcancel', clearAllPointers, { passive: true });
    document.addEventListener('selectstart', prevent);
    document.addEventListener('contextmenu', prevent);
    window.addEventListener('blur', clearAllPointers);
    window.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      document.removeEventListener('gesturestart', prevent);
      document.removeEventListener('gesturechange', prevent);
      document.removeEventListener('gestureend', prevent);
      document.removeEventListener('touchmove', prevent);
      document.removeEventListener('touchend', onTouchResetCheck);
      document.removeEventListener('touchcancel', clearAllPointers);
      document.removeEventListener('selectstart', prevent);
      document.removeEventListener('contextmenu', prevent);
      window.removeEventListener('blur', clearAllPointers);
      window.removeEventListener('wheel', onWheel);
    };
  }, [showDetail]);

  useEffect(() => {
    paramsRef.current = params;
    engineRef.current?.updateParams(params);
  }, [params]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    engineRef.current?.updatePattern(pattern);
  }, [pattern]);

  const handleTogglePlay = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.getIsPlaying()) {
      engine.pause();
      setIsPlaying(false);
    } else {
      await engine.start();
      setIsPlaying(true);
    }
  }, []);

  // Keyboard shortcut (Space = Play/Pause, Arrow keys = Tempo)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'BUTTON' || tag === 'A') return;
        e.preventDefault();
        handleTogglePlay();
      } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        e.preventDefault();
        const delta = e.code === 'ArrowUp' ? 4 : -4;
        setParams((prev) => {
          const nextBpm = clamp(prev.centerBpm + delta, 72, 176);
          if (!isPlayingRef.current) {
            showDetail(`${nextBpm} BPM`);
          }
          return { ...prev, centerBpm: nextBpm };
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleTogglePlay, showDetail]);

  // Preset cycling updates top-left button directly — no redundant mode readout
  const handleCyclePreset = useCallback(
    (e: React.MouseEvent | React.PointerEvent) => {
      e.stopPropagation();
      const nextIdx = (presetIndex + 1) % RISSET_PRESETS.length;
      const nextPreset = RISSET_PRESETS[nextIdx];
      setPresetIndex(nextIdx);
      setParams((prev) => ({
        ...nextPreset.params,
        masterVolume: prev.masterVolume,
      }));
      setPattern(clonePattern(nextPreset.pattern));
      engineRef.current?.resetCycle();
    },
    [presetIndex]
  );

  const triggerBlobDownload = useCallback(
    (bytes: Uint8Array, filename: string, mimeType: string) => {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const blob = new Blob([copy], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    },
    []
  );

  const handleExportMidi = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const presetSlug = RISSET_PRESETS[presetIndex]?.id ?? 'icct-hedral';
      const midiBytes = buildStandardMidiFile(pattern, params, 8);
      triggerBlobDownload(midiBytes, `${presetSlug}-risset.mid`, 'audio/midi');
    },
    [presetIndex, pattern, params, triggerBlobDownload]
  );

  const handleExportSamplesWav = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const wavBytes = buildIcctWavSamplePack(params.centerBpm, 44100);
      triggerBlobDownload(
        wavBytes,
        `icct-hedral-fz10m-${params.centerBpm}bpm.wav`,
        'audio/wav'
      );
    },
    [params.centerBpm, triggerBlobDownload]
  );

  const ingestUserFile = useCallback(
    async (file: File) => {
      const lower = file.name.toLowerCase();
      const buf = await file.arrayBuffer();
      if (lower.endsWith('.mid') || lower.endsWith('.midi')) {
        const parsed = parseStandardMidiFileToPattern(
          new Uint8Array(buf),
          pattern.stepsPerBar
        );
        if (parsed) {
          setPattern(parsed.pattern);
          const appliedBpm = parsed.detectedBpm
            ? clamp(parsed.detectedBpm, 72, 176)
            : paramsRef.current.centerBpm;
          if (parsed.detectedBpm) {
            setParams((prev) => ({ ...prev, centerBpm: appliedBpm }));
          }
          engineRef.current?.resetCycle();
          showDetail(`${appliedBpm} BPM`);
        }
        return;
      }

      const ok = await engineRef.current?.loadCustomSample(buf);
      if (ok) {
        setParams((prev) => ({ ...prev, soundKit: 'custom' }));
      }
    },
    [pattern.stepsPerBar, showDetail]
  );

  const handleOpenFilePicker = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        void ingestUserFile(file);
      }
      e.target.value = '';
    },
    [ingestUserFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files?.[0];
      if (file) {
        void ingestUserFile(file);
      }
    },
    [ingestUserFile]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest('button, a')) return;

      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointer events may not register hardware capture
      }
      const pt = { x: e.clientX, y: e.clientY };
      activePointersRef.current.set(e.pointerId, pt);

      const count = activePointersRef.current.size;
      if (count === 1) {
        hadMultiTouchRef.current = false;
        oneFingerStartRef.current = {
          point: pt,
          startBpm: paramsRef.current.centerBpm,
          startSubDrop: paramsRef.current.droppedSubdivisions,
          moved: false,
        };
        twoFingerAnchorRef.current = null;
      } else if (count >= 2) {
        hadMultiTouchRef.current = true;
        oneFingerStartRef.current = null;
        const [p1, p2] = Array.from(activePointersRef.current.values());
        twoFingerAnchorRef.current = createTwoFingerAnchor(
          p1,
          p2,
          paramsRef.current
        );
      }
    },
    []
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!activePointersRef.current.has(e.pointerId)) return;
      const pt = { x: e.clientX, y: e.clientY };
      activePointersRef.current.set(e.pointerId, pt);

      const vw = window.innerWidth || 390;
      const vh = window.innerHeight || 844;
      const count = activePointersRef.current.size;

      // Two-Finger Gestures: Vertical (RISE %), Horizontal (3:2 %), Pinch (CYCLE S), Rotate (Direction + FOCUS %)
      if (count >= 2 && twoFingerAnchorRef.current) {
        const [p1, p2] = Array.from(activePointersRef.current.values());
        const res = evaluateTwoFingerGesture(
          twoFingerAnchorRef.current,
          p1,
          p2,
          vw,
          vh
        );

        if (Object.keys(res.patch).length > 0) {
          setParams((prev) => ({ ...prev, ...res.patch }));
        }
        if (res.activeHudLabel) {
          showDetail(res.activeHudLabel);
        }
        return;
      }

      // Desktop Shift+Drag emulates 2-Finger Vertical/Horizontal; Alt+Drag emulates Rotate
      if (count === 1 && oneFingerStartRef.current) {
        const start = oneFingerStartRef.current;
        const dx = pt.x - start.point.x;
        const dy = pt.y - start.point.y;
        const dist = Math.hypot(dx, dy);

        if (dist > 9) {
          start.moved = true;
        }
        if (!start.moved) return;

        if (e.altKey) {
          const cx = vw * 0.5;
          const cy = vh * 0.5;
          const a0 = Math.atan2(start.point.y - cy, start.point.x - cx);
          const a1 = Math.atan2(pt.y - cy, pt.x - cx);
          const diff = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
          if (Math.abs(diff) > 0.22) {
            const dir = diff > 0 ? 'accelerando' : 'decelerando';
            setParams((prev) => ({ ...prev, direction: dir }));
          }
          return;
        }

        if (e.shiftKey) {
          if (Math.abs(dy) >= Math.abs(dx)) {
            const nextRiser = Number(
              clamp(
                paramsRef.current.shepardRiserMix - dy / (vh * 4),
                0,
                1
              ).toFixed(3)
            );
            start.point = pt;
            setParams((prev) => ({ ...prev, shepardRiserMix: nextRiser }));
            showDetail(`RISE ${Math.round(nextRiser * 100)}%`);
          } else {
            const nextHemi = Number(
              clamp(paramsRef.current.hemiolaMix + dx / (vw * 4), 0, 1).toFixed(
                3
              )
            );
            start.point = pt;
            setParams((prev) => ({ ...prev, hemiolaMix: nextHemi }));
            showDetail(`3:2 ${Math.round(nextHemi * 100)}%`);
          }
          return;
        }

        // Standard 1-Finger Drag: Vertical = Focal Tempo, Horizontal = Dropped Subdivisions %
        if (Math.abs(dy) >= Math.abs(dx)) {
          const nextBpm = applyOneFingerVerticalTempo(start.startBpm, dy, vh);
          setParams((prev) => ({ ...prev, centerBpm: nextBpm }));
          if (!isPlayingRef.current) {
            showDetail(`${nextBpm} BPM`);
          }
        } else {
          const nextSub = applyOneFingerHorizontalSubdivisions(
            start.startSubDrop,
            dx,
            vw
          );
          setParams((prev) => ({ ...prev, droppedSubdivisions: nextSub }));
          showDetail(`SUB ${Math.round(nextSub * 100)}%`);
        }
      }
    },
    [showDetail]
  );

  const handlePointerEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const wasSingleTap =
        !hadMultiTouchRef.current &&
        activePointersRef.current.size === 1 &&
        oneFingerStartRef.current !== null &&
        !oneFingerStartRef.current.moved;

      activePointersRef.current.delete(e.pointerId);

      if (activePointersRef.current.size < 2) {
        twoFingerAnchorRef.current = null;
      }

      if (activePointersRef.current.size === 0) {
        oneFingerStartRef.current = null;
        if (wasSingleTap) {
          handleTogglePlay();
        }
      }
    },
    [handleTogglePlay]
  );

  const cornerControlClass =
    'pointer-events-auto min-w-[48px] min-h-[48px] px-2 flex items-center justify-center text-[11px] tracking-[0.16em] font-[family-name:var(--font-mono)] text-neutral-950/60 dark:text-white/55 hover:text-neutral-950 dark:hover:text-white active:opacity-100 transition-opacity whitespace-nowrap';

  return (
    <main
      data-playback={isPlaying ? 'playing' : 'paused'}
      data-direction={params.direction}
      data-preset={RISSET_PRESETS[presetIndex]?.id ?? 'icct-hedral'}
      data-theme={systemTheme}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      className="relative fixed inset-0 w-screen h-[100dvh] overflow-hidden bg-white dark:bg-black text-neutral-950 dark:text-white select-none touch-none"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".mid,.midi,.wav,.mp3,.ogg,.flac,audio/*"
        onChange={handleFileChange}
        aria-label="Import MIDI or audio sample file"
        className="hidden"
      />

      {/* Full-Viewport System-Theme Monochrome Risset Geometry */}
      <RissetPhaseCanvas
        engineRef={engineRef}
        params={params}
        pattern={pattern}
        isPlaying={isPlaying}
      />

      {/* Top Safe-Area Corners Only — Nothing Top-Aligned Center */}
      <div className="fixed inset-x-0 top-0 pt-[max(0.75rem,env(safe-area-inset-top))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] flex items-center justify-between pointer-events-none">
        <button
          type="button"
          onClick={handleCyclePreset}
          aria-label={`Preset ${PRESET_SHORT_CODES[presetIndex]}`}
          className={cornerControlClass}
        >
          {PRESET_SHORT_CODES[presetIndex]}
        </button>

        <a
          href="https://iverfinne.no"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          aria-label="Visit iverfinne.no (opens in a new tab)"
          className={cornerControlClass}
        >
          iverfinne.no
        </a>
      </div>

      {/* Bottom Safe-Area Bar: Percentage/Parameter Details in Bottom-Left + MIDI/WAV/LOAD in Bottom-Right */}
      <div className="fixed inset-x-0 bottom-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] flex items-center justify-between pointer-events-none">
        <div
          aria-live="polite"
          data-testid="bottom-left-detail"
          className={`min-h-[48px] px-2 flex items-center text-[11px] tracking-[0.16em] font-[family-name:var(--font-mono)] tabular-nums text-neutral-950/85 dark:text-white/85 transition-opacity duration-150 whitespace-nowrap ${
            detailText ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {detailText ?? ''}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleExportMidi}
            aria-label="Download MIDI file"
            className={cornerControlClass}
          >
            MIDI
          </button>
          <button
            type="button"
            onClick={handleExportSamplesWav}
            aria-label="Download FZ-10M WAV samples"
            className={cornerControlClass}
          >
            WAV
          </button>
          <button
            type="button"
            onClick={handleOpenFilePicker}
            aria-label="Load MIDI or WAV sample"
            className={cornerControlClass}
          >
            LOAD
          </button>
        </div>
      </div>

      {/* Center Core Trigger */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handleTogglePlay();
        }}
        aria-label={isPlaying ? 'Pause rhythm' : 'Start rhythm'}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 rounded-full flex items-center justify-center text-neutral-950 dark:text-white focus-visible:outline-1 focus-visible:outline-neutral-950/60 dark:focus-visible:outline-white/60 active:scale-95 transition-transform"
      >
        {isPlaying ? (
          <span className="text-xs font-[family-name:var(--font-mono)] tabular-nums tracking-wider text-neutral-950/90 dark:text-white/90">
            {params.centerBpm}
            {params.direction === 'accelerando' ? '↑' : '↓'}
          </span>
        ) : (
          <Play
            className="w-5 h-5 text-neutral-950 fill-neutral-950 dark:text-white dark:fill-white translate-x-[1px]"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        )}
      </button>
    </main>
  );
}
