'use client';

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Play } from 'lucide-react';
import { DrumTrackId, RissetEngineParams, RissetPattern } from '@/lib/risset-math';
import { RISSET_PRESETS, clonePattern, cycleStepCell } from '@/lib/risset-presets';
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
import RissetLandscapeEditor from './RissetLandscapeEditor';
import {
  buildStandardMidiFile,
  parseStandardMidiFileToPattern,
} from '@/lib/icct-midi';

const PRESET_SHORT_CODES = ['ICCT', 'TROY', '4/4', 'CLICK', 'DECEL'];

function recordingToWav(audio: AudioBuffer): Blob {
  const channels = Math.min(2, audio.numberOfChannels);
  const pcm = Array.from({ length: channels }, (_, channel) => audio.getChannelData(channel));
  const output = new ArrayBuffer(44 + audio.length * channels * 2);
  const view = new DataView(output);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, output.byteLength - 8, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, audio.length * channels * 2, true);
  let offset = 44;
  for (let i = 0; i < audio.length; i++) {
    for (let channel = 0; channel < channels; channel++) {
      const value = Math.max(-1, Math.min(1, pcm[channel][i]));
      view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
      offset += 2;
    }
  }
  return new Blob([output], { type: 'audio/wav' });
}

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

const landscapeQuery = '(orientation: landscape) and (max-height: 600px)';

function subscribeLandscape(callback: () => void): () => void {
  const media = window.matchMedia(landscapeQuery);
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}

function getLandscapeSnapshot(): boolean {
  return window.matchMedia(landscapeQuery).matches;
}

