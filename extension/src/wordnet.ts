import { assetUrl } from './asset-url';
import { tokenize } from './nlp';
import type { LookupResult } from './types';

// Local (no network) English definition lookup, backed by
// static/wordnet.json — a slimmed reverse index built from Princeton
// WordNet by scripts/extract-wordnet.mjs. See that script's header comment
// for the full story (it replaced dictionaryapi.dev, which turned out to be
// unreliable — see CLAUDE.md/Testing) and the row shape.
//
// Same Lesk-style idea as krdict.ts's Korean gloss ranking: a word can have
// many senses ("run" has dozens across noun/verb), so candidates are ranked
// by how much the clicked word's sentence overlaps with each sense's
// (stopword-filtered, lemmatized) definition, plus a part-of-speech match
// bonus, minus a small penalty for how far down that word's
// frequency-ordered sense list ("rank" — see the extraction script) a
// meaning sits.

type Row = [pos: 'noun' | 'verb' | 'adjective' | 'adverb', rank: number, text: string, defWords: string];
type RawIndex = Record<string, Row[]>;

const STOPWORDS = new Set(
  ('a an the of to in on at for from with by as is are was were be been being ' +
   'this that these those it its it\'s or and but not no do does did have has had ' +
   'will would can could should shall may might must if then than so such very ' +
   'about into onto over under between among through during before after above below ' +
   'up down out off again further once here there when where why how all any both ' +
   'each few more most other some such only own same too also just').split(' '),
);

// wink-nlp universal POS tag -> the WordNet part of speech it corresponds
// to, so a sense whose class matches how the word is actually used in the
// sentence scores higher.
const WINK_TO_WN_POS: Record<string, Row[0]> = {
  NOUN: 'noun', PROPN: 'noun', VERB: 'verb', AUX: 'verb', ADJ: 'adjective', ADV: 'adverb',
};

let indexPromise: Promise<RawIndex> | null = null;

function loadIndex(): Promise<RawIndex> {
  if (!indexPromise) {
    indexPromise = fetch(assetUrl('wordnet.json')).then((r) => r.json());
  }
  return indexPromise;
}

async function contentWords(text: string, exclude: string): Promise<Set<string>> {
  const lemmas = (await tokenize(text)).map((t) => t.lemma);
  const words = new Set(lemmas.filter((w) => w.length > 1 && !STOPWORDS.has(w)));
  // Otherwise a definition that happens to mention the headword itself
  // (WordNet's glosses often do, e.g. "flee; take to one's heels; cut and
  // run" for "run") gets a free +3 for that alone, in every sentence,
  // regardless of which sense is actually meant — found by testing "run" in
  // "manages to run a small business" and getting "flee" ranked first.
  words.delete(exclude);
  return words;
}

export async function lookupEnglish(lemma: string, sentence: string, pos: string, limit = 3): Promise<LookupResult> {
  const index = await loadIndex();
  const rows = index[lemma.toLowerCase()];
  const result: LookupResult = { lemma, definitions: [] };
  if (!rows?.length) return result;

  const wantedPos = WINK_TO_WN_POS[pos];
  const ctx = await contentWords(sentence, lemma.toLowerCase());

  const scored = rows.map((row) => {
    const [rowPos, rank, text, defWords] = row;
    let score = 0;
    if (defWords) for (const w of defWords.split(' ')) if (ctx.has(w)) score += 3;
    if (wantedPos && rowPos === wantedPos) score += 2;
    score -= rank * 0.15; // mild preference for this word's more common senses
    return { pos: rowPos, text, score };
  });

  result.definitions = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ pos: p, text }) => ({ pos: p, text }));
  return result;
}
