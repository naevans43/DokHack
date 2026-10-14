import { assetUrl } from './asset-url';
import { tokenize } from './nlp';
import type { KoreanCandidate } from './types';

// Local (no network) English -> Korean gloss lookup, backed by
// static/krdict.json — a reverse index built from KRDICT (국립국어원's
// Korean-learners' dictionary) by scripts/extract-krdict.mjs. See that
// script's header comment for the full story and the row shape.
//
// A single English word is often ambiguous ("run" has ~35 candidate Korean
// words across senses), so candidates are ranked with a Lesk-style score:
// how many words the clicked word's sentence shares with each candidate's
// (stopword-filtered) English definition, plus a bonus for matching the
// sentence's actual part of speech, minus a small penalty for rarer words.
// This is a purely local heuristic, not true disambiguation — it's meant to
// put a plausible sense first, not guarantee the right one.
//
// Both sides of the overlap comparison are lemmatized with the same
// wink-nlp tokenizer already loaded for highlighting ("felt"/"feels" and
// "feeling" all reduce to "feel") — extract-krdict.mjs lemmatizes the
// definition words at build time, and lookupKorean() lemmatizes the
// sentence the same way at lookup time, so irregular forms actually line up
// instead of only matching by exact string.

// `first` (added after the initial krdict.json build -- absent/undefined on
// any row from a not-yet-regenerated file, which just means "no signal
// either way," never a crash) marks whether this English word was the
// *first*-listed synonym in KRDICT's own translation field for that
// Korean word's sense ("run" in "run;dash;sprint"), vs. a buried
// alternate translation further down the list -- a stronger signal of
// direct correspondence than an overlap score alone, and the thing
// roadmap item 10 calls out as still open (wordnet.ts gets an equivalent
// signal for free from WordNet's own frequency-ordered sense lists; KRDICT
// has no such ordering between *senses*, but does order words *within* a
// sense's translation list, which is what this captures).
type Row = [ko: string, posChar: string, level: 1 | 2 | 3, defWords: string, first?: 0 | 1];
type RawIndex = Record<string, Row[]>;

const STOPWORDS = new Set(
  ('a an the of to in on at for from with by as is are was were be been being ' +
   'this that these those it its it\'s or and but not no do does did have has had ' +
   'will would can could should shall may might must if then than so such very ' +
   'about into onto over under between among through during before after above below ' +
   'up down out off again further once here there when where why how all any both ' +
   'each few more most other some such only own same too also just').split(' '),
);

// wink-nlp universal POS tag -> the Korean POS's first character, so a
// candidate whose part of speech matches how the word is actually used in
// the sentence scores higher. No entry = no bonus either way (e.g.
// conjunctions don't map cleanly onto a Korean word class).
const WINK_TO_KO_POS: Record<string, string> = {
  NOUN: '명', PROPN: '명', VERB: '동', AUX: '동', ADJ: '형', ADV: '부',
  PRON: '대', NUM: '수', DET: '관', INTJ: '감',
};

let indexPromise: Promise<RawIndex> | null = null;

function loadIndex(): Promise<RawIndex> {
  if (!indexPromise) {
    indexPromise = fetch(assetUrl('krdict.json')).then((r) => r.json());
  }
  return indexPromise;
}

async function contentWords(text: string, exclude: string): Promise<Set<string>> {
  const lemmas = (await tokenize(text)).map((t) => t.lemma);
  const words = new Set(lemmas.filter((w) => w.length > 1 && !STOPWORDS.has(w)));
  // A KRDICT English gloss can mention the headword itself (e.g. defining a
  // sense of "run" using the word "run"), which would otherwise score every
  // candidate sharing that gloss text a free +3 regardless of which sense
  // actually fits — same class of bug found in wordnet.ts's lookupEnglish().
  words.delete(exclude);
  return words;
}

export async function lookupKorean(lemma: string, sentence: string, pos: string, limit = 5): Promise<KoreanCandidate[]> {
  const index = await loadIndex();
  const rows = index[lemma.toLowerCase()];
  if (!rows?.length) return [];

  const wantedPos = WINK_TO_KO_POS[pos];
  const ctx = await contentWords(sentence, lemma.toLowerCase());

  const best = new Map<string, { level: 1 | 2 | 3; score: number }>();
  for (const [ko, posChar, level, defWords, first] of rows) {
    let score = 0;
    if (defWords) for (const w of defWords.split(' ')) if (ctx.has(w)) score += 3;
    if (wantedPos && posChar === wantedPos) score += 2;
    if (first) score += 1.5; // first-listed synonym for this sense, not a buried alternate translation
    score -= (level - 1) * 0.5; // mild preference for more common words

    const prev = best.get(ko);
    if (!prev || score > prev.score) best.set(ko, { level, score });
  }

  return [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([ko, { level }]) => ({ ko, level }));
}
