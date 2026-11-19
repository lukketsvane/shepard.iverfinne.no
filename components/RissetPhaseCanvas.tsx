'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import {
  RissetEngineParams,
  RissetPattern,
  getVoicesSnapshotAtTime,
} from '@/lib/risset-math';
import { RissetAudioEngine } from '@/lib/risset-audio';

interface RissetPhaseCanvasProps {
  engineRef: React.MutableRefObject<RissetAudioEngine | null>;
  params: RissetEngineParams;
  pattern: RissetPattern;
  isPlaying: boolean;
}

export default function RissetPhaseCanvas({
  engineRef,
  params,
  pattern,
  isPlaying,
}: RissetPhaseCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef<{ width: number; height: number }>({
    width: 390,
    height: 844,
  });
  const isDarkRef = useRef<boolean>(true);

  const stateRef = useRef({
    params,
    pattern,
    isPlaying,
  });

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { params: curParams, pattern: curPattern } = stateRef.current;
    const engine = engineRef.current;
    const elapsed = engine ? engine.getElapsedSeconds() : 0;
    const flashes = engine ? engine.getRecentFlashes(elapsed) : [];

    const snapshot = getVoicesSnapshotAtTime(
      elapsed,
      curParams,
      curPattern.stepsPerBar,
      curPattern.beatsPerBar
    );

    drawMonochromeInstrument(
      canvas,
      sizeRef.current,
      snapshot,
      curParams,
      curPattern,
      flashes,
      elapsed,
      isDarkRef.current
    );
  }, [engineRef]);

  // Dynamically follow OS / device theme (prefers-color-scheme: dark) with zero reload
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    isDarkRef.current = mql.matches;
    renderFrame();

    const onThemeChange = (e: MediaQueryListEvent) => {
      isDarkRef.current = e.matches;
      renderFrame();
    };

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onThemeChange);
      return () => mql.removeEventListener('change', onThemeChange);
    }
    mql.addListener(onThemeChange);
    return () => mql.removeListener(onThemeChange);
  }, [renderFrame]);

  // Keep cached viewport size synced via ResizeObserver
  useEffect(() => {
    const syncSize = () => {
      const el = canvasRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        sizeRef.current = { width: rect.width, height: rect.height };
      }
      if (typeof window !== 'undefined' && window.matchMedia) {
        isDarkRef.current = window.matchMedia(
          '(prefers-color-scheme: dark)'
        ).matches;
      }
      renderFrame();
    };

    syncSize();
    if (typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(syncSize);
    if (canvasRef.current) obs.observe(canvasRef.current);
    return () => obs.disconnect();
  }, [renderFrame]);

  // Sync ref and redraw on param/pattern/playback change
  useEffect(() => {
    stateRef.current = { params, pattern, isPlaying };
    renderFrame();
  }, [params, pattern, isPlaying, renderFrame]);

  // Animate continuously while playing; render on-demand when paused
  useEffect(() => {
    if (!isPlaying) {
      renderFrame();
      return;
    }

    let rafId = 0;
    const loop = () => {
      renderFrame();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, renderFrame]);

  // Redraw on paused gesture adjustments
  useEffect(() => {
    const onPointerActivity = () => {
      if (!stateRef.current.isPlaying) {
        requestAnimationFrame(renderFrame);
      }
    };
    window.addEventListener('pointermove', onPointerActivity, { passive: true });
    window.addEventListener('pointerup', onPointerActivity, { passive: true });
    window.addEventListener('touchmove', onPointerActivity, { passive: true });
    window.addEventListener('touchend', onPointerActivity, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onPointerActivity);
      window.removeEventListener('pointerup', onPointerActivity);
      window.removeEventListener('touchmove', onPointerActivity);
      window.removeEventListener('touchend', onPointerActivity);
    };
  }, [renderFrame]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="risset-monochrome-canvas"
      aria-hidden="true"
      className="block w-full h-full bg-white dark:bg-black pointer-events-none"
    />
  );
}

