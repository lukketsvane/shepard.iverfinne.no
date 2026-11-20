/**
 * Live recording of what the instrument plays: the master output goes through MediaRecorder
 * (the only way a browser lets us capture a stream), is decoded again, and saved as plain WAV.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadBytes } from './files';
import { encodeWav } from './sound/wav';
import { IStaircaseEngine } from './staircase/types';

/** In order of preference; Safari only offers mp4. */
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];

export interface RecordedWav {
  bytes: Uint8Array;
  seconds: number;
}

export interface ActiveRecording {
  /** Stop recording and resolve with the take as a WAV file. */
  stop(): Promise<RecordedWav>;
}

/** Starts recording `stream`. Throws with a readable message when the browser cannot. */
export function startRecording(stream: MediaStream): ActiveRecording {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('This browser cannot record audio.');
  }
  const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('The recording failed.'));
  });
  recorder.start();

  return {
    async stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      return toWav(new Blob(chunks, { type: recorder.mimeType }));
    },
  };
}

async function toWav(blob: Blob): Promise<RecordedWav> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: Math.min(2, audio.numberOfChannels) }, (_, channel) =>
      audio.getChannelData(channel)
    );
    return { bytes: encodeWav(channels, audio.sampleRate), seconds: audio.duration };
  } catch {
    throw new Error('The recording could not be turned into a WAV file.');
  } finally {
    void context.close();
  }
}

/** 83 seconds as "1:23". */
export function formatClock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export type RecordingState =
  | { status: 'idle' }
  | { status: 'recording'; seconds: number }
  | { status: 'processing' }
  | { status: 'ready'; wav: RecordedWav };

export interface Recorder {
  state: RecordingState;
  /** Start recording (starting the music first if it is silent), or stop and prepare the file. */
  toggle(): void;
  /** Save the finished take and get ready for the next. */
  save(): void;
  discard(): void;
}

/**
 * Recording state for the page. It lives above the screens that show it, so a take survives
 * the phone being turned and the layout changing. `start` begins playback and resolves once
 * there is audio to capture; `fail` receives a readable message.
 */
export function useRecording(
  engine: IStaircaseEngine,
  start: () => Promise<void>,
  fail: (message: string) => void
): Recorder {
  const [state, setState] = useState<RecordingState>({ status: 'idle' });
  const active = useRef<ActiveRecording | null>(null);
  const startedAt = useRef(0);

  const recording = state.status === 'recording';
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      setState({ status: 'recording', seconds: (performance.now() - startedAt.current) / 1000 });
    }, 250);
    return () => clearInterval(timer);
  }, [recording]);

  const begin = useCallback(async () => {
    try {
      await start();
      const stream = engine.recordingStream();
      if (!stream) throw new Error('There is no sound to record yet.');
      active.current = startRecording(stream);
      startedAt.current = performance.now();
      setState({ status: 'recording', seconds: 0 });
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Recording could not start.');
    }
  }, [engine, start, fail]);

  const finish = useCallback(async () => {
    const take = active.current;
    active.current = null;
    if (!take) return;
    setState({ status: 'processing' });
    try {
      setState({ status: 'ready', wav: await take.stop() });
    } catch (error) {
      setState({ status: 'idle' });
      fail(error instanceof Error ? error.message : 'The recording failed.');
    }
  }, [fail]);

  const toggle = useCallback(() => {
    if (state.status === 'idle') void begin();
    else if (state.status === 'recording') void finish();
  }, [state.status, begin, finish]);

  const save = useCallback(() => {
    if (state.status !== 'ready') return;
    downloadBytes(state.wav.bytes, 'staircase-recording.wav', 'audio/wav');
    setState({ status: 'idle' });
  }, [state]);

  const discard = useCallback(() => setState({ status: 'idle' }), []);

  return { state, toggle, save, discard };
}
