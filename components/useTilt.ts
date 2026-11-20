'use client';

import { RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createTilt, tiltSupported, Tilt, TiltStatus } from '@/lib/motion/tilt';
import { MAX_SLOPE } from '@/lib/staircase/control';
import { IStaircaseEngine, ParamsPatch, StairParams } from '@/lib/staircase/types';

/** Octaves per minute added or taken away by a full tilt. */
const FULL_TILT_SLOPE = 6;
/** Pushed onto the tempo by a shake, octaves per minute. */
const SHAKE_KICK = 8;
/** How far the dot of the tilt indicator travels from the middle, in pixels. */
const DOT_TRAVEL = 36;

export interface TiltSteering {
  /** Whether there is anything to steer with: a touch screen, or a device that has reported motion. */
  available: boolean;
  status: TiltStatus;
  /** Waiting for the sensors or for the answer to the permission question. */
  asking: boolean;
  steering: boolean;
  /** The dot of the indicator, moved directly so that no render is needed per reading. */
  dotRef: RefObject<HTMLSpanElement | null>;
  start(): void;
  stop(): void;
  recentre(): void;
}

const noSubscription = () => () => {};
const coarsePointer = () => window.matchMedia('(pointer: coarse)').matches;

/** A desktop browser has the motion API but no sensors; only a real reading (not an empty one) proves there are some. */
function useReportedMotion(): boolean {
  const [reported, setReported] = useState(false);
  useEffect(() => {
    const onMotion = (event: DeviceMotionEvent) => {
      const { x, y, z } = event.accelerationIncludingGravity ?? {};
      if (x != null || y != null || z != null) setReported(true);
    };
    window.addEventListener('devicemotion', onMotion);
    return () => window.removeEventListener('devicemotion', onMotion);
  }, []);
  return reported;
}

/**
 * Steering by tilting the phone. The pose you hold when you start is the middle: from there,
 * tipping the top edge away speeds the tempo up and tipping it towards you slows it, from
 * whatever speed it had. (Steering from zero instead would make the music stop the moment
 * you press the button.) Sideways bends the pitch when pitch is not tied to the tempo. A
 * shake gives the barber pole a spin in the direction it is already going.
 *
 * It lives in the page, not in a panel, so turning the phone and the layout changing under it
 * does not end the steering.
 */
export function useTilt(
  engine: IStaircaseEngine,
  params: StairParams,
  update: (patch: ParamsPatch) => void
): TiltSteering {
  const supported = useSyncExternalStore(noSubscription, tiltSupported, () => false);
  const coarse = useSyncExternalStore(noSubscription, coarsePointer, () => false);
  const reported = useReportedMotion();
  const [status, setStatus] = useState<TiltStatus>('idle');
  const [asking, setAsking] = useState(false);
  const dotRef = useRef<HTMLSpanElement>(null);

  // What the handlers need to read without being recreated.
  const latest = useRef({ params, update, engine });
  useEffect(() => {
    latest.current = { params, update, engine };
  });
  // The slope the tilt is measured from, the offset it last applied, and the slope it last wrote.
  // A slope that is not the one written was set by hand (slider, preset): measure from that instead.
  const tempo = useRef({ base: params.tempoSlope, offset: 0, written: params.tempoSlope });
  const pitch = useRef({ base: params.pitchSlope, offset: 0, written: params.pitchSlope });

  useEffect(() => {
    if (Math.abs(params.tempoSlope - tempo.current.written) > 1e-6) {
      tempo.current = { ...tempo.current, base: params.tempoSlope - tempo.current.offset, written: params.tempoSlope };
    }
    if (Math.abs(params.pitchSlope - pitch.current.written) > 1e-6) {
      pitch.current = { ...pitch.current, base: params.pitchSlope - pitch.current.offset, written: params.pitchSlope };
    }
  }, [params.tempoSlope, params.pitchSlope]);

  const tiltRef = useRef<Tilt | null>(null);
  useEffect(() => {
    const tilt = createTilt({
      onReading({ x, y }) {
        const { params: p, update: set } = latest.current;
        if (dotRef.current) {
          dotRef.current.style.transform = `translate(${x * DOT_TRAVEL}px, ${-y * DOT_TRAVEL}px)`;
        }
        const patch: ParamsPatch = {};
        const steer = (axis: typeof tempo, value: number, key: 'tempoSlope' | 'pitchSlope') => {
          axis.current.offset = value * FULL_TILT_SLOPE;
          const target = axis.current.base + axis.current.offset;
          const slope = Math.round(Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, target)) * 20) / 20;
          if (slope !== axis.current.written) {
            axis.current.written = slope;
            patch[key] = slope;
          }
        };
        steer(tempo, y, 'tempoSlope');
        if (!p.pitchLink) steer(pitch, x, 'pitchSlope');
        if (Object.keys(patch).length > 0) set(patch);
      },
      onShake() {
        const { params: p, engine: e } = latest.current;
        e.kick(p.tempoSlope < 0 ? -SHAKE_KICK : SHAKE_KICK);
      },
    });
    tiltRef.current = tilt;
    return () => {
      tilt.stop();
      tiltRef.current = null;
    };
  }, []);

  const measureFromHere = useCallback(() => {
    const { params: p } = latest.current;
    tempo.current = { base: p.tempoSlope, offset: 0, written: p.tempoSlope };
    pitch.current = { base: p.pitchSlope, offset: 0, written: p.pitchSlope };
  }, []);

  const start = useCallback(() => {
    const tilt = tiltRef.current;
    if (!tilt) return;
    setAsking(true);
    measureFromHere();
    // Called straight from the tap: iOS only asks for sensor access inside a gesture.
    void tilt.start().then((result) => {
      setStatus(result);
      setAsking(false);
    });
  }, [measureFromHere]);

  const stop = useCallback(() => {
    tiltRef.current?.stop();
    setStatus('idle');
  }, []);

  const recentre = useCallback(() => {
    tiltRef.current?.recentre();
    measureFromHere();
  }, [measureFromHere]);

  return { available: supported && (coarse || reported), status, asking, steering: status === 'active', dotRef, start, stop, recentre };
}
