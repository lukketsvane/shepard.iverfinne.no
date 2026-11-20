'use client';

import { TiltSteering } from '@/components/useTilt';
import { TiltStatus } from '@/lib/motion/tilt';

interface Props {
  tilt: TiltSteering;
  /** Whether the pitch follows the tempo, which leaves the sideways tilt with nothing to bend. */
  pitchLinked: boolean;
}

const STATUS_TEXT: Record<TiltStatus, string> = {
  idle: '',
  active: 'Tilting steers the music.',
  denied: 'Motion access was refused. Allow it in the browser settings, then try again.',
  unsupported: 'No motion sensors were found on this device.',
};

/** The tilt section of the controls: a button to start, and while it steers, where the phone is held and how to stop. */
export default function TiltControl({ tilt, pitchLinked }: Props) {
  const { status, asking, steering, dotRef } = tilt;
  if (!tilt.available) return null;

  return (
    <section aria-labelledby="tilt-heading" className="border-b border-line px-4 py-4">
      <h2 id="tilt-heading" className="heading mb-2">
        Tilt
      </h2>
      {!steering ? (
        <>
          <button type="button" className="btn w-full" disabled={asking} onClick={tilt.start}>
            {asking ? 'Waiting for the motion sensors…' : 'Steer by tilting'}
          </button>
          {STATUS_TEXT[status] && (
            <p role="alert" className="hint mt-2">
              {STATUS_TEXT[status]}
            </p>
          )}
          {status === 'idle' && (
            <p className="hint mt-2">Tip the top of the phone away to speed up, towards you to slow down. Shake to spin it.</p>
          )}
        </>
      ) : (
        <div className="flex items-center gap-4">
          <div
            className="relative h-[88px] w-[88px] shrink-0 rounded-xl border border-control bg-surface"
            role="img"
            aria-label="How far the phone is tilted: up is faster, down is slower, sideways bends the pitch"
          >
            <span className="absolute left-1/2 top-2 h-[calc(100%-1rem)] w-px bg-line" aria-hidden="true" />
            <span className="absolute left-2 top-1/2 h-px w-[calc(100%-1rem)] bg-line" aria-hidden="true" />
            <span
              ref={dotRef}
              className="absolute left-1/2 top-1/2 -ml-2.5 -mt-2.5 h-5 w-5 rounded-full bg-accent"
              aria-hidden="true"
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Tilting steers the music.</p>
            <p className="hint">
              Forward is faster, back is slower{pitchLinked ? '.' : ', sideways bends the pitch.'} Shake to spin.
            </p>
            <div className="mt-2 flex gap-2">
              <button type="button" className="btn" onClick={tilt.recentre}>
                Re-centre
              </button>
              <button type="button" className="btn" onClick={tilt.stop}>
                Stop tilting
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
