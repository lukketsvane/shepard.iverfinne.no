'use client';

import { Download, Upload } from 'lucide-react';
import RecordButton from '@/components/RecordButton';
import { Recorder } from '@/lib/record';
import { StairParams } from '@/lib/staircase/types';

interface Props {
  params: StairParams;
  recorder: Recorder;
  /** A loop is being rendered. */
  exporting: boolean;
  onLoad: () => void;
  onExportWav: () => void;
  onExportMidi: () => void;
}

/** Below this the tempo is steady and nothing cycles (the engine's own limit). */
export const hasLoop = (params: StairParams) => Math.abs(params.tempoSlope) >= 1e-6;

export default function FilesPanel({ params, recorder, exporting, onLoad, onExportWav, onExportMidi }: Props) {
  const loop = hasLoop(params);
  return (
    <section aria-labelledby="files-heading" className="border-b border-line px-4 py-4">
      <h2 id="files-heading" className="heading mb-3">
        Files
      </h2>
      <div className="flex flex-col gap-4">
        <div>
          <button type="button" className="btn w-full" onClick={onLoad}>
            <Upload size={18} aria-hidden="true" />
            Load MIDI or audio
          </button>
          <p className="hint mt-1.5">A MIDI file replaces the melody and drums. Audio plays on the tape: a voice works best.</p>
        </div>
        <div>
          <div className="flex flex-col gap-2">
            <button type="button" className="btn w-full" disabled={!loop || exporting} onClick={onExportWav}>
              <Download size={18} aria-hidden="true" />
              {exporting ? 'Rendering the loop…' : 'Export loop as WAV'}
            </button>
            <button type="button" className="btn w-full" disabled={!loop} onClick={onExportMidi}>
              <Download size={18} aria-hidden="true" />
              Export loop as MIDI
            </button>
          </div>
          <p className="hint mt-1.5">
            {loop
              ? 'Saves one seamless cycle, so it repeats without a seam in any player.'
              : 'A loop needs a speed. While the tempo is steady, nothing cycles to save.'}
          </p>
        </div>
        <div>
          <RecordButton recorder={recorder} />
          <p className="hint mt-1.5">Records what you hear, including every change you make, as a WAV file.</p>
        </div>
      </div>
    </section>
  );
}
