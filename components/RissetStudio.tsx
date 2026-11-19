'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import RissetPhaseCanvas, { ActiveTouchOverlay } from './RissetPhaseCanvas';

const PRESET_SHORT_CODES = ['TROY', '4/4', 'CLICK', 'DECEL'];

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
  const [hudText, setHudText] = useState<string | null>(null);

  const engineRef = useRef<RissetAudioEngine | null>(null);
  const paramsRef = useRef<RissetEngineParams>(params);

  const hudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchOverlayRef = useRef<ActiveTouchOverlay>({
    points: [],
    rotationOffsetRad: 0,
  });

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

  const flashHud = useCallback((label: string) => {
    setHudText(label);
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    hudTimerRef.current = setTimeout(() => {
      setHudText(null);
    }, 650);
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
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
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
          flashHud(`${nextCycle}S`);
        }
        return;
      }

      // Trackpad two-finger pan vertical (Shepard Riser) & horizontal (3:2 Hemiola)
      if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        const nextRiser = Number(
          clamp(cur.shepardRiserMix - e.deltaY * 0.0025, 0, 1).toFixed(3)
        );
        setParams((prev) => ({ ...prev, shepardRiserMix: nextRiser }));
        flashHud(`RISE ${Math.round(nextRiser * 100)}`);
      } else {
        const nextHemi = Number(
          clamp(cur.hemiolaMix + e.deltaX * 0.0025, 0, 1).toFixed(3)
        );
        setParams((prev) => ({ ...prev, hemiolaMix: nextHemi }));
        flashHud(`3:2 ${Math.round(nextHemi * 100)}`);
      }
    };

    document.addEventListener('gesturestart', prevent, { passive: false });
    document.addEventListener('gesturechange', prevent, { passive: false });
    document.addEventListener('gestureend', prevent, { passive: false });
    document.addEventListener('touchmove', prevent, { passive: false });
    document.addEventListener('selectstart', prevent);
    document.addEventListener('contextmenu', prevent);
    window.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      document.removeEventListener('gesturestart', prevent);
      document.removeEventListener('gesturechange', prevent);
      document.removeEventListener('gestureend', prevent);
      document.removeEventListener('touchmove', prevent);
      document.removeEventListener('selectstart', prevent);
      document.removeEventListener('contextmenu', prevent);
      window.removeEventListener('wheel', onWheel);
    };
  }, [flashHud]);

  useEffect(() => {
    paramsRef.current = params;
    engineRef.current?.updateParams(params);
  }, [params]);

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

  // Keyboard shortcut (Space = Play/Pause, Arrow keys = Tempo/Direction)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'BUTTON') return;
        e.preventDefault();
        handleTogglePlay();
      } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        e.preventDefault();
        const delta = e.code === 'ArrowUp' ? 4 : -4;
        setParams((prev) => {
          const nextBpm = clamp(prev.centerBpm + delta, 72, 176);
          flashHud(`${nextBpm}`);
          return { ...prev, centerBpm: nextBpm };
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleTogglePlay, flashHud]);

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
      flashHud(PRESET_SHORT_CODES[nextIdx]);
    },
    [presetIndex, flashHud]
  );

  const handleCycleSolo = useCallback(
    (e: React.MouseEvent | React.PointerEvent) => {
      e.stopPropagation();
      setParams((prev) => {
        const nextSolo =
          prev.soloVoiceIndex === null
            ? 0
            : prev.soloVoiceIndex + 1 >= prev.numVoices
              ? null
              : prev.soloVoiceIndex + 1;
        flashHud(nextSolo === null ? 'ALL' : `V${nextSolo + 1}`);
        return { ...prev, soloVoiceIndex: nextSolo };
      });
    },
    [flashHud]
  );

  const syncTouchOverlayPoints = () => {
    touchOverlayRef.current.points = Array.from(
      activePointersRef.current.values()
    ).slice(0, 2);
  };

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest('button')) return;

      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointer events may not register hardware capture
      }
      const pt = { x: e.clientX, y: e.clientY };
      activePointersRef.current.set(e.pointerId, pt);
      syncTouchOverlayPoints();

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
      syncTouchOverlayPoints();

      const vw = window.innerWidth || 390;
      const vh = window.innerHeight || 844;
      const count = activePointersRef.current.size;

      // Two-Finger Gestures: Vertical, Horizontal, Pinch, Rotate
      if (count >= 2 && twoFingerAnchorRef.current) {
        const [p1, p2] = Array.from(activePointersRef.current.values());
        const res = evaluateTwoFingerGesture(
          twoFingerAnchorRef.current,
          p1,
          p2,
          vw,
          vh
        );

        touchOverlayRef.current.rotationOffsetRad = res.deltaAngleRad * 0.4;

        if (Object.keys(res.patch).length > 0) {
          setParams((prev) => ({ ...prev, ...res.patch }));
        }
        if (res.activeHudLabel) {
          flashHud(res.activeHudLabel);
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
          touchOverlayRef.current.rotationOffsetRad = diff * 0.4;
          if (Math.abs(diff) > 0.22) {
            const dir = diff > 0 ? 'accelerando' : 'decelerando';
            setParams((prev) => ({ ...prev, direction: dir }));
            flashHud(dir === 'accelerando' ? 'ACCEL' : 'DECEL');
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
            flashHud(`RISE ${Math.round(nextRiser * 100)}`);
          } else {
            const nextHemi = Number(
              clamp(paramsRef.current.hemiolaMix + dx / (vw * 4), 0, 1).toFixed(
                3
              )
            );
            start.point = pt;
            setParams((prev) => ({ ...prev, hemiolaMix: nextHemi }));
            flashHud(`3:2 ${Math.round(nextHemi * 100)}`);
          }
          return;
        }

        // Standard 1-Finger Drag: Vertical = Focal Tempo, Horizontal = Dropped Subdivisions
        if (Math.abs(dy) >= Math.abs(dx)) {
          const nextBpm = applyOneFingerVerticalTempo(start.startBpm, dy, vh);
          setParams((prev) => ({ ...prev, centerBpm: nextBpm }));
          flashHud(`${nextBpm}`);
        } else {
          const nextSub = applyOneFingerHorizontalSubdivisions(
            start.startSubDrop,
            dx,
            vw
          );
          setParams((prev) => ({ ...prev, droppedSubdivisions: nextSub }));
          flashHud(`SUB ${Math.round(nextSub * 100)}`);
        }
      }
    },
    [flashHud]
  );

  const handlePointerEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const wasSingleTap =
        !hadMultiTouchRef.current &&
        activePointersRef.current.size === 1 &&
        oneFingerStartRef.current !== null &&
        !oneFingerStartRef.current.moved;

      activePointersRef.current.delete(e.pointerId);
      syncTouchOverlayPoints();

      if (activePointersRef.current.size < 2) {
        twoFingerAnchorRef.current = null;
        touchOverlayRef.current.rotationOffsetRad = 0;
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

  return (
    <main
      data-playback={isPlaying ? 'playing' : 'paused'}
      data-direction={params.direction}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      className="relative fixed inset-0 w-screen h-[100dvh] overflow-hidden bg-black text-white select-none touch-none"
    >
      {/* Full-Viewport Monochrome Risset Geometry */}
      <RissetPhaseCanvas
        engineRef={engineRef}
        params={params}
        pattern={pattern}
        isPlaying={isPlaying}
        touchOverlayRef={touchOverlayRef}
      />

      {/* Whisper-Minimal Top Safe-Area Corner Controls (avoids iOS Home Bar & bottom-left overlay) */}
      <div className="fixed inset-x-0 top-0 pt-[max(0.75rem,env(safe-area-inset-top))] px-[max(1rem,env(safe-area-inset-left))] flex items-center justify-between pointer-events-none">
        <button
          type="button"
          onClick={handleCyclePreset}
          aria-label={`Preset ${PRESET_SHORT_CODES[presetIndex]}`}
          className="pointer-events-auto min-w-[48px] min-h-[48px] px-2 flex items-center justify-center text-[11px] tracking-[0.16em] font-[family-name:var(--font-mono)] text-white/55 hover:text-white active:opacity-100 transition-opacity whitespace-nowrap"
        >
          {PRESET_SHORT_CODES[presetIndex]}
        </button>

        {/* Transient Single-Token Monochrome Gesture HUD (invisible at rest) */}
        <div
          aria-live="polite"
          className={`pointer-events-none text-[11px] tracking-[0.2em] font-[family-name:var(--font-mono)] tabular-nums text-white transition-opacity duration-150 whitespace-nowrap ${
            hudText ? 'opacity-95' : 'opacity-0'
          }`}
        >
          {hudText ?? ''}
        </div>

        <button
          type="button"
          onClick={handleCycleSolo}
          aria-label={
            params.soloVoiceIndex === null
              ? 'All voices active'
              : `Solo voice ${params.soloVoiceIndex + 1}`
          }
          className="pointer-events-auto min-w-[48px] min-h-[48px] px-2 flex items-center justify-center text-[11px] tracking-[0.16em] font-[family-name:var(--font-mono)] text-white/55 hover:text-white active:opacity-100 transition-opacity whitespace-nowrap"
        >
          {params.soloVoiceIndex === null
            ? 'ALL'
            : `V${params.soloVoiceIndex + 1}`}
        </button>
      </div>

      {/* Center Core Trigger (Play Symbol when paused, minimal BPM numeral when playing) */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handleTogglePlay();
        }}
        aria-label={isPlaying ? 'Pause rhythm' : 'Start rhythm'}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 rounded-full flex items-center justify-center text-white focus-visible:outline-1 focus-visible:outline-white/60 active:scale-95 transition-transform"
      >
        {isPlaying ? (
          <span className="text-xs font-[family-name:var(--font-mono)] tabular-nums tracking-wider text-white/90">
            {params.centerBpm}
            {params.direction === 'accelerando' ? '↑' : '↓'}
          </span>
        ) : (
          <Play
            className="w-5 h-5 text-white fill-white translate-x-[1px]"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        )}
      </button>
    </main>
  );
}
