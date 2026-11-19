'use client';

import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { RissetAudioEngine } from '@/lib/risset-audio';

const BRIDGE = 'http://127.0.0.1:8789';

function toWav(audio: AudioBuffer, seconds: number): Uint8Array {
  const channels = Math.min(2, audio.numberOfChannels);
  const frames = Math.min(audio.length, Math.floor(audio.sampleRate * seconds));
  const bytes = new Uint8Array(44 + frames * channels * 2);
  const view = new DataView(bytes.buffer);
  const write = (index: number, content: string) => {
    for (let i = 0; i < content.length; i++) view.setUint8(index + i, content.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
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
  view.setUint32(40, frames * channels * 2, true);
  const tracks = Array.from({ length: channels }, (_, ch) => audio.getChannelData(ch));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const sample = Math.max(-1, Math.min(1, tracks[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
      offset += 2;
    }
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

interface Props {
  engineRef: React.MutableRefObject<RissetAudioEngine | null>;
  onClose: () => void;
  onUseSample: (data: ArrayBuffer) => Promise<boolean>;
}

export default function NeuralAudioPanel({ engineRef, onClose, onUseSample }: Props) {
  const [tab, setTab] = useState<'neutone' | 'sa3'>('neutone');
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [inputId, setInputId] = useState('');
  const [connected, setConnected] = useState(false);
  const [monitoring, setMonitoring] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [available, setAvailable] = useState(false);
  const [mode, setMode] = useState<'generate' | 'variation' | 'inpaint'>('generate');
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(20);
  const [noise, setNoise] = useState(0.7);
  const [reference, setReference] = useState<File | null>(null);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState('');
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    void fetch(BRIDGE + '/health')
      .then((response) => response.json())
      .then((data) => setAvailable(Boolean(data.available)))
      .catch(() => setAvailable(false));
    return () => {
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      engineRef.current?.setExternalInput(null);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [engineRef]);

  const connectInput = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: inputId ? { exact: inputId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      engineRef.current?.setExternalInput(null);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      engineRef.current?.setExternalInput(stream);
      streamRef.current = stream;
      setMonitoring(false);
      setConnected(true);
      const devices = await navigator.mediaDevices.enumerateDevices();
      setInputs(devices.filter((device) => device.kind === 'audioinput'));
      setStatus('INPUT CONNECTED');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'INPUT UNAVAILABLE');
    }
  };

  const disconnectInput = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    engineRef.current?.setExternalInput(null);
    setConnected(false);
    setMonitoring(false);
    setCapturing(false);
  };

  const toggleCapture = () => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop();
      setCapturing(false);
      return;
    }
    const stream = streamRef.current;
    if (!stream || typeof MediaRecorder === 'undefined') {
      setStatus('NO INPUT');
      return;
    }
    const codecs = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
    const supported = codecs.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = supported ? new MediaRecorder(stream, { mimeType: supported }) : new MediaRecorder(stream);
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = async () => {
      setWorking(true);
      try {
        const audio = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer();
        if (!(await onUseSample(audio))) throw new Error('Audio could not be decoded');
        setStatus('CAPTURE LOADED INTO SAMPLER');
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'CAPTURE FAILED');
      } finally {
        recorderRef.current = null;
        setWorking(false);
      }
    };
    recorder.start();
    recorderRef.current = recorder;
    setCapturing(true);
    setStatus('CAPTURING INPUT');
  };

  const toggleMonitor = () => {
    engineRef.current?.setExternalMonitor(!monitoring);
    setMonitoring(!monitoring);
  };

  const renderSample = async () => {
    setWorking(true);
    setStatus('RENDERING ON LOCAL CPU');
    try {
      let audio: string | undefined;
      if (mode !== 'generate') {
        if (!reference) throw new Error('Choose a reference recording');
        const context = new AudioContext();
        try {
          const decoded = await context.decodeAudioData(await reference.arrayBuffer());
          audio = encodeBase64(toWav(decoded, duration));
        } finally {
          void context.close();
        }
      }
      const result = await fetch(BRIDGE + '/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, prompt, seconds: duration, noise, audio }),
      });
      if (!result.ok) {
        const data = await result.json();
        throw new Error(data.error ?? 'Generation failed');
      }
      if (!(await onUseSample(await result.arrayBuffer())))
        throw new Error('Output could not be decoded');
      setStatus('GENERATED SOUND LOADED INTO SAMPLER');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'GENERATION FAILED');
    } finally {
      setWorking(false);
    }
  };

  const control = 'min-h-10 border-b border-white/50 px-2 text-[11px] tracking-[0.12em] text-white bg-black focus-visible:outline focus-visible:outline-white';
  const action = 'min-h-10 px-3 text-[11px] tracking-[0.12em] text-white disabled:opacity-40 focus-visible:outline focus-visible:outline-white';

  return (
    <section className="absolute inset-0 z-20 flex min-h-0 flex-col bg-black p-4 text-white font-[family-name:var(--font-mono)]" aria-label="External neural audio integration">
      <div className="flex min-h-11 shrink-0 items-center gap-5 border-b border-white/40">
        <button className={action + (tab === 'neutone' ? ' underline underline-offset-8' : ' opacity-60')} onClick={() => setTab('neutone')}>RAVE INPUT</button>
        <button className={action + (tab === 'sa3' ? ' underline underline-offset-8' : ' opacity-60')} onClick={() => setTab('sa3')}>SA3 CPU</button>
        <div className="flex-1" />
        <button className={action} onClick={onClose} aria-label="Close audio effects"><X size={22} strokeWidth={1.5} /></button>
      </div>
      {tab === 'neutone' ? (
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-3 overflow-auto py-3">
          <p className="text-[11px] leading-relaxed text-white/65">NEUTONE FX RUNS IN YOUR DAW. ROUTE ITS AUDIO THROUGH A RECORDING INPUT TO CAPTURE IT HERE.</p>
          <div className="flex flex-wrap items-center gap-2">
            <select className={control + ' max-w-[240px]'} aria-label="Audio input from Neutone" value={inputId} onChange={(event) => setInputId(event.target.value)}>
              <option value="">DEFAULT INPUT</option>
              {inputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || 'INPUT DEVICE'}</option>)}
            </select>
            <button className={action} onClick={connected ? disconnectInput : connectInput}>{connected ? 'DISCONNECT' : 'CONNECT'}</button>
            <button className={action} onClick={toggleMonitor} disabled={!connected}>{monitoring ? 'MONITOR ON' : 'MONITOR OFF'}</button>
            <button className={action} onClick={toggleCapture} disabled={!connected || working}>{capturing ? 'STOP CAPTURE' : 'CAPTURE'}</button>
          </div>
          <p className="text-[10px] text-white/50">MONITOR ONLY WITH HEADPHONES OR A SAFE VIRTUAL AUDIO ROUTE.</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-3 overflow-auto py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={'text-[10px] ' + (available ? 'text-white' : 'text-white/50')}>{available ? 'LOCAL MODEL READY' : 'LOCAL MODEL NOT CONNECTED'}</span>
            <button className={action} onClick={() => {
              void fetch(BRIDGE + '/health').then((res) => res.json()).then((data) => setAvailable(Boolean(data.available))).catch(() => setAvailable(false));
            }}>CHECK</button>
            {(['generate', 'variation', 'inpaint'] as const).map((value) => (
              <button key={value} onClick={() => setMode(value)} className={action + (mode === value ? ' underline underline-offset-4' : ' opacity-50')}>{value.toUpperCase()}</button>
            ))}
          </div>
          <input className={control + ' w-full'} aria-label="Sound description" placeholder="DESCRIBE THE SOUND TO GENERATE" value={prompt} maxLength={300} onChange={(event) => setPrompt(event.target.value)} />
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[10px]">SECONDS {duration}<input type="range" min={1} max={30} value={duration} onChange={(event) => setDuration(Number(event.target.value))} /></label>
            {mode !== 'generate' && (
              <input className={control + ' max-w-[230px]'} type="file" accept="audio/*,.wav" aria-label="Reference audio" onChange={(event) => setReference(event.target.files?.[0] ?? null)} />
            )}
            {mode === 'variation' && (
              <label className="flex items-center gap-2 text-[10px]">NOISE {noise.toFixed(2)}<input type="range" min={0.1} max={1} step={0.05} value={noise} onChange={(event) => setNoise(Number(event.target.value))} /></label>
            )}
            <button className={action} disabled={!available || working || !prompt.trim()} onClick={() => void renderSample()}>{working ? 'RENDERING' : 'GENERATE & LOAD'}</button>
          </div>
        </div>
      )}
      <p className="min-h-6 shrink-0 text-[10px] text-white/70" role="status">{status}</p>
    </section>
  );
}
