/**
 * Tape layers: one loop of audio replayed by many read heads, one layer ratio apart in speed.
 *
 * Slow heads replay the loop slowly enough to be heard as beats. The fast ones replay it
 * hundreds of times per second, where the repetition is heard as pitch and the rhythm turns
 * into the timbre of the tone (Stockhausen, "... wie die Zeit vergeht ..."; pulsar synthesis).
 * All heads speed up together under one window, so the result is a Risset rhythm and an
 * octave-stacked Shepard tone at once.
 *
 * Heads are stateless. Every sample, each head's position is recomputed from the staircase
 * state (u, phi) exactly as lib/staircase/core.ts integrates it:
 *
 *     xOct_j     = (u - j) * log2(ratio)            octaves from the focus tempo
 *     position_j = phi * ratio^(-j)  (beats, mod loopBeats)
 *
 * so the tape stays phase-locked to the drums, and relabelling the layers (u wraps, phi is
 * scaled by ratio) needs no special handling.
 *
 * Plain script: no imports. TapeLayers is independent of the audio API so tests can run it in
 * node:vm; the processor at the bottom only wires it to the audio thread.
 */

/** Taps either side of the centre of the half-band filter. Odd, so every second tap is zero. */
const KERNEL_REACH = 23;
const KAISER_BETA = 8;
/** Decimation stops once a level is this short. */
const MIN_LEVEL_LENGTH = 32;
const DEFAULT_RANGE = { loOct: -3, hiOct: 9, edgeOct: 1.5 };
/** Stereo spread: a head leans this far (of +-1) to one side, its neighbours to the other. */
const PAN_DEPTH = 0.35;
const DC_BLOCKER_HZ = 20;
/** Mip samples computed per block of audio while a new loop is being built, about 0.3 ms of work. */
const BUILD_SAMPLES_PER_BLOCK = 8192;
/** Time to dip the output when the loop is swapped, so the change does not click. */
const SWAP_DIP_SECONDS = 0.01;
const SLOPE_EPSILON = 1e-9;
/**
 * A frame older than this (a stalled tab, a transport that stopped) is not extrapolated any
 * further: the heads fall silent. The closed form grows exponentially with the age of the frame
 * and overflows after hours, and one NaN stays in the DC blocker for good.
 */
const MAX_FRAME_AGE_SECONDS = 60;

function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 60 && term > 1e-14 * sum; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
  }
  return sum;
}

/**
 * Half-band low-pass (cutoff a quarter of the sample rate, Kaiser window), as taps[m] = h[m]
 * for m = 0..KERNEL_REACH with h symmetric. Gain at DC is exactly 1, so a pulse keeps its
 * area when decimated: that area is what a fast pulse train turns into as a tone.
 */
function halfBandKernel() {
  const taps = new Float64Array(KERNEL_REACH + 1);
  const norm = besselI0(KAISER_BETA);
  let sum = 0;
  for (let m = 0; m <= KERNEL_REACH; m++) {
    if (m > 0 && m % 2 === 0) continue;
    const ideal = m === 0 ? 0.5 : Math.sin((Math.PI * m) / 2) / (Math.PI * m);
    const r = m / KERNEL_REACH;
    taps[m] = (ideal * besselI0(KAISER_BETA * Math.sqrt(1 - r * r))) / norm;
    sum += m === 0 ? taps[m] : 2 * taps[m];
  }
  for (let m = 0; m <= KERNEL_REACH; m++) taps[m] /= sum;
  return taps;
}

const KERNEL = halfBandKernel();

function positiveMod(value, mod) {
  const rem = value % mod;
  return rem < 0 ? rem + mod : rem;
}

/**
 * The loop and its copies low-passed and decimated by 2, 4, 8, ... (circularly), in one array.
 * Level k holds sample i of the loop at 2^k * i, so levels stay aligned with the original; a
 * loop whose length is not a multiple of 2^k only distorts the last interval of that level.
 * Every level ends with copies of its first two samples, so interpolation needs no wrap test
 * even when a position lands on or a rounding error past the end of the loop.
 *
 * The chain takes a few milliseconds for a long loop, which is more than one block of audio,
 * so it is built a slice at a time (step) while the previous loop keeps playing.
 */
