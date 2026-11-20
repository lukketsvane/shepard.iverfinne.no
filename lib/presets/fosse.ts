import { Preset } from '../staircase/types';
import { FOUR_FOUR, Note, line, params, pattern } from './build';

/**
 * Stressed vowels, from the most open mouth to the most closed. The rule that sets every
 * word's note: the more closed the vowel, the higher the note, climbing D Dorian from D.
 * uh = mud, o = holler and haul, a = tactile, e = chirp and ladle, eye = rise,
 * i = timid, ee = leeks and frugal.
 */
type Vowel = 'uh' | 'o' | 'a' | 'e' | 'eye' | 'i' | 'ee';
const D_DORIAN: Record<Vowel, number> = { uh: 62, o: 64, a: 65, e: 67, eye: 69, i: 71, ee: 72 };

/** The poem's words in order, with their syllables and the stressed vowel of each. */
const POEM: Array<[word: string, syllables: number, vowel: Vowel]> = [
  ['MudCrab', 2, 'uh'], ['elastic', 3, 'a'], ['Appropriate', 4, 'o'], ['Chirp', 1, 'e'],
  ['Somber', 2, 'o'], ['Rise', 1, 'eye'], ['Twigs', 1, 'i'], ['Frugal', 2, 'ee'],
  ['Rambunctuous', 4, 'uh'], ['Rudder', 2, 'uh'], ['Ladle', 2, 'e'], ['Timid', 2, 'i'],
  ['Holler', 2, 'o'], ['Ittenuate', 4, 'e'], ['Enamel', 3, 'a'], ['Brittle', 2, 'i'],
  ['Tactile', 2, 'a'], ['Lutomatic', 4, 'a'], ['Leeks', 1, 'ee'], ['Tittelate', 3, 'i'],
  ['Grievance', 2, 'ee'], ['Scion', 2, 'eye'], ['Transgress', 2, 'a'], ['Haul', 1, 'o'],
  ['Edict', 2, 'ee'], ['Frizzy', 2, 'i'], ['Subverted', 3, 'e'], ['Unadorned', 3, 'o'],
  ['Body', 2, 'o'], ['Language', 2, 'a'], ['Cedar', 2, 'ee'], ['Shrub', 1, 'uh'],
];

const SIXTEENTH = 0.25;
/** 71 sixteenths, a prime, so the poem never meets the bar of sixteen the same way twice. */
const SYLLABLES = POEM.reduce((sum, [, syllables]) => sum + syllables, 0);

let start = 0;
const sung: Note[] = POEM.map(([, syllables, vowel]) => {
  const note: Note = [start * SIXTEENTH, syllables * SIXTEENTH, D_DORIAN[vowel]];
  start += syllables;
  return note;
});

/** One note a word, on its first syllable. */
const words = line('words', 'keys', sung, SYLLABLES * SIXTEENTH, FOUR_FOUR, { gain: 1.5, center: -0.3, maxHz: 7 });
/** One soft hit a syllable, the first of each word a little stronger. */
const syllables = pattern(
  'syllables',
  'hat',
  POEM.map(([, n]) => 'X' + 'o'.repeat(n - 1)).join(''),
  4,
  FOUR_FOUR,
  { gain: 1.8 }
);
/** A low D once a bar, the one thing that stays where it is. */
const ground = line('ground', 'bass', [[0, 3.5, 38]], 4, FOUR_FOUR, { gain: 1.2 });

const TEXT = [
  'The ground will provide, I think, and I think it, I do, and I stand there in the kitchen with the ladle in my hand, and it is enamel, the ladle, white enamel with a black edge where it has chipped, and it is brittle, I think, all of it is brittle, and outside it is coming down, the snow, no, it is not snow, it is plastic, it is all the small neon things coming down, the articles, and I stand in it, I try to stand in it, and that is what it is to keep it together, I think, to stand, only to stand there',
  'and I think of the bricks, all the bricks I laid, one and then one more, for the princes, so they could prance, yes, prance, and I carried the pretty things, I carried them light as smoke, and nobody saw it, and it does not matter, I think, it does not matter at all',
  'and somewhere a glacier is bleeding, slowly, it bleeds the cream, and I remember the shape of the scoop, the ice cream scoop, the round of it in the hand, the cold of it, and I think of the rudder, of the boat, and of the twigs in the water and the mud crab under the stone, and the body has a language, I think, the body says what the mouth will not say, and the mouth says only words, mud crab, elastic, chirp, somber, rise, and the words rise, they rise and fall away and new words come up from under, and it is the same words, it is always the same words, and they rise',
  'and it is the cedar and it is the shrub, and let yourself, I think, let yourself surren, and I cannot say the rest of it, let yourself surrender, to the simple rug, to the floor, and I lie down on the rug, and it is simple, and it is plenty, or it is just enough, and the ground will provide, I think',
];

export const fosse: Preset = {
  id: 'fosse',
  name: 'The Ground Will Provide',
  blurb:
    'Thirty-two words become notes and soft ticks, one tick for every syllable, while the tempo and pitch sink together without end, like a tape winding down.',
  meter: FOUR_FOUR,
  kit: 'pure',
  timbre: 'glass',
  trimDb: -7.5,
  tracks: [words, syllables, ground],
  params: params({
    focusBpm: 82,
    tempoSlope: -1.2,
    pitchSlope: -1.2,
    pitchLink: true,
    levels: { drums: 1, melody: 0.9, pad: 0.55, sweep: 0, tape: 0.55, reverb: 0.6 },
  }),
  tonic: 50,
  padChord: [0, 7],
  padAnchor: false,
  tapeUrl: '/audio/fosse-ground.mp3',
  words: { trackId: 'words', list: POEM.map(([word]) => word) },
  text: TEXT.join('\n\n'),
  credit:
    'A poem by the owner of this site, set as rhythm, with a text written after the manner of Jon Fosse: repetition, slow circling sentences, ending where it begins. Each word lasts as many sixteenths as it has syllables, and its note comes from its stressed vowel.',
};
