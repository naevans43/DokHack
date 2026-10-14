import { assetUrl } from './asset-url';
import type { Token } from './types';

// Frequency badge: marks a highlighted word as common (worth learning first)
// or rare (fine to skip), from static/frequency.json -- a generated lemma
// ranking (scripts/extract-frequency.mjs; never hand-edit it). Runs in the
// background worker only, like the other dictionaries: tokenize() results are
// annotated before they go back to the page. The thresholds come with the
// data, since they depend on which source built it (see the script).

interface FrequencyData {
  source: string;
  commonMax: number;
  rareMin: number | null;
  words: string[];
}

let dataPromise: Promise<{ rank: Map<string, number>; commonMax: number; rareMin: number | null } | null> | null = null;

function load() {
  if (!dataPromise) {
    dataPromise = fetch(assetUrl('frequency.json'))
      .then((r) => r.json() as Promise<FrequencyData>)
      .then((d) => ({ rank: new Map(d.words.map((w, i) => [w, i + 1])), commonMax: d.commonMax, rareMin: d.rareMin }))
      .catch(() => { dataPromise = null; return null; });
  }
  return dataPromise;
}

/** Sets `rank`/`freq` on single-word tokens in place (merged phrases get neither). */
export async function annotateFrequency(tokens: Token[]): Promise<Token[]> {
  const data = await load();
  if (!data) return tokens;
  for (const t of tokens) {
    if (t.lemma.includes(' ')) continue;
    const rank = data.rank.get(t.lemma);
    if (rank !== undefined) t.rank = rank;
    if (rank !== undefined && rank <= data.commonMax) t.freq = 'common';
    else if (data.rareMin !== null && (rank === undefined || rank > data.rareMin)) t.freq = 'rare';
  }
  return tokens;
}
