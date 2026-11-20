'use client';

import { DragEvent, RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown, Download, Upload } from 'lucide-react';
import FilesPanel from '@/components/FilesPanel';
import IllusionPanel from '@/components/IllusionPanel';
import MixPanel from '@/components/MixPanel';
import PlayButton from '@/components/PlayButton';
import PresetList from '@/components/PresetList';
import RecordButton from '@/components/RecordButton';
import Sheet from '@/components/Sheet';
import { SlopeSlider, nudgeSlope } from '@/components/Controls';
import StairView from '@/components/StairView';
import StepEditor from '@/components/StepEditor';
import TheoryPanel from '@/components/TheoryPanel';
import TiltControl from '@/components/TiltControl';
import WordsView from '@/components/WordsView';
import { useTilt } from '@/components/useTilt';
import { exportLoopMidi, exportLoopWav, importFile } from '@/lib/files';
import { PRESETS } from '@/lib/presets/index';
import { useRecording } from '@/lib/record';
import { StaircaseEngine } from '@/lib/sound/engine';
import { describeSlope } from '@/lib/staircase/control';
import { ParamsPatch, Preset, StairParams, Track } from '@/lib/staircase/types';

type SheetId = 'presets' | 'theory' | 'text' | 'rhythm';
interface Notice {
  kind: 'info' | 'error';
  text: string;
}

/**
 * A phone turned sideways: the whole screen goes to the step editor. A short desktop window
 * has a mouse (and no way to rotate), so it keeps the full page.
 */
const LANDSCAPE_QUERY = '(orientation: landscape) and (max-height: 600px) and (pointer: coarse)';
const subscribeLandscape = (callback: () => void) => {
  const media = window.matchMedia(LANDSCAPE_QUERY);
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
};
const isLandscape = () => window.matchMedia(LANDSCAPE_QUERY).matches;

const PITCH_STEP_NAMES: Record<number, string> = { 0.5: 'quarter tones', 1: 'semitones', 2: 'whole tones' };
/** Slopes smaller than this (octaves per minute) are called steady in words. */
const STEADY = 0.05;
/** The tape level a loaded recording is raised to, so it is heard. */
const TAPE_LEVEL_FOR_AUDIO = 0.7;

/** What is happening to the tempo, in words. */
function tempoStatus(params: StairParams, playing: boolean): string {
  const slope = params.tempoSlope;
  if (Math.abs(slope) < STEADY) return `${playing ? 'Steady' : 'Will stay steady'}: the tempo holds still.`;
  const verb = slope > 0 ? (playing ? 'Accelerating' : 'Will accelerate') : playing ? 'Slowing down' : 'Will slow down';
  return `${verb}: tempo ${describeSlope(slope, 'doubles', 'halves')}.`;
}

/** What is happening to the pitch, in words; null when it holds still. */
function pitchStatus(params: StairParams): string | null {
  const slope = params.pitchLink ? params.tempoSlope : params.pitchSlope;
  if (Math.abs(slope) < STEADY) return null;
  const motion = describeSlope(slope, 'rises an octave', 'falls an octave');
  const steps = PITCH_STEP_NAMES[params.pitchStep];
  return `Pitch ${params.pitchLink ? 'follows the tempo and ' : ''}${motion}${steps ? `, in ${steps}` : ''}.`;
}

/**
 * Keeps `--dock-height` on the page equal to the height of the play row, which sticks to the top
 * and can grow (a take being recorded): scroll-padding-top uses it, so that a control scrolled
 * into view by the keyboard does not end up behind the row.
 */
