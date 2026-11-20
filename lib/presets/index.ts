import { Preset } from '../staircase/types';
import { acrid } from './acrid';
import { alberto } from './alberto';
import { diMeola } from './di-meola';
import { fosse } from './fosse';
import { icctHedral } from './icct-hedral';
import { paradox } from './paradox';
import { pulse } from './pulse';
import { troy } from './troy';

/** The first one is what people hear first. */
export const PRESETS: Preset[] = [troy, icctHedral, alberto, acrid, diMeola, fosse, paradox, pulse];
