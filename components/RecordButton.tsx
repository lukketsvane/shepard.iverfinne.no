'use client';

import { Circle } from 'lucide-react';
import { Recorder, formatClock } from '@/lib/record';

interface Props {
  recorder: Recorder;
  /** Shorter labels, for the landscape toolbar. */
  compact?: boolean;
}

/** Record, stop, then save or discard the take. */
export default function RecordButton({ recorder, compact }: Props) {
  const { state } = recorder;

  if (state.status === 'ready') {
    return (
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary" onClick={recorder.save}>
          {compact ? 'Save' : 'Save recording'} ({formatClock(state.wav.seconds)})
        </button>
        <button type="button" className="btn" onClick={recorder.discard}>
          Discard
        </button>
      </div>
    );
  }

  const recording = state.status === 'recording';
  return (
    <button
      type="button"
      className={`btn ${recording ? 'btn-primary' : ''}`}
      aria-pressed={recording}
      disabled={state.status === 'processing'}
      onClick={recorder.toggle}
    >
      <Circle size={14} fill="currentColor" className={recording ? '' : 'text-accent'} aria-hidden="true" />
      {state.status === 'processing'
        ? 'Preparing file…'
        : recording
          ? `Stop ${formatClock(state.seconds)}`
          : 'Record'}
    </button>
  );
}