function useDockHeight(dock: RefObject<HTMLElement | null>, shown: boolean): void {
  useLayoutEffect(() => {
    const element = dock.current;
    if (!element || !shown) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty('--dock-height', `${element.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--dock-height');
    };
  }, [dock, shown]);
}

/** The credit line, one line long until asked for more (the button appears only when the line is cut off). */
function Credit({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [cutOff, setCutOff] = useState(false);
  const line = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const measure = () => {
      if (line.current && !open) setCutOff(line.current.scrollWidth > line.current.clientWidth);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [text, open]);

  return (
    <div className="hint flex items-start gap-1">
      <p ref={line} className={`min-w-0 flex-1 ${open ? '' : 'truncate'}`}>
        {text}
      </p>
      {(cutOff || open) && (
        <button
          type="button"
          aria-expanded={open}
          className="-my-2.5 min-h-[44px] min-w-[44px] shrink-0 px-2 font-semibold text-accent"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}

export default function Studio() {
  const [engine] = useState(() => new StaircaseEngine(PRESETS[0]));
  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
  const [params, setParams] = useState<StairParams>(() => engine.getParams());
  const [playing, setPlaying] = useState(false);
  const [starting, setStarting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const landscape = useSyncExternalStore(subscribeLandscape, isLandscape, () => false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  /** The tracks the current preset came with, which Reset rhythm puts back. */
  const originalTracks = useRef(PRESETS[0].tracks);

  useDockHeight(dock, !landscape);
  useEffect(() => () => engine.dispose(), [engine]);

  useEffect(() => {
    if (notice?.kind !== 'info') return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const fail = useCallback((text: string) => setNotice({ kind: 'error', text }), []);

  const update = useCallback(
    (patch: ParamsPatch) => {
      engine.setParams(patch);
      setParams(engine.getParams());
    },
    [engine]
  );

  const tilt = useTilt(engine, params, update);

  /** Called straight from taps and keys, which is what lets iOS unlock sound. */
  const start = useCallback(async () => {
    if (engine.isPlaying()) return;
    setStarting(true);
    try {
      await engine.start();
      setPlaying(engine.isPlaying());
    } finally {
      setStarting(false);
    }
  }, [engine]);

  const toggle = useCallback(() => {
    if (engine.isPlaying()) {
      engine.stop();
      setPlaying(false);
    } else {
      start().catch(() => fail('Sound could not start in this browser.'));
    }
  }, [engine, start, fail]);

  const recorder = useRecording(engine, start, fail);

  const choose = useCallback(
    (next: Preset) => {
      engine.setPreset(next);
      originalTracks.current = next.tracks;
      setPreset(next);
      setParams(engine.getParams());
    },
    [engine]
  );

  /** Previous or next preset. A file you loaded sits before the first: forward goes to the first, back to the last. */
  const step = useCallback(
    (delta: number) => {
      const current = PRESETS.findIndex((p) => p.id === preset.id);
      const next = current < 0 ? (delta > 0 ? 0 : PRESETS.length - 1) : (current + delta + PRESETS.length) % PRESETS.length;
      choose(PRESETS[next]);
    },
    [preset.id, choose]
  );

  const editTracks = useCallback(
    (tracks: Track[]) => {
      engine.setTracks(tracks);
      setPreset((current) => ({ ...current, tracks }));
    },
    [engine]
  );

  const resetTracks = useCallback(() => editTracks(originalTracks.current), [editTracks]);

  const loadFile = useCallback(
    async (file: File) => {
      try {
        const result = await importFile(file, preset, engine.getParams(), engine);
        if (result.kind === 'error') {
          fail(result.message);
        } else if (result.kind === 'midi') {
          // Nothing the old preset said about itself is true of the file.
          choose({
            ...result.preset,
            blurb: 'Your MIDI file, played as an endless staircase.',
            words: undefined,
            text: undefined,
            credit: undefined,
          });
          setNotice({ kind: 'info', text: `Loaded ${result.preset.name}.` });
        } else {
          update({ levels: { tape: Math.max(engine.getParams().levels.tape, TAPE_LEVEL_FOR_AUDIO) } });
          setNotice({ kind: 'info', text: 'The audio is on the tape, and the tape is turned up so you can hear it.' });
        }
      } catch {
        fail('That file could not be read.');
      }
    },
    [engine, preset, choose, update, fail]
  );

  const exportWav = async () => {
    setExporting(true);
    try {
      await exportLoopWav(engine, preset.id);
    } catch (error) {
      fail(error instanceof Error ? error.message : 'The loop could not be rendered.');
    } finally {
      setExporting(false);
    }
  };

  const exportMidi = () => {
    try {
      if (!exportLoopMidi(preset, engine.getParams())) fail('There is no loop to save while the tempo is steady.');
    } catch (error) {
      fail(error instanceof Error ? error.message : 'The loop could not be saved.');
    }
  };

  const openFile = () => fileInput.current?.click();

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) void loadFile(file);
  };

  // Keyboard: space plays, left and right change the preset, T opens How it works, and up and down
  // change the speed while Play has the focus (anywhere else they scroll, as they always do).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 't' || event.key === 'T') {
        setSheet((open) => (open === null ? 'theory' : open === 'theory' ? null : open));
        return;
      }
      const target = event.target as HTMLElement | null;
      const field = target?.tagName === 'INPUT' || target?.tagName === 'SELECT';
      if (sheet !== null || field) return;
      if (event.key === ' ') {
        // On a button, space presses it.
        if (target?.tagName === 'BUTTON' || target?.tagName === 'SUMMARY') return;
        event.preventDefault();
        toggle();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (!target?.hasAttribute('data-transport')) return;
        event.preventDefault();
        update({ tempoSlope: nudgeSlope(engine.getParams().tempoSlope, event.key === 'ArrowUp' ? 1 : -1) });
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        step(event.key === 'ArrowRight' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sheet, engine, toggle, update, step]);

  const pitch = pitchStatus(params);
  const closeSheet = () => setSheet(null);
  const recordingShown = recorder.state.status !== 'idle';

  const presetButton = (
    <button
      type="button"
      className="btn btn-quiet -ml-3 min-w-0 justify-start gap-2 px-3 text-left"
      aria-haspopup="dialog"
      aria-label={`Preset: ${preset.name}. Choose another.`}
      onClick={() => setSheet('presets')}
    >
      <span className="min-w-0">
        <span className="hint block leading-none">Preset</span>
        <span className="flex items-center gap-1.5">
          <span className="line-clamp-2 text-[20px] font-bold leading-tight">{preset.name}</span>
          <ChevronDown size={20} className="shrink-0" aria-hidden="true" />
        </span>
      </span>
    </button>
  );

  return (
    <div onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <input
        ref={fileInput}
        type="file"
        className="hidden"
        accept=".mid,.midi,.wav,.mp3,.ogg,.flac,.m4a,audio/*"
        aria-label="Choose a MIDI or audio file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void loadFile(file);
          event.target.value = '';
        }}
      />

      {landscape ? (
        <main className="flex h-dvh flex-col pb-[max(0.25rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.25rem,env(safe-area-inset-top))]">
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 pb-2">
            <PlayButton compact playing={playing} starting={starting} onClick={toggle} />
            {presetButton}
            <div className="min-w-[10rem] flex-1">
              <SlopeSlider
                label="Speed"
                compact
                value={params.tempoSlope}
                up="doubles"
                down="halves"
                captions={['Slower', 'Steady', 'Faster']}
                onChange={(tempoSlope) => update({ tempoSlope })}
              />
            </div>
            {tilt.available && (
              <button
                type="button"
                className="btn"
                aria-pressed={tilt.steering}
                disabled={tilt.asking}
                onClick={tilt.steering ? tilt.stop : tilt.start}
              >
                Tilt
              </button>
            )}
            <button type="button" className="btn" aria-label="Load MIDI or audio" onClick={openFile}>
              <Upload size={18} aria-hidden="true" />
              Load
            </button>
            <button type="button" className="btn" onClick={exportMidi}>
              <Download size={18} aria-hidden="true" />
              Export MIDI
            </button>
            <RecordButton recorder={recorder} compact />
          </div>
          <div className="min-h-0 flex-1">
            <StepEditor preset={preset} engine={engine} playing={playing} onTracks={editTracks} onReset={resetTracks} fill />
          </div>
        </main>
      ) : (
        <main className="lg:flex lg:h-dvh lg:flex-row lg:overflow-hidden">
          <section aria-label="The staircase" className="flex flex-col lg:min-h-0 lg:min-w-0 lg:flex-1">
            <header className="pl-[max(1rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] pt-[max(0.5rem,env(safe-area-inset-top))]">
              <div className="flex items-center justify-between gap-2">
                <h1 className="text-[17px] font-bold leading-tight">Endless staircase</h1>
                <button type="button" className="btn btn-quiet shrink-0" onClick={() => setSheet('theory')}>
                  How it works
                </button>
              </div>
              <p className="hint -mt-1 max-w-[34rem] pr-2">
                A rhythm that seems to speed up for ever, the tempo twin of the Shepard tone. Press Play, then drag Speed.
              </p>
              <div className="mt-1">{presetButton}</div>
            </header>
            <div className="px-4">
              <p className="max-w-[44rem]">{preset.blurb}</p>
              {preset.credit && <Credit key={preset.id} text={preset.credit} />}
            </div>
            <div className="my-2 h-[clamp(190px,30dvh,420px)] px-1 lg:h-auto lg:min-h-0 lg:flex-1">
              <StairView engine={engine} playing={playing} params={params} />
            </div>
            <div className="px-4 pb-3" role="status" aria-live={tilt.steering ? 'off' : 'polite'}>
              <p className="font-semibold">{tempoStatus(params, playing)}</p>
              {pitch && <p className="hint">{pitch}</p>}
              {params.solo && <p className="hint">Hearing one layer alone.</p>}
              {tilt.steering && <p className="hint text-accent">Tilt is steering the speed.</p>}
            </div>
            {preset.words && (
              <div className="px-4 pb-2">
                <WordsView key={preset.id} engine={engine} words={preset.words} playing={playing} />
              </div>
            )}
            {preset.text && (
              <div className="px-4 pb-3">
                <button type="button" className="btn" onClick={() => setSheet('text')}>
                  Read the text
                </button>
              </div>
            )}
          </section>

          {/*
            On a phone the play row and the controls are children of the page itself, so that the row,
            sticky at the top and at the bottom, is on screen wherever the page is scrolled to. Beside the
            staircase on a large screen it is the top of the controls panel, which scrolls under it.
          */}
          <div className="contents lg:flex lg:min-h-0 lg:w-[27rem] lg:flex-none lg:flex-col lg:border-l lg:border-line">
            <div
              ref={dock}
              className="sticky bottom-0 top-0 z-10 border-y border-line bg-page px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 lg:static lg:border-t-0 lg:pb-3"
            >
              <div className="flex items-center gap-4">
                <PlayButton playing={playing} starting={starting} onClick={toggle} />
                <div className="min-w-0 flex-1">
                  <SlopeSlider
                    label="Speed"
                    value={params.tempoSlope}
                    up="doubles"
                    down="halves"
                    captions={['Slower', 'Steady', 'Faster']}
                    onChange={(tempoSlope) => update({ tempoSlope })}
                  />
                </div>
              </div>
              {recordingShown && (
                <div className="mt-2 flex items-center gap-2">
                  <RecordButton recorder={recorder} compact />
                </div>
              )}
            </div>
            <section
              aria-label="Controls"
              className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain"
            >
              <TiltControl tilt={tilt} pitchLinked={params.pitchLink} />
              <MixPanel params={params} update={update} />
              <IllusionPanel params={params} update={update} />
              <section aria-labelledby="rhythm-heading" className="border-b border-line px-4 py-4">
                <h2 id="rhythm-heading" className="heading mb-2">
                  Rhythm
                </h2>
                <button type="button" className="btn w-full" onClick={() => setSheet('rhythm')}>
                  Edit rhythm
                </button>
                <p className="hint mt-1.5">Change the drum pattern while it plays.</p>
              </section>
              <FilesPanel
                params={params}
                recorder={recorder}
                exporting={exporting}
                onLoad={openFile}
                onExportWav={exportWav}
                onExportMidi={exportMidi}
              />
              <footer className="px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4">
                <p className="hint">
                  Keys: Space plays or stops. With Play selected, up and down change the speed. Left and right change the preset. T opens
                  How it works.
                </p>
                <a href="https://iverfinne.no" className="hint inline-flex min-h-[44px] items-center underline underline-offset-4">
                  iverfinne.no
                </a>
              </footer>
            </section>
          </div>
        </main>
      )}

      <Sheet open={sheet === 'presets'} title="Choose a preset" onClose={closeSheet}>
        <PresetList
          currentId={preset.id}
          onChoose={(index) => {
            choose(PRESETS[index]);
            closeSheet();
          }}
        />
      </Sheet>
      <Sheet open={sheet === 'theory'} title="How it works" onClose={closeSheet}>
        <TheoryPanel />
      </Sheet>
      <Sheet open={sheet === 'text'} title={preset.name} onClose={closeSheet}>
        <div className="prose text-[17px]">
          {preset.text?.split(/\n\s*\n/).map((paragraph, i) => <p key={i}>{paragraph}</p>)}
        </div>
      </Sheet>
      <Sheet open={sheet === 'rhythm'} title="Edit rhythm" wide onClose={closeSheet}>
        <div className="mb-4 flex items-center gap-4">
          <PlayButton compact playing={playing} starting={starting} onClick={toggle} />
          <p className="hint">
            The line shows where the loudest copy of the groove is. On a phone, turn it sideways for a full-screen editor.
          </p>
        </div>
        <StepEditor preset={preset} engine={engine} playing={playing} onTracks={editTracks} onReset={resetTracks} />
      </Sheet>

      {notice && (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-md items-center gap-3 rounded-xl border border-control bg-surface py-1 pl-4 pr-1 shadow-lg"
        >
          <p className="min-w-0 flex-1">{notice.text}</p>
          <button type="button" className="btn btn-quiet shrink-0" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
