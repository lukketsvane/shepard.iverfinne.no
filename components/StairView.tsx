'use client';

import { useEffect, useRef } from 'react';
import { layerWindow } from '@/lib/staircase/core';
import { IStaircaseEngine, Snapshot, StairParams } from '@/lib/staircase/types';

interface Props {
  engine: IStaircaseEngine;
  playing: boolean;
  params: StairParams;
}

interface Theme {
  ink: string;
  muted: string;
  line: string;
  accent: string;
  page: string;
  font: string;
}

/**
 * The mechanism, drawn. A vertical log-tempo axis; the fixed bell-shaped window over it; one
 * bar per copy of the music at its current tempo, as long and as dark as the window lets it
 * be, sliding up (or down) as the music accelerates; flashes where a copy plays a note. With the
 * drone on, a pitch axis on the right; with the tape on, the tempo axis goes on up into the
 * range where repetition is heard as pitch.
 */

// Everything on the tempo axis is log2 of beats per minute.
const TEMPO_LO = Math.log2(20);
const TEMPO_HI = Math.log2(1100);
const TAPE_HI = Math.log2(60 * 1600);
/** Beats this fast (20 per second) are heard as a tone, not as rhythm. */
const TONE_LINE = Math.log2(60 * 20);
const BPM_TICKS = [30, 60, 120, 240, 480, 960];
const TONE_TICKS = [50, 100, 200, 400, 800, 1600];
const PITCH_LO = Math.log2(20);
const PITCH_HI = Math.log2(9000);
const PITCH_TICKS = [55, 110, 220, 440, 880, 1760, 3520];
const FLASH_SECONDS = 0.4;
const FONT_SIZE = 13;

const LEFT = 58;
const TOP = 22;
const BOTTOM_PAD = 12;
const BAR_THICKNESS = 5;
const TICK_LENGTH = 30;
/** The notes beside the bell need this many pixels per octave to stay clear of the bars. */
const MIN_NOTE_OCTAVE = 22;

/** A rectangle on the canvas, in pixels. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function text(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  color: string,
  align: CanvasTextAlign = 'left'
): void {
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
}

/** Text running up the page, centred on `y`, kept only if it fits in `room`. */
function verticalText(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  room: number,
  color: string
): void {
  if (ctx.measureText(value).width > room) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-Math.PI / 2);
  text(ctx, value, 0, 0, color, 'center');
  ctx.restore();
}

const LINE_HEIGHT = 17;

/** A caption set out on the canvas: its lines, where they go, and the box they fill. */
interface Caption {
  lines: string[];
  x: number;
  top: number;
  align: CanvasTextAlign;
  color: string;
  box: Box;
}

