import type { PageStats } from './types';

// Comprehension meter: what share of the running words on a page (or a
// YouTube video's transcript) the reader already knows. Reading research puts
// comfortable, learnable text at roughly 95% known running words -- below
// that, unknown words pile up faster than context can carry them; well above
// it, there's little left to learn. Ignored words (names, junk) count on
// neither side. Shared by the toolbar popup and youtube.ts's panel chip.

export const TARGET_PCT = 95;

export type Band = 'hard' | 'stretch' | 'target' | 'easy';

export interface Comprehension {
  pct: number; // 0-100, rounded down so 94.6% never reads as "95, in the band"
  counted: number; // running words considered
  unknownCount: number; // occurrences not yet known (unknown + seen + learning)
  band: Band;
  label: string; // short Korean label for the band
}

export function comprehensionOf(s: PageStats | undefined | null): Comprehension | null {
  if (!s) return null;
  const counted = s.total - s.ignored;
  if (counted <= 0) return null;
  const pct = Math.floor((s.known / counted) * 100);
  const band: Band = pct < 85 ? 'hard' : pct < TARGET_PCT ? 'stretch' : pct < 99 ? 'target' : 'easy';
  const label = { hard: '어려워요', stretch: '조금 어려워요', target: '딱 좋아요', easy: '쉬워요' }[band];
  return { pct, counted, unknownCount: s.unknown + s.seen + s.learning, band, label };
}
