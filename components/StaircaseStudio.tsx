'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { StaircaseEngine } from '@/lib/staircase/engine';
import { STAIRCASE_PRESETS } from '@/lib/staircase/presets';
import { midiToPreset } from '@/lib/staircase/smf';
import { encodeRecordingMp3 } from '@/lib/staircase/record-mp3';
import type { LayerRatio, MixLevels, Snapshot, StairParams, Partial_ } from '@/lib/staircase/types';

const timeLabel = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

function Slider({ label, value, min, max, step, unit = '', onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-2.5">
      <span className="flex justify-between items-baseline gap-3 text-[11px] uppercase tracking-[.16em] text-neutral-400">
        <span>{label}</span><span className="font-mono tabular-nums text-neutral-100 tracking-normal">{value.toFixed(step < 1 ? 1 : 0)}{unit}</span>
      </span>
      <input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full h-1.5 cursor-pointer accent-orange-400 touch-pan-x" />
    </label>
  );
}

export default function StaircaseStudio() {
  const engineRef = useRef<StaircaseEngine | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const recordingRef = useRef<MediaRecorder | null>(null);
  const recordStartRef = useRef(0);
  const [presetIndex, setPresetIndex] = useState(0);
  const [params, setParams] = useState<StairParams>(STAIRCASE_PRESETS[0].params);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [loaded, setLoaded] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const engine = new StaircaseEngine(STAIRCASE_PRESETS[0]);
    engineRef.current = engine;
    setSnapshot(engine.getSnapshot());
    const interval = window.setInterval(() => {
      setSnapshot(engine.getSnapshot());
      if (recordingRef.current?.state === 'recording') setSeconds((performance.now() - recordStartRef.current) / 1000);
    }, 70);
    return () => {
      window.clearInterval(interval);
      if (recordingRef.current?.state === 'recording') recordingRef.current.stop();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const update = useCallback((patch: Partial_<StairParams>) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setParams(patch);
    setParams(engine.getParams());
  }, []);

  const stopRecording = useCallback(() => {
    if (recordingRef.current?.state === 'recording') {
      setBusy(true);
      recordingRef.current.stop();
    }
    setRecording(false);
  }, []);

  const togglePlay = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      if (engine.isPlaying()) {
        stopRecording();
        engine.stop();
        setPlaying(false);
      } else {
        await engine.start();
        setPlaying(true);
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not start audio'); }
  }, [stopRecording]);

  const selectPreset = useCallback((index: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setPreset(STAIRCASE_PRESETS[index]);
    setPresetIndex(index);
    setParams(engine.getParams());
    setLoaded('');
    setNotice('');
  }, []);

  const startRecording = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || busy || recording) return;
    try {
      if (typeof MediaRecorder === 'undefined') throw new Error('Recording is not supported by this browser');
      const stream = engine.getRecordingStream();
      if (!engine.isPlaying()) {
        await engine.start();
        setPlaying(true);
      }
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((v) => MediaRecorder.isTypeSupported(v));
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { setRecording(false); setBusy(false); setNotice('Audio recording failed'); };
      recorder.onstop = async () => {
        recordingRef.current = null;
        setRecording(false);
        if (chunks.length === 0) { setNotice('Recording was empty'); return; }
        setBusy(true);
        setNotice('ENCODING MP3…');
        try {
          const bytes = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer();
          const audio = await engine.decodeRecording(bytes);
          const mp3 = await encodeRecordingMp3(audio);
          const url = URL.createObjectURL(mp3);
          const a = document.createElement('a');
          const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\..*$/, '');
          a.href = url;
          a.download = `shepard-recording-${stamp}.mp3`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 3000);
          setNotice(`MP3 SAVED · ${timeLabel(audio.duration)}`);
        } catch (error) {
          setNotice(error instanceof Error ? `MP3 export failed: ${error.message}` : 'MP3 export failed');
        } finally { setBusy(false); }
      };
      recorder.start(250);
      recordingRef.current = recorder;
      recordStartRef.current = performance.now();
      setSeconds(0);
      setNotice('');
      setRecording(true);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Cannot record'); }
  }, [busy, recording]);

  const toggleRecording = useCallback(() => {
    if (recording) stopRecording();
    else void startRecording();
  }, [recording, startRecording, stopRecording]);

  const handleFile = useCallback(async (file: File) => {
    const engine = engineRef.current;
    if (!engine) return;
    setNotice('ANALYSING AUDIO…');
    try {
      const data = await file.arrayBuffer();
      if (/\.midi?$/i.test(file.name)) {
        const preset = midiToPreset(new Uint8Array(data), STAIRCASE_PRESETS[presetIndex]);
        engine.setPreset(preset);
        setParams(engine.getParams());
        setLoaded(`${file.name} · ${preset.tracks.length} MIDI TRACKS`);
      } else {
        const cuts = await engine.loadSampleAudio(data);
        setLoaded(`${file.name} · ${cuts} AUTO-SLICED SAMPLES`);
      }
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Cannot read audio file');
    }
  }, [presetIndex]);

  const onFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void handleFile(file);
    event.target.value = '';
  }, [handleFile]);

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) void handleFile(file);
  }, [handleFile]);

  const levels = params.levels;
  const activeLayers = snapshot?.layers.filter((layer) => layer.window > 0.025) ?? [];

  return (
    <main onDragOver={(e) => e.preventDefault()} onDrop={onDrop} className="fixed inset-0 overflow-y-auto touch-pan-y bg-[#101010] text-[#f3f1ec] font-sans selection:bg-orange-500 selection:text-black">
      <div className="max-w-[1120px] mx-auto px-5 sm:px-10 py-6 sm:py-10">
        <header className="flex items-center justify-between border-b border-white/15 pb-5">
          <div className="flex items-baseline gap-3"><span className="font-mono text-xs tracking-[.3em]">SHEPARD</span><span className="text-xs text-neutral-500">/ RHYTHM INFINITY</span></div>
          <div className="text-[10px] font-mono tracking-widest text-neutral-500">AUDIO EXPERIMENT 001</div>
        </header>

        <div className="pt-12 sm:pt-20 pb-6">
          <div className="text-xs uppercase tracking-[.3em] text-orange-300">ENDLESS STAIRCASE</div>
          <h1 className="mt-4 text-5xl sm:text-7xl lg:text-8xl font-light tracking-[-.075em] leading-[.95]">Sound in motion<span className="text-orange-300">.</span></h1>
          <p className="mt-5 max-w-xl text-sm leading-6 text-neutral-400">A pulse that never stops accelerating. Layers enter and disappear, but the rhythm continues.</p>
        </div>

        <section aria-label="Live tempo staircase" className="relative h-[240px] sm:h-[300px] border-y border-white/15 overflow-hidden">
          <div className="absolute inset-0 grid grid-cols-12 opacity-15 pointer-events-none">{Array.from({ length: 12 }, (_, i) => <div key={i} className="border-l border-white/25" />)}</div>
          <div className="absolute left-3 top-4 font-mono text-[10px] tracking-widest text-neutral-500">LAYER FIELD / {params.ratio}:1</div>
          <div className="absolute right-3 top-4 font-mono text-[10px] text-neutral-500">{params.tempoSlope > 0 ? '↗ ACCELERANDO' : params.tempoSlope < 0 ? '↘ DECELERANDO' : '→ STATIONARY'}</div>
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 1000 300" preserveAspectRatio="none" aria-label="Live animated layers and amplitude envelope" role="img">
            {activeLayers.map((layer) => {
              const y = 150 - layer.xOct * 45;
              const radius = 5 + layer.window * 8;
              const phase = layer.phase * 1000;
              return <g key={layer.id} opacity={Math.max(0.15, layer.window)}>
                <line x1="0" x2="1000" y1={y} y2={y} stroke="#e5e0d5" strokeWidth={layer.window > 0.6 ? 1.5 : 0.7} strokeDasharray="3 12" />
                <circle cx={phase} cy={y} r={radius} fill={layer.window > 0.65 ? '#f9a96a' : '#e5e0d5'} />
                <circle cx={phase - 1000} cy={y} r={radius} fill={layer.window > 0.65 ? '#f9a96a' : '#e5e0d5'} />
              </g>;
            })}
            <path d="M500 30 C360 50 360 250 500 270 C640 250 640 50 500 30" stroke="#f9a96a" strokeWidth="0.6" fill="none" opacity="0.24" />
            <line x1="0" x2="1000" y1="150" y2="150" stroke="#f9a96a" strokeWidth="1" opacity="0.3" />
          </svg>
          <div className="absolute bottom-4 left-3 font-mono text-xs tabular-nums text-neutral-300">{Math.round(params.focusBpm)} BPM</div>
          <div className="absolute bottom-4 right-3 font-mono text-[10px] text-neutral-500">{activeLayers.length} ACTIVE LAYERS</div>
        </section>

        <section className="py-8 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 border-b border-white/15">
          <button type="button" onClick={() => void togglePlay()} className="rounded-full h-14 px-9 bg-[#f3f1ec] text-black text-xs tracking-[.14em] font-semibold hover:bg-white transition-colors">{playing ? '■ STOP' : '▶ PLAY'}</button>
          <button type="button" onClick={toggleRecording} disabled={busy} aria-pressed={recording} className={`rounded-full h-14 px-7 flex items-center justify-center gap-3 text-xs tracking-[.12em] border transition-colors ${recording ? 'border-red-500 bg-red-600/15 text-red-100' : 'border-white/25 hover:border-white/70'} disabled:opacity-40`}>
            <span className={`h-2.5 w-2.5 bg-red-500 ${recording ? 'rounded-sm animate-pulse' : 'rounded-full'}`} />
            {recording ? `STOP RECORDING · ${timeLabel(seconds)}` : busy ? 'ENCODING MP3…' : 'RECORD MP3'}
          </button>
          <input ref={inputRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.aiff,.flac,.mid,.midi" className="hidden" onChange={onFileChange} />
          <button type="button" onClick={() => inputRef.current?.click()} className="rounded-full h-14 px-7 text-xs tracking-[.12em] border border-white/25 hover:border-white/70 transition-colors">↥ UPLOAD AUDIO / MIDI</button>
          <span className="sm:ml-auto font-mono text-[10px] text-neutral-500">{loaded || 'DROP AUDIO ANYWHERE · AUTO SAMPLING'}</span>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-[1.2fr_.8fr] gap-10 sm:gap-16 pt-10 sm:pt-14 pb-16">
          <div>
            <div className="flex justify-between items-baseline mb-6"><h2 className="text-lg tracking-tight">Movement</h2><span className="text-[10px] font-mono text-neutral-500">01 / ENGINE</span></div>
            <div className="flex gap-2 mb-9 flex-wrap">{STAIRCASE_PRESETS.map((preset, i) => <button type="button" key={preset.id} onClick={() => selectPreset(i)} aria-pressed={presetIndex === i} className={`py-2.5 px-3.5 text-[11px] tracking-wider border rounded-md ${presetIndex === i ? 'border-orange-300 text-orange-200' : 'border-white/15 text-neutral-500 hover:text-white'}`}>{preset.name}</button>)}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-8">
              <Slider label="Focus tempo" value={params.focusBpm} min={40} max={220} step={1} unit=" BPM" onChange={(v) => update({ focusBpm: v })} />
              <Slider label="Tempo slope" value={params.tempoSlope} min={-8} max={8} step={0.25} unit=" OCT/MIN" onChange={(v) => update({ tempoSlope: v })} />
              <Slider label="Pitch slope" value={params.pitchSlope} min={-8} max={8} step={0.25} unit=" OCT/MIN" onChange={(v) => update({ pitchSlope: v, pitchLink: false })} />
              <Slider label="Layer spread" value={params.spread} min={0.45} max={2.3} step={0.05} onChange={(v) => update({ spread: v })} />
            </div>
            <div className="mt-8 flex items-center flex-wrap gap-4">
              <span className="text-[11px] text-neutral-500 tracking-widest">RATIO</span>
              {([2, 1.5, 3] as LayerRatio[]).map((r) => <button key={r} type="button" onClick={() => update({ ratio: r })} aria-pressed={params.ratio === r} className={`text-xs font-mono px-3 py-2 rounded border ${params.ratio === r ? 'border-orange-300 text-orange-200' : 'border-white/15 text-neutral-400'}`}>{r === 1.5 ? '3:2' : `${r}:1`}</button>)}
              <label className="flex gap-2 items-center ml-auto text-[11px] text-neutral-400 cursor-pointer"><input type="checkbox" checked={params.pitchLink} onChange={(e) => update({ pitchLink: e.target.checked })} className="accent-orange-400" />LINK PITCH</label>
            </div>
          </div>
          <div>
            <div className="flex justify-between items-baseline mb-6"><h2 className="text-lg tracking-tight">Levels</h2><span className="text-[10px] font-mono text-neutral-500">02 / MIXER</span></div>
            <div className="grid gap-7">
              {(['drums', 'melody', 'pad', 'tape'] as const).map((key: keyof Pick<MixLevels, 'drums' | 'melody' | 'pad' | 'tape'>) => <Slider key={key} label={key === 'tape' ? 'Full tape loop' : key} value={levels[key]} min={0} max={1} step={0.05} onChange={(v) => update({ levels: { [key]: v } })} />)}
              <Slider label="Master" value={params.master} min={0} max={1} step={0.05} onChange={(v) => update({ master: v })} />
            </div>
          </div>
        </section>
        <footer className="text-[10px] font-mono tracking-wider text-neutral-500 border-t border-white/15 py-5 flex justify-between gap-4"><span>INTERACTIVE PSYCHOACOUSTICS</span><span role="status" className="text-orange-200">{notice || 'READY'}</span></footer>
      </div>
    </main>
  );
}
