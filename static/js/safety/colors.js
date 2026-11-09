// Data colors. Families take the validated 8-slot categorical palette (dark steps)
// in fixed order, so a family keeps its color no matter which filters are on.
// "Service & other" is the neutral gray, never a 9th hue.

import { h } from '../util.js';

// Who wrote a record: one color per source everywhere. Same values as --iit / --cpd in safety.css.
export const SOURCE_COLORS = { iit: '#d9142e', cpd: '#1f6fdb' };
const SOURCE_NAMES = { iit: ['IIT', 'IIT Public Safety'], cpd: ['CPD', 'Chicago Police'] };
export const sourceBadge = (source, long = false) => h('span', { class: `src ${source}` }, SOURCE_NAMES[source][long ? 1 : 0]);

export const FAMILY_COLORS = {
  medical: '#3987e5',    // 1 blue
  alarm: '#d95926',      // 2 orange
  theft: '#199e70',      // 3 aqua
  traffic: '#c98500',    // 4 yellow
  suspicious: '#d55181', // 5 magenta
  conduct: '#008300',    // 6 green
  damage: '#9085e9',     // 7 violet
  person: '#e66767',     // 8 red
  other: '#6b7686',      // neutral
};

// Single-hue sequential ramp (blue) for counts on maps and heatmaps; light = few, dark = many
// would vanish into a dark surface, so on this dark UI more = brighter.
export const RAMP = ['#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4'];

export const familyColor = (family) => FAMILY_COLORS[family.id] || FAMILY_COLORS.other;

export function rampColor(value, max) {
  if (!value) return null;
  const step = Math.min(RAMP.length - 1, Math.floor((Math.sqrt(value) / Math.sqrt(max || 1)) * (RAMP.length - 1)));
  return RAMP[step];
}
