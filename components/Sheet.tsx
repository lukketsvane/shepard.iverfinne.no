'use client';

import { ReactNode, useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  /** A wider panel on large screens, for content that needs the room. */
  wide?: boolean;
  children: ReactNode;
}

/**
 * A modal panel on the native dialog element, which brings the focus trap, the Escape key and
 * the inert page behind it. The content is mounted only while open, so what animates inside
 * stops when it closes.
 */
export default function Sheet({ open, title, onClose, wide, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`sheet ${wide ? 'sheet-wide' : ''}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog itself, not on anything inside it.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {open && (
        <>
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line py-1 pl-5 pr-2">
            <h2 id={titleId} className="heading">
              {title}
            </h2>
            <button type="button" className="btn btn-quiet" onClick={onClose}>
              <X size={18} aria-hidden="true" />
              Close
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4">
            {children}
          </div>
        </>
      )}
    </dialog>
  );
}