/** Breaks `value` into lines no wider than `width`; its top, middle or bottom line sits at `y`. */
function caption(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  width: number,
  color: string,
  align: CanvasTextAlign = 'left',
  anchor: 'top' | 'middle' | 'bottom' = 'top'
): Caption {
  const lines: string[] = [];
  let line = '';
  for (const word of value.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  lines.push(line);
  const extent = (lines.length - 1) * LINE_HEIGHT;
  const top = anchor === 'top' ? y : anchor === 'middle' ? y - extent / 2 : y - extent;
  const widest = Math.max(...lines.map((entry) => ctx.measureText(entry).width));
  const left = align === 'right' ? x - widest : align === 'center' ? x - widest / 2 : x;
  return { lines, x, top, align, color, box: { x: left, y: top - LINE_HEIGHT / 2, w: widest, h: extent + LINE_HEIGHT } };
}

function drawCaption(ctx: CanvasRenderingContext2D, { lines, x, top, align, color }: Caption): void {
  lines.forEach((entry, i) => text(ctx, entry, x, top + i * LINE_HEIGHT, color, align));
}

/** A horizontal line from x0 to x1 that leaves a gap where a caption sits on it. */
function gridline(ctx: CanvasRenderingContext2D, y: number, x0: number, x1: number, captions: Box[]): void {
  const gap = 4;
  let from = x0;
  ctx.beginPath();
  for (const box of captions.filter((b) => y >= b.y && y <= b.y + b.h).sort((a, b) => a.x - b.x)) {
    if (box.x - gap > from) {
      ctx.moveTo(from, y);
      ctx.lineTo(box.x - gap, y);
    }
    from = Math.max(from, box.x + box.w + gap);
  }
  if (from < x1) {
    ctx.moveTo(from, y);
    ctx.lineTo(x1, y);
  }
  ctx.stroke();
}

function paint(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  theme: Theme,
  snap: Snapshot,
  params: StairParams,
  flashes: boolean
): void {
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.font = `500 ${FONT_SIZE}px ${theme.font}`;
  ctx.textBaseline = 'middle';

  const { tape, pad } = { tape: params.levels.tape > 0, pad: params.levels.pad > 0 };
  const right = w - (pad ? 98 : 14);
  const bottom = h - BOTTOM_PAD;
  const hi = tape ? TAPE_HI : TEMPO_HI;
  const octaveHeight = (bottom - TOP) / (hi - TEMPO_LO);
  const yOf = (log2Bpm: number) => bottom - (log2Bpm - TEMPO_LO) * octaveHeight;
  // The bell leaves a gutter on the right, where the focus marker and notes can sit clear of the bars.
  const gutter = Math.max(76, Math.min(140, (right - LEFT) * 0.28));
  const reach = right - LEFT - 8 - gutter;
  const focusLog = Math.log2(params.focusBpm);
  const focusY = yOf(focusLog);
  const slope = snap.playing ? snap.tempoSlope : params.tempoSlope;
  const toneY = yOf(TONE_LINE);

  // One bar per copy of the music.
  const bars = snap.layers
    .map((layer) => ({ layer, y: yOf(Math.log2(layer.beatHz * 60)), length: layer.window * reach }))
    .filter(({ y, length }) => y >= TOP && y <= bottom && length >= 1);
  const barBoxes: Box[] = bars.map(({ layer, y, length }) => {
    const thickness = (snap.soloLayerId === layer.id ? BAR_THICKNESS + 2 : BAR_THICKNESS) + 4;
    return { x: LEFT + 2, y: y - thickness / 2, w: length, h: thickness };
  });

  // The captions, in order of importance. One that would land on a bar or on another caption, or
  // outside the plot, is left out.
  const captions: Caption[] = [];
  const inPlot = (box: Box) => box.y >= TOP - 2 && box.y + box.h <= bottom + 2;
  const place = (candidate: Caption, always = false) => {
    const clear = inPlot(candidate.box) && ![...barBoxes, ...captions.map((c) => c.box)].some((box) => overlaps(box, candidate.box));
    if (always || clear) captions.push(candidate);
  };
  const markerX = LEFT + 2 + reach + 12;
  place(caption(ctx, `you hear about ${Math.round(params.focusBpm)} BPM`, markerX, focusY, right - markerX, theme.accent, 'left', 'middle'), true);
  for (const { layer, y, length } of bars) {
    if (snap.soloLayerId === layer.id) place(caption(ctx, 'playing alone', LEFT + 2 + length + 8, y, right - LEFT - length - 10, theme.accent, 'left', 'middle'), true);
  }
  if (tape) {
    place(
      caption(ctx, '20 per second: faster than this, beats become a tone', right - 6, toneY - 12, Math.min(190, right - LEFT - 20), theme.muted, 'right', 'bottom'),
      true
    );
  }
  // Which end fades out and which in depends on the direction.
  if (Math.abs(slope) >= 0.05 && octaveHeight >= MIN_NOTE_OCTAVE) {
    const edge = 1.9;
    const room = right - LEFT - layerWindow(edge) * reach - 18;
    if (room > 70) {
      const x = LEFT + layerWindow(edge) * reach + 10;
      const rising = slope > 0;
      place(caption(ctx, rising ? 'fastest copy fades out' : 'a new fast copy fades in', x, yOf(focusLog + edge * params.spread), room, theme.muted));
      place(caption(ctx, rising ? 'a new slow copy fades in' : 'slowest copy fades out', x, yOf(focusLog - edge * params.spread), room, theme.muted));
    }
  }
  // How to read it, where the plot has room (the tone range takes the top when the tape is on).
  if (!tape) {
    place(caption(ctx, 'Each bar is a copy of the music, at its own tempo.', LEFT + 10, TOP + 10, right - LEFT - 20, theme.muted));
  }
  const taken = captions.map((c) => c.box);

  // The range where beats blur into a tone, tinted and labelled.
  if (tape) {
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = theme.ink;
    ctx.fillRect(LEFT, TOP, right - LEFT, toneY - TOP);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = theme.muted;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(LEFT, toneY);
    ctx.lineTo(right, toneY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Gridlines and tick labels on the tempo axis.
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 1;
  for (const bpm of BPM_TICKS) {
    const y = yOf(Math.log2(bpm));
    gridline(ctx, y, LEFT, right, taken);
    text(ctx, String(bpm), LEFT - 8, y, theme.muted, 'right');
  }
  if (tape) {
    for (const hz of TONE_TICKS) {
      const y = yOf(Math.log2(hz * 60));
      if (y < TOP) continue;
      gridline(ctx, y, LEFT, right, taken);
      text(ctx, String(hz), LEFT - 8, y, theme.muted, 'right');
    }
  }
  ctx.strokeStyle = theme.muted;
  ctx.beginPath();
  ctx.moveTo(LEFT, TOP);
  ctx.lineTo(LEFT, bottom);
  ctx.stroke();

  const tempoMid = (bottom + (tape ? toneY : TOP)) / 2;
  const tempoRoom = bottom - (tape ? toneY : TOP);
  verticalText(ctx, 'beats per minute', 12, tempoMid, tempoRoom, theme.muted);
  if (tape) verticalText(ctx, 'tone pitch, Hz', 12, (TOP + toneY) / 2, toneY - TOP, theme.muted);

  // The window: a bell over absolute tempo that never moves.
  ctx.beginPath();
  ctx.moveTo(LEFT, bottom);
  for (let y = bottom; y >= TOP; y -= 2) {
    const log2Bpm = TEMPO_LO + (bottom - y) / octaveHeight;
    ctx.lineTo(LEFT + layerWindow((log2Bpm - focusLog) / params.spread) * reach, y);
  }
  ctx.lineTo(LEFT, TOP);
  ctx.closePath();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = theme.accent;
  ctx.fill();
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // The tempo you perceive: a dotted line across the bell, named in the gutter.
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(LEFT, focusY);
  ctx.lineTo(markerX - 4, focusY);
  ctx.stroke();
  ctx.setLineDash([]);

  const byId = new Map(snap.layers.map((layer) => [layer.id, layer]));
  for (const { layer, y, length } of bars) {
    const alone = snap.soloLayerId === layer.id;
    const dimmed = snap.soloLayerId !== null && !alone;
    const thickness = alone ? BAR_THICKNESS + 2 : BAR_THICKNESS;
    ctx.globalAlpha = (dimmed ? 0.2 : 1) * (0.35 + 0.65 * layer.window);
    ctx.fillStyle = alone ? theme.accent : theme.ink;
    ctx.fillRect(LEFT + 2, y - thickness / 2, length, thickness);
  }
  ctx.globalAlpha = 1;

  // A flash where a copy plays a note: the bar lights, and a dot sits at its end.
  if (flashes) {
    for (const event of snap.recent) {
      const layer = byId.get(event.layerId);
      const strength = 1 - (snap.time - event.time) / FLASH_SECONDS;
      if (!layer || strength <= 0) continue;
      const y = yOf(Math.log2(layer.beatHz * 60));
      const length = layer.window * reach;
      if (y < TOP || y > bottom || length < 1) continue;
      ctx.globalAlpha = 0.85 * strength;
      ctx.fillStyle = theme.accent;
      ctx.fillRect(LEFT + 2, y - BAR_THICKNESS / 2 - 1, length, BAR_THICKNESS + 2);
      ctx.beginPath();
      ctx.arc(LEFT + 2 + length, y, 2.5 + 5 * Math.min(1, event.gain) * strength, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  for (const entry of captions) drawCaption(ctx, entry);

  // Tape read heads: one tick per head on the axis, so the stack carries on up into the tone range.
  if (tape) {
    ctx.fillStyle = theme.ink;
    for (const head of snap.tapeHeads) {
      const y = yOf(Math.log2(head.hz * 60));
      if (y < TOP || y > bottom) continue;
      ctx.globalAlpha = 0.25 + 0.6 * head.gain;
      ctx.fillRect(LEFT + 2, y - 1, 14, 2);
    }
    ctx.globalAlpha = 1;
  }

  // The drone: its partials one octave apart on a pitch axis of their own, longer where louder.
  if (pad) {
    const axisX = right + 46;
    const pitchY = (hz: number) => bottom - ((Math.log2(hz) - PITCH_LO) / (PITCH_HI - PITCH_LO)) * (bottom - TOP);
    ctx.strokeStyle = theme.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(axisX, TOP);
    ctx.lineTo(axisX, bottom);
    ctx.stroke();
    for (const hz of PITCH_TICKS) text(ctx, String(hz), axisX + 5, pitchY(hz), theme.muted);
    verticalText(ctx, 'drone pitch, Hz', w - 7, (TOP + bottom) / 2, bottom - TOP, theme.muted);
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = 2;
    for (const partial of snap.partials) {
      if (partial.hz < 20 || partial.hz > 9000) continue;
      const y = pitchY(partial.hz);
      ctx.globalAlpha = 0.35 + 0.65 * partial.gain;
      ctx.beginPath();
      ctx.moveTo(axisX - 2 - partial.gain * TICK_LENGTH, y);
      ctx.lineTo(axisX, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function readTheme(canvas: HTMLCanvasElement): Theme {
  const style = getComputedStyle(canvas);
  const get = (name: string) => style.getPropertyValue(name).trim();
  return {
    ink: get('--ink'),
    muted: get('--muted'),
    line: get('--line'),
    accent: get('--accent'),
    page: get('--page'),
    font: style.fontFamily,
  };
}

export default function StairView({ engine, playing, params }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // One effect owns drawing: it fits the canvas, paints once, and keeps painting while playing.
  // It re-runs when the parameters change, which is what repaints a stopped view.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let theme = readTheme(canvas);
    let frame = 0;

    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      paint(ctx, width, height, theme, engine.getSnapshot(), params, !motion.matches);
    };
    const redraw = () => {
      theme = readTheme(canvas);
      draw();
    };

    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    scheme.addEventListener('change', redraw);
    // Stop iOS from turning a two-finger gesture on the instrument into a page zoom.
    const stopGesture = (event: Event) => event.preventDefault();
    canvas.addEventListener('gesturestart', stopGesture);

    draw();
    const loop = () => {
      draw();
      frame = requestAnimationFrame(loop);
    };
    if (playing) frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scheme.removeEventListener('change', redraw);
      canvas.removeEventListener('gesturestart', stopGesture);
    };
  }, [engine, playing, params]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="Diagram of the music's layers. Each bar is one copy of the groove at its own tempo on a vertical axis of beats per minute. The bell shape is the fixed window that fades the fastest copy out and a new slow one in."
      className="block h-full w-full touch-none"
    />
  );
}