class MipBuilder {
  constructor(loop) {
    const samples = loop.samples;
    this.lengths = [samples.length];
    while (this.lengths[this.lengths.length - 1] > MIN_LEVEL_LENGTH) {
      this.lengths.push(Math.ceil(this.lengths[this.lengths.length - 1] / 2));
    }
    const offsets = new Int32Array(this.lengths.length);
    let total = 0;
    for (let k = 0; k < this.lengths.length; k++) {
      offsets[k] = total;
      total += this.lengths[k] + 2;
    }
    const data = new Float32Array(total);
    data.set(samples, 0);
    data[samples.length] = samples[0];
    data[samples.length + 1] = samples[1];
    this.padded = new Float32Array(samples.length + 2 * KERNEL_REACH);
    /** The next level to fill and the next sample of it. */
    this.level = 1;
    this.index = 0;
    this.loop = {
      data,
      offsets,
      maxLevel: this.lengths.length - 1,
      loopBeats: loop.loopBeats,
      invLoopBeats: 1 / loop.loopBeats,
      samplesPerBeat: samples.length / loop.loopBeats,
    };
  }

  /** Computes up to `budget` more samples of the chain. Returns true once it is complete. */
  step(budget) {
    const { data, offsets } = this.loop;
    const { lengths, padded } = this;
    const reach = KERNEL_REACH;
    while (budget > 0 && this.level < lengths.length) {
      const from = lengths[this.level - 1];
      const src = offsets[this.level - 1];
      const dst = offsets[this.level];
      if (this.index === 0) {
        // Circular extension on both sides, so the filter below needs no index checks.
        padded.set(data.subarray(src, src + from), reach);
        for (let i = 0; i < reach; i++) {
          padded[reach - 1 - i] = data[src + positiveMod(from - 1 - i, from)];
          padded[reach + from + i] = data[src + (i % from)];
        }
      }
      const end = Math.min(lengths[this.level], this.index + budget);
      for (let i = this.index; i < end; i++) {
        const c = 2 * i + reach;
        let acc = KERNEL[0] * padded[c];
        for (let m = 1; m <= reach; m += 2) acc += KERNEL[m] * (padded[c - m] + padded[c + m]);
        data[dst + i] = acc;
      }
      budget -= end - this.index;
      this.index = end;
      if (end === lengths[this.level]) {
        data[dst + end] = data[dst];
        data[dst + end + 1] = data[dst + 1];
        this.level++;
        this.index = 0;
      }
    }
    return this.level >= lengths.length;
  }
}

/** Samples of level k per sample of the original: 2^-k. */
const LEVEL_SCALE = Float64Array.from({ length: 32 }, (_, k) => Math.pow(2, -k));

function smoothstep(t) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Linear interpolation at fractional index x of one level. */
function readLevel(data, offset, x) {
  const i = x | 0;
  const a = data[offset + i];
  return a + (x - i) * (data[offset + i + 1] - a);
}

class TapeLayers {
  /** options: { frame?, loop?, range? }, as in the processorOptions of the node. */
  constructor(options = {}) {
    this.range = { ...DEFAULT_RANGE };
    /** The loop in use; a new one being built, and then waiting for the output to dip before it takes over. */
    this.loop = null;
    this.building = null;
    this.pending = null;
    this.dip = 1;
    /** Frame in effect, and frames that arrived ahead of their time, oldest first. */
    this.frame = null;
    this.queue = [];
    this.dcInL = 0;
    this.dcInR = 0;
    this.dcOutL = 0;
    this.dcOutR = 0;
    if (options.range) this.setRange(options.range);
    if (options.loop) {
      // Nothing is playing yet (offline rendering, tests), so the whole chain can be built at once.
      this.setLoop(options.loop);
      if (this.building) {
        this.building.step(Infinity);
        this.loop = this.building.loop;
        this.building = null;
      }
    }
    if (options.frame) this.setFrame(options.frame);
  }

