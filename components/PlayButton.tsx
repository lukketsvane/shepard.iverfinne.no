'use client';

import { Play, Square } from 'lucide-react';

interface Props {
  playing: boolean;
  /** Sound is being set up after the tap. */
  starting: boolean;
  onClick: () => void;
  /** A toolbar-sized button instead of the big one. */
  compact?: boolean;
}

export default function PlayButton({ playing, starting, onClick, compact }: Props) {
  return (
    <button
      type="button"
      className={`btn btn-primary ${compact ? 'min-w-[6.5rem]' : 'min-h-[56px] min-w-[8rem] text-[17px]'}`}
      aria-keyshortcuts="Space ArrowUp ArrowDown"
      data-transport=""
      disabled={starting}
      onClick={onClick}
    >
      {playing ? <Square size={18} fill="currentColor" aria-hidden="true" /> : <Play size={20} fill="currentColor" aria-hidden="true" />}
      {starting ? 'Starting…' : playing ? 'Stop' : 'Play'}
    </button>
  );
}
