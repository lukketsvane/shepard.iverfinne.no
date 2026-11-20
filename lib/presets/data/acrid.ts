import { Note } from '../build';

/**
 * Acrid Avid Jam Shred at 81 BPM, 16 beats: the bass figure (channel 0).
 * Transcribed from public/assets/aistudio/aajs_e2ee4640.mid; each note is
 * [beat, duration in beats, MIDI note], all at one velocity.
 */
export const ACRID_BASS: Note[] = [
  [0, 0.75, 41], [0.75, 0.75, 53], [1.5, 1, 65], [2.25, 0.75, 46], [3, 3.75, 58], [6.75, 1.25, 56],
  [8, 0.75, 41], [8.75, 0.75, 53], [9.5, 1, 65], [10.25, 0.75, 46], [11, 3.75, 58],
  [14.75, 1.25, 56],
];

/**
 * Acrid Avid Jam Shred: the pad line (channel 1), each note doubled an octave up.
 * Transcribed from public/assets/aistudio/aajs_e2ee4640.mid; each note is
 * [beat, duration in beats, MIDI note], all at one velocity.
 */
export const ACRID_PAD: Note[] = [
  [8, 2, 80], [8, 2, 92], [10, 4, 79], [10, 4, 91], [14, 2, 75], [14, 2, 87],
];