  /** range: { loOct, hiOct, edgeOct }, octaves from the focus tempo. Zero outside, smooth rise over edgeOct. */
  setRange({ loOct = this.range.loOct, hiOct = this.range.hiOct, edgeOct = this.range.edgeOct }) {
    this.range = { loOct, hiOct, edgeOct: Math.max(edgeOct, 1e-3) };
  }

  /**
   * loop: { samples: Float32Array, loopBeats, naturalBeatHz }. Anything unusable clears the loop.
   * The mips of a long loop take longer than a block of audio, so they are built a slice per
   * block; the previous loop (or silence) plays until the new one is ready.
   */
  setLoop(loop) {
    this.pending = null;
    this.building = null;
    if (!loop || !loop.samples || loop.samples.length < 2 || !(loop.loopBeats > 0)) {
      this.loop = null;
      return;
    }
    this.building = new MipBuilder(loop);
  }

  /**
   * frame: { when, u, phi, relabels, tempoSlope, focusHz, ratio } as in lib/sound/tape.ts.
   * It takes over at context time `when`. Frames already queued for that time or later are
   * superseded. `relabels` is not needed: heads are placed from (u, phi) alone. A frame with a
   * number that is not finite is ignored: one NaN would stay in the DC blocker for good.
   */
  setFrame(frame) {
    const numbers = [frame.when, frame.u, frame.phi, frame.tempoSlope, frame.focusHz, frame.ratio];
    if (!numbers.every(Number.isFinite) || frame.ratio <= 1) return;
    const spacing = Math.log2(frame.ratio);
    while (this.queue.length > 0 && this.queue[this.queue.length - 1].when >= frame.when) {
      this.queue.pop();
    }
    this.queue.push({
      when: frame.when,
      u: frame.u,
      phi: frame.phi,
      focusHz: frame.focusHz,
      ratio: frame.ratio,
      spacing,
      growth: (frame.tempoSlope * Math.LN2) / 60,
      // beats per second of layer 0 at `when`
      rate: frame.focusHz * Math.pow(frame.ratio, frame.u),
      uPerSecond: frame.tempoSlope / 60 / spacing,
      // ratio^-j of the slowest head: changes only when a head enters or leaves the range
      slowJ: NaN,
      slowScale: 1,
    });
  }

