import { parseMidi } from './midi/smf';
import { tracksFromMidi } from './midi/clips';
import { loopMidi } from './midi/loop';
import { encodeWav } from './sound/wav';
import { IStaircaseEngine, Preset, StairParams, isDrumRole } from './staircase/types';

function download(bytes: Uint8Array, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Render one seamless cycle and save it. Throws with a readable message when there is no cycle to render. */
export async function exportLoopWav(engine: IStaircaseEngine, name: string): Promise<void> {
  const loop = await engine.renderLoop();
  download(encodeWav(loop.channels, loop.sampleRate), `${name}-loop-${Math.round(loop.seconds)}s.wav`, 'audio/wav');
}

/** Save one seamless cycle as MIDI. Returns false when the tempo is steady, so nothing cycles. */
export function exportLoopMidi(preset: Preset, params: StairParams): boolean {
  const bytes = loopMidi(preset, params);
  if (!bytes) return false;
  download(bytes, `${preset.id}-loop.mid`, 'audio/midi');
  return true;
}

export type ImportResult =
  | { kind: 'midi'; preset: Preset }
  | { kind: 'audio' }
  | { kind: 'error'; message: string };

/**
 * A MIDI file replaces the melody (and the drums, if it has a percussion channel).
 * Any other file is decoded as audio and played on the tape.
 */
export async function importFile(
  file: File,
  preset: Preset,
  params: StairParams,
  engine: IStaircaseEngine
): Promise<ImportResult> {
  const data = await file.arrayBuffer();
  if (/\.midi?$/i.test(file.name)) {
    const midi = parseMidi(new Uint8Array(data));
    if (!midi) return { kind: 'error', message: 'That MIDI file could not be read.' };
    const imported = tracksFromMidi(midi, preset.meter);
    const hasDrums = imported.some((track) => isDrumRole(track.role));
    const kept = preset.tracks.filter((track) => isDrumRole(track.role) && !hasDrums);
    return {
      kind: 'midi',
      preset: {
        ...preset,
        id: `${preset.id}-imported`,
        name: file.name.replace(/\.midi?$/i, ''),
        tracks: [...kept, ...imported],
        params: {
          ...params,
          focusBpm: midi.bpm ? Math.round(midi.bpm) : params.focusBpm,
          levels: { ...params.levels, melody: Math.max(params.levels.melody, 0.8) },
        },
      },
    };
  }
  if (await engine.loadTapeAudio(data)) return { kind: 'audio' };
  return { kind: 'error', message: 'That file is neither MIDI nor audio this browser can decode.' };
}