function getServerLandscapeSnapshot(): boolean {
  return false;
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
  const landscape = useSyncExternalStore(subscribeLandscape, getLandscapeSnapshot, getServerLandscapeSnapshot);
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'processing' | 'ready'>('idle');
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const engineRef = useRef<RissetAudioEngine | null>(null);
  const paramsRef = useRef<RissetEngineParams>(params);
  const isPlayingRef = useRef<boolean>(isPlaying);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedWavRef = useRef<Blob | null>(null);
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

  const handleRecord = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (recordingState === 'ready') {
        const wav = recordedWavRef.current;
        if (!wav) return;
        const url = URL.createObjectURL(wav);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'shepard-recording.wav';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        recordedWavRef.current = null;
        setRecordingState('idle');
        return;
      }
      if (recordingState === 'recording') {
        setRecordingState('processing');
        mediaRecorderRef.current?.stop();
        return;
      }
      if (recordingState !== 'idle') return;
      const engine = engineRef.current;
      if (!engine || typeof MediaRecorder === 'undefined') {
        showDetail('REC UNAVAILABLE');
        return;
      }
      try {
        const stream = engine.getRecordingStream();
        if (!stream) throw new Error('No audio stream');
        const codec = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
        const recorder = codec ? new MediaRecorder(stream, { mimeType: codec }) : new MediaRecorder(stream);
        const chunks: Blob[] = [];
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onstop = async () => {
          mediaRecorderRef.current = null;
          const decodeContext = new AudioContext();
          try {
            const data = new Blob(chunks, { type: recorder.mimeType });
            const decoded = await decodeContext.decodeAudioData(await data.arrayBuffer());
            recordedWavRef.current = recordingToWav(decoded);
            setRecordingSeconds(Math.round(decoded.duration));
            setRecordingState('ready');
          } catch {
            setRecordingState('idle');
            showDetail('REC FAILED');
          } finally {
            void decodeContext.close();
          }
        };
        recorder.onerror = () => {
          mediaRecorderRef.current = null;
          setRecordingState('idle');
          showDetail('REC FAILED');
        };
        await engine.start();
        setIsPlaying(true);
        recorder.start();
        mediaRecorderRef.current = recorder;
        setRecordingState('recording');
      } catch {
        setRecordingState('idle');
        showDetail('REC FAILED');
      }
    },
    [recordingState, showDetail]
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

  const handleCycleStep = useCallback((track: DrumTrackId, index: number) => {
    setPattern((previous) => {
      const next = clonePattern(previous);
      next.tracks[track][index] = cycleStepCell(next.tracks[track][index]);
      return next;
    });
  }, []);

  const handleVelocity = useCallback((track: DrumTrackId, index: number, velocity: number) => {
    setPattern((previous) => {
      const next = clonePattern(previous);
      const note = next.tracks[track][index];
      next.tracks[track][index] = { ...note, active: true, velocity: clamp(velocity, 0.05, 1) };
      return next;
    });
  }, []);

  const handleShiftTrack = useCallback((track: DrumTrackId, offset: number) => {
    setPattern((previous) => {
      const next = clonePattern(previous);
      const notes = next.tracks[track];
      next.tracks[track] = notes.map((_, index) => ({
        ...notes[(index - offset + notes.length) % notes.length],
      }));
      return next;
    });
  }, []);

  const cornerControlClass =
    'pointer-events-auto min-w-[48px] min-h-[48px] px-2 flex items-center justify-center text-[11px] tracking-[0.16em] font-[family-name:var(--font-mono)] text-neutral-950/60 dark:text-white/55 hover:text-neutral-950 dark:hover:text-white active:opacity-100 transition-opacity whitespace-nowrap';

  return (
    <main
      data-playback={isPlaying ? 'playing' : 'paused'}
      data-direction={params.direction}
      data-preset={RISSET_PRESETS[presetIndex]?.id ?? 'icct-hedral'}
      data-theme={systemTheme}
      onPointerDown={landscape ? undefined : handlePointerDown}
      onPointerMove={landscape ? undefined : handlePointerMove}
      onPointerUp={landscape ? undefined : handlePointerEnd}
      onPointerCancel={landscape ? undefined : handlePointerEnd}
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

      {landscape ? (
        <RissetLandscapeEditor
          engineRef={engineRef}
          params={params}
          pattern={pattern}
          isPlaying={isPlaying}
          recordingState={recordingState}
          recordingSeconds={recordingSeconds}
          onTogglePlay={handleTogglePlay}
          onRecord={handleRecord}
          onExportMidi={handleExportMidi}
          onOpenFile={handleOpenFilePicker}
          onCyclePreset={handleCyclePreset}
          onCycleStep={handleCycleStep}
          onVelocity={handleVelocity}
          onShiftTrack={handleShiftTrack}
        />
      ) : (
        <RissetPhaseCanvas
          engineRef={engineRef}
          params={params}
          pattern={pattern}
          isPlaying={isPlaying}
        />
      )}

      {/* Top Safe-Area Corners Only — Nothing Top-Aligned Center */}
      <div className={`${landscape ? 'hidden' : 'fixed'} inset-x-0 top-0 pt-[max(0.75rem,env(safe-area-inset-top))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] flex items-center justify-between pointer-events-none`}>
        <button
          type="button"
          onClick={handleCyclePreset}
          aria-label={`Preset ${PRESET_SHORT_CODES[presetIndex]}`}
          className={cornerControlClass}
        >
          {PRESET_SHORT_CODES[presetIndex]}
        </button>

        <a
          href="/fingertip.html"
          onClick={(e) => e.stopPropagation()}
          aria-label="Open Fingertip sound laboratory"
          className={cornerControlClass}
        >
          FINGERTIP
        </a>
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
      <div className={`${landscape ? 'hidden' : 'fixed'} inset-x-0 bottom-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] flex items-center justify-between pointer-events-none`}>
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
            onClick={handleRecord}
            disabled={recordingState === 'processing'}
            aria-label={recordingState === 'recording' ? 'Stop recording' : recordingState === 'ready' ? 'Download WAV recording' : 'Start recording'}
            className={`${cornerControlClass} ${recordingState === 'recording' ? '!text-red-600 font-bold animate-pulse' : ''}`}
          >
            {recordingState === 'ready'
              ? `${String(Math.floor(recordingSeconds / 60)).padStart(2, '0')}:${String(recordingSeconds % 60).padStart(2, '0')}`
              : recordingState === 'processing' ? '...' : 'REC'}
          </button>
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
        className={`${landscape ? 'hidden' : 'fixed'} left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 rounded-full flex items-center justify-center text-neutral-950 dark:text-white focus-visible:outline-1 focus-visible:outline-neutral-950/60 dark:focus-visible:outline-white/60 active:scale-95 transition-transform`}
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