  /**
   * Fills outL and outR (one block) for context time startTime + i / sampleRate. Silent while
   * there is no frame or no loop. If no newer frame arrives the last one keeps being
   * extrapolated for a while, so a stalled main thread does not stop or glitch the tape.
   */
  render(outL, outR, startTime, sampleRate) {
    const { loOct, hiOct, edgeOct } = this.range;
    const invEdge = 1 / edgeOct;
    const span = hiOct - loOct;
    const dcCoef = 1 - (2 * Math.PI * DC_BLOCKER_HZ) / sampleRate;
    const dipStep = 1 / (SWAP_DIP_SECONDS * sampleRate);
    if (this.building && this.building.step(BUILD_SAMPLES_PER_BLOCK)) {
      this.pending = this.building.loop;
      this.building = null;
    }
    if (!this.loop && this.pending) {
      // the first loop has nothing to dip from
      this.loop = this.pending;
      this.pending = null;
    }
    let frame = this.frame;
    let speedOct = null;

    for (let i = 0; i < outL.length; i++) {
      const t = startTime + i / sampleRate;
      while (this.queue.length > 0 && this.queue[0].when <= t) {
        frame = this.frame = this.queue.shift();
        speedOct = null;
      }
      if (!frame || !this.loop || t - frame.when > MAX_FRAME_AGE_SECONDS) {
        outL[i] = 0;
        outR[i] = 0;
        continue;
      }
      if (this.pending) {
        this.dip -= dipStep;
        if (this.dip <= 0) {
          this.dip = 0;
          this.loop = this.pending;
          this.pending = null;
          speedOct = null;
        }
      } else if (this.dip < 1) {
        this.dip = Math.min(1, this.dip + dipStep);
      }
      const { data, offsets, maxLevel, loopBeats, invLoopBeats, samplesPerBeat } = this.loop;
      if (speedOct === null) {
        // log2 of the speed, in source samples per output sample, of a head at the focus tempo
        speedOct = Math.log2((frame.focusHz * samplesPerBeat) / sampleRate);
      }

      // The staircase state, in closed form from the frame (core.ts: advanceState).
      const dt = t - frame.when;
      const a = frame.growth;
      const beats =
        Math.abs(a) < SLOPE_EPSILON ? frame.rate * dt : (frame.rate * Math.expm1(a * dt)) / a;
      const phi = frame.phi + beats;
      const u = frame.u + frame.uPerSecond * dt;

      // Heads j from the slowest (just above loOct) to the fastest (just below hiOct).
      const slowest = Math.floor(u - loOct / frame.spacing);
      const fastest = Math.ceil(u - hiOct / frame.spacing);
      if (frame.slowJ !== slowest) {
        frame.slowJ = slowest;
        frame.slowScale = Math.pow(frame.ratio, -slowest);
      }
      // Heads one layer apart lean to opposite sides by PAN_DEPTH * cos(pi * (u - j)). That
      // depends on a head's octave position alone, so it is the same after relabelling, and
      // after one full step of u the whole stereo image is back where it started.
      const lean = (Math.PI / 4) * (1 + PAN_DEPTH * Math.cos(Math.PI * u));
      const gainEven = Math.cos(lean);
      const gainOdd = Math.sin(lean);

      let even = 0;
      let odd = 0;
      let scale = frame.slowScale;
      for (let j = slowest; j >= fastest; j--, scale *= frame.ratio) {
        const x = (u - j) * frame.spacing;
        const window = smoothstep((x - loOct) * invEdge) * smoothstep((hiOct - x) * invEdge);
        if (window <= 0) continue;

        const beat = phi * scale;
        const source = (beat - Math.floor(beat * invLoopBeats) * loopBeats) * samplesPerBeat;

        // The level whose bandwidth matches the speed, crossfaded with the next one.
        const levelF = Math.min(x + speedOct, maxLevel);
        const level = levelF > 0 ? levelF | 0 : 0;
        let s = readLevel(data, offsets[level], source * LEVEL_SCALE[level]);
        if (level < maxLevel && levelF > level) {
          const coarser = readLevel(data, offsets[level + 1], source * LEVEL_SCALE[level + 1]);
          s += (levelF - level) * (coarser - s);
        }
        if (j & 1) odd += s * window;
        else even += s * window;
      }
      const sumL = even * gainEven + odd * gainOdd;
      const sumR = even * gainOdd + odd * gainEven;

      // Equal power over the nominal number of heads, so the level does not depend on the ratio.
      const norm = this.dip * Math.sqrt(frame.spacing / span);
      const inL = sumL * norm;
      const inR = sumR * norm;
      this.dcOutL = inL - this.dcInL + dcCoef * this.dcOutL;
      this.dcOutR = inR - this.dcInR + dcCoef * this.dcOutR;
      this.dcInL = inL;
      this.dcInR = inR;
      outL[i] = this.dcOutL;
      outR[i] = this.dcOutR;
    }
  }
}

class TapeLayersProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.tape = new TapeLayers(options.processorOptions);
    /**
     * Frames rendered so far, counted here instead of read from currentFrame: after an offline
     * context is suspended and resumed, Chrome reports the same currentFrame for a few blocks in a
     * row, which would play the same few milliseconds of tape again and again.
     */
    this.frames = -1;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'frame') this.tape.setFrame(message);
      else if (message.type === 'loop') this.tape.setLoop(message);
      else if (message.type === 'range') this.tape.setRange(message);
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const block = output[0].length;
    if (this.frames < 0) this.frames = currentFrame;
    this.tape.render(output[0], output[1], this.frames / sampleRate, sampleRate);
    this.frames += block;
    return true;
  }
}

registerProcessor('tape-layers', TapeLayersProcessor);