function drawMonochromeInstrument(
  canvas: HTMLCanvasElement,
  cachedSize: { width: number; height: number },
  snapshot: ReturnType<typeof getVoicesSnapshotAtTime>,
  params: RissetEngineParams,
  pattern: RissetPattern,
  flashes: Array<{
    elapsedTime: number;
    voiceIndex: number;
    octavePosition: number;
    trackId: string;
    stepIndex: number;
    gain: number;
  }>,
  currentElapsed: number,
  isDark: boolean
) {
  const dpr = Math.min(
    typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
    2
  );
  const width = Math.max(10, Math.floor(cachedSize.width));
  const height = Math.max(10, Math.floor(cachedSize.height));
  const targetW = Math.floor(width * dpr);
  const targetH = Math.floor(height * dpr);

  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const bgHex = isDark ? '#000000' : '#ffffff';
  const inkRgb = isDark ? '255, 255, 255' : '10, 10, 10';
  // Optical compensation so fine hairlines remain crisp against bright white paper
  const hairlineBoost = isDark ? 1.0 : 1.35;

  const ink = (alpha: number) =>
    `rgba(${inkRgb}, ${Math.min(1, Math.max(0, alpha)).toFixed(3)})`;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = bgHex;
  ctx.fillRect(0, 0, width, height);

  const cx = width * 0.5;
  const cy = height * 0.5;
  const minDim = Math.min(width, height);

  // Subtle breathing scale tied to cycle period (pinch feedback)
  const cycleScale = 0.88 + ((params.targetCycleSeconds - 8) / 32) * 0.14;
  const maxR = minDim * 0.41 * cycleScale;
  const minR = Math.max(38, maxR * 0.23);
  const L = Math.max(3, params.numVoices);
  const steps = pattern.stepsPerBar;

  // 1. Outer Cycle Progress Hairline Ring
  const outerTrackR = maxR + 14;
  ctx.beginPath();
  ctx.arc(cx, cy, outerTrackR, 0, Math.PI * 2);
  ctx.strokeStyle = ink(0.09 * hairlineBoost);
  ctx.lineWidth = 1;
  ctx.stroke();

  if (snapshot.cycleProgress > 0.001) {
    const startAng = -Math.PI * 0.5;
    const sweep =
      params.direction === 'accelerando'
        ? snapshot.cycleProgress * Math.PI * 2
        : -snapshot.cycleProgress * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(
      cx,
      cy,
      outerTrackR,
      startAng,
      startAng + sweep,
      params.direction === 'decelerando'
    );
    ctx.strokeStyle = ink(0.55);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // 2. Shepard Pitch Riser Harmonic Core Rings
  if (params.shepardRiserMix > 0.01) {
    const harmonics = 3;
    for (let h = 0; h < harmonics; h++) {
      const frac = (((snapshot.cycleProgress + h / harmonics) % 1) + 1) % 1;
      const hFrac = params.direction === 'accelerando' ? frac : 1 - frac;
      const hr = minR * (0.45 + 0.52 * hFrac);
      const hAlpha =
        Math.sin(Math.PI * hFrac) * params.shepardRiserMix * 0.42 * hairlineBoost;
      ctx.beginPath();
      ctx.arc(cx, cy, hr, 0, Math.PI * 2);
      ctx.strokeStyle = ink(hAlpha);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // 3. Radial Subdivision Ticks (inner ticks fade as Dropped Subdivisions increases)
  const subVisibility = Math.max(0.06, 1 - params.droppedSubdivisions * 0.85);
  for (let i = 0; i < steps; i++) {
    const ang = -Math.PI * 0.5 + (i / steps) * Math.PI * 2;
    const isAnchor = steps === 12 ? i % 6 === 0 : i % 4 === 0;
    const isSecondary = i % 2 === 0;

    const innerTick = isAnchor ? minR : isSecondary ? maxR - 14 : maxR - 8;
    const outerTick = maxR + (isAnchor ? 6 : 2);

    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * innerTick, cy + Math.sin(ang) * innerTick);
    ctx.lineTo(cx + Math.cos(ang) * outerTick, cy + Math.sin(ang) * outerTick);

    const alpha =
      (isAnchor
        ? 0.34
        : isSecondary
          ? 0.12 + 0.2 * subVisibility
          : 0.04 + 0.18 * subVisibility) * hairlineBoost;
    ctx.strokeStyle = ink(alpha);
    ctx.lineWidth = isAnchor ? 1.25 : 0.9;
    ctx.stroke();
  }

  // 4. Static Octave Reference Hairlines
  for (let k = 0; k <= L; k++) {
    const r = minR + (k / L) * (maxR - minR);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = ink(
      (k === 0 || k === L ? 0.08 : 0.05) * hairlineBoost
    );
    ctx.setLineDash(k === 0 || k === L ? [2, 5] : []);
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 5. Inscribed 3:2 Hemiola Geometric Polygon
  if (params.hemiolaMix > 0.01) {
    const hemiSteps: number[] = [];
    for (let i = 0; i < steps; i++) {
      if (pattern.tracks.hemiola[i]?.active) hemiSteps.push(i);
    }
    if (hemiSteps.length >= 2) {
      const polyR = minR + 0.5 * (maxR - minR);
      ctx.beginPath();
      hemiSteps.forEach((stepIdx, idx) => {
        const ang = -Math.PI * 0.5 + (stepIdx / steps) * Math.PI * 2;
        const px = cx + Math.cos(ang) * polyR;
        const py = cy + Math.sin(ang) * polyR;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.strokeStyle = ink(0.1 + 0.65 * params.hemiolaMix);
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
  }

  // 6. Expanding / Contracting Risset Tempo-Octave Voices + Synchronized Playheads
  for (const voice of snapshot.voices) {
    const isSoloed = params.soloVoiceIndex === voice.voiceIndex;
    if (params.soloVoiceIndex !== null && !isSoloed) continue;

    const normU = voice.octavePosition / L;
    const r = minR + normU * (maxR - minR);
    const alpha = Math.max(0.03, voice.effectiveGain);

    // Voice carrier ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = ink(0.08 * hairlineBoost + 0.62 * alpha);
    ctx.lineWidth = 0.9 + 1.9 * alpha;
    ctx.stroke();

    // Sweeping playhead arc & crisp monochrome bead
    const playAngle = -Math.PI * 0.5 + voice.barFraction * Math.PI * 2;
    const trail = 0.26;
    ctx.beginPath();
    ctx.arc(cx, cy, r, playAngle - trail, playAngle);
    ctx.strokeStyle = ink(0.95 * alpha);
    ctx.lineWidth = 2.0 + 2.2 * alpha;
    ctx.stroke();

    const px = cx + Math.cos(playAngle) * r;
    const py = cy + Math.sin(playAngle) * r;
    ctx.beginPath();
    ctx.arc(px, py, 2.5 + 3.0 * alpha, 0, Math.PI * 2);
    ctx.fillStyle = ink(0.22 + alpha);
    ctx.fill();
  }

  // 7. Monochrome Percussion Trigger Ripples
  for (const flash of flashes) {
    const age = currentElapsed - flash.elapsedTime;
    if (age < 0 || age > 0.28) continue;
    const decay = 1 - age / 0.28;
    const r = minR + (flash.octavePosition / L) * (maxR - minR);
    const ang = -Math.PI * 0.5 + (flash.stepIndex / steps) * Math.PI * 2;
    const fx = cx + Math.cos(ang) * r;
    const fy = cy + Math.sin(ang) * r;

    const rippleR = (3.5 + (1 - decay) * 13) * (0.5 + 0.55 * flash.gain);
    ctx.beginPath();
    ctx.arc(fx, fy, rippleR, 0, Math.PI * 2);
    ctx.strokeStyle = ink(decay * 0.85 * flash.gain);
    ctx.lineWidth = flash.trackId === 'low' ? 1.8 : 1.1;
    ctx.stroke();
  }

  // 8. Center Inner Sanctuary Circle (frames Play/BPM cleanly without line overlap)
  ctx.beginPath();
  ctx.arc(cx, cy, minR * 0.72, 0, Math.PI * 2);
  ctx.fillStyle = bgHex;
  ctx.fill();
  ctx.strokeStyle = ink(0.28 * hairlineBoost);
  ctx.lineWidth = 1;
  ctx.stroke();
}
