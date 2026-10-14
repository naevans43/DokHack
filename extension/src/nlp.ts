import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import { assetUrl } from './asset-url';
import type { Token } from './types';

// sbd + pos is the minimum for POS-aware lemmas ("better" → "good",
// "mice" → "mouse"). Skipping ner/sentiment keeps it fast.
const nlp = winkNLP(model, ['sbd', 'pos']);
const its = nlp.its;

const HAS_LETTER = /[a-z]/i;

// Phrasal verbs / verbal idioms ("give up", "turn a blind eye") and fixed
// discourse connectors ("as a result", "in a nutshell") — built by
// scripts/extract-wordnet.mjs from WordNet's own multi-word verb/adverb
// entries plus a hand-curated top-up list (roadmap item 4's "MWE list"
// half). Keyed by first lemma word -> the full word sequences starting
// there (longest first) and which class each is, so the merge check below
// can require a compatible head POS per class. Lazily fetched once, same
// pattern as krdict.ts/wordnet.ts's own JSON indexes.
// `nb`: parts of speech that may not directly follow for the merge to apply
// (slang from static/expressions.json: "hit different" merges, "hit different
// targets" -- literal -- doesn't).
// `hp`: extra head parts of speech accepted -- wink-nlp tags slang verbs as
// nouns more often than not ("This song hits/NOUN different", "Go touch/NOUN
// grass"), which would otherwise never merge.
interface PhraseCandidate { words: string[]; pos: 'v' | 'r'; nb?: string[]; hp?: string[]; }
type PhraseIndex = Record<string, PhraseCandidate[]>;

// A verb-phrase head ("give", "turn") needs to actually be used as a verb
// -- otherwise "look" (NOUN) in "a good look up close" would wrongly merge
// with the verb phrase "look up" (found by testing). A connector-phrase
// head ("as", "in", "on", ...) is checked more loosely: these are always
// function words, never genuinely ambiguous with a noun/verb reading, but
// wink-nlp isn't fully consistent about which of ADP/ADV/SCONJ it picks for
// the same word in different sentences (e.g. "as" is ADP in "as a matter
// of fact" but ADV in "as usual" -- both correct, not the kind of ambiguity
// the strict check guards against).
function headMatchesClass(pos: string, cls: 'v' | 'r'): boolean {
  return cls === 'v' ? pos === 'VERB' || pos === 'AUX' : pos === 'ADP' || pos === 'ADV' || pos === 'SCONJ';
}
let phrasesPromise: Promise<PhraseIndex> | null = null;
function loadPhrases(): Promise<PhraseIndex> {
  if (!phrasesPromise) {
    phrasesPromise = fetch(assetUrl('phrases.json')).then((r) => r.json());
  }
  return phrasesPromise;
}

/** Tokenize one run of text and return the words worth tracking, with offsets. */
export async function tokenize(text: string): Promise<Token[]> {
  const doc = nlp.readDoc(text);
  const tokens: Token[] = [];
  let cursor = 0;

  doc.tokens().each((t: any) => {
    const surface: string = t.out();
    cursor += (t.out(its.precedingSpaces) as string).length;
    // wink reconstructs text exactly, but guard against drift anyway.
    if (text.substr(cursor, surface.length) !== surface) {
      const found = text.indexOf(surface, cursor);
      if (found === -1) return;
      cursor = found;
    }
    const start = cursor;
    cursor += surface.length;

    if (t.out(its.type) !== 'word' || !HAS_LETTER.test(surface)) return;
    // Contraction pieces: n't, 's, 're, 'll, 've, 'd, 'm
    if (/^(n['’]t|['’][a-z]+)$/i.test(surface)) return;

    const pos: string = t.out(its.pos);
    // Capitalized proper nouns (Seoul, Netflix) are almost never vocab.
    if (pos === 'PROPN' && /^[A-Z]/.test(surface)) return;

    tokens.push({
      start,
      end: start + surface.length,
      surface,
      lemma: normalizeLemma(t.out(its.lemma), surface),
      pos,
    });
  });

  return mergePhrasalVerbs(tokens, text, await loadPhrases());
}

/**
 * Merges a token with the words of a matching phrasal verb / idiom /
 * discourse connector right after it ("give" + "up" -> one token, lemma
 * "give up"), so it's highlighted, clicked, and status-tracked as a single
 * vocabulary item instead of several unrelated words. Only merges tokens
 * that are genuinely adjacent in the source text (nothing but whitespace
 * between them) — this only ever catches the contiguous case ("give it
 * up"'s "give" and "up" are NOT adjacent, so it's missed). A split
 * two-word verb phrase ("turn the lights off") is caught separately below
 * by findSplitParticle() — real dependency parsing would place the object
 * properly, which wink-nlp doesn't have (see CLAUDE.md roadmap item 4),
 * so this is the "cheap bounded heuristic" noted there instead.
 */
function mergePhrasalVerbs(tokens: Token[], text: string, phrases: PhraseIndex): Token[] {
  const out: Token[] = [];
  const skip = new Set<number>(); // particle indices consumed by a split match below
  for (let i = 0; i < tokens.length; i++) {
    if (skip.has(i)) continue;
    const head = tokens[i];
    const candidates = phrases[head.lemma]?.filter((c) => headMatchesClass(head.pos, c.pos) || c.hp?.includes(head.pos));
    const match = candidates && matchPhrase(tokens, i, candidates, text);
    if (match) {
      const last = tokens[i + match.words.length - 1];
      out.push({
        start: head.start,
        end: last.end,
        surface: text.slice(head.start, last.end),
        lemma: match.words.join(' '),
        pos: match.pos === 'v' ? 'VERB' : 'ADV',
      });
      i += match.words.length - 1;
      continue;
    }
    const split = candidates && findSplitParticle(tokens, i, candidates, text);
    if (split) {
      // Range/surface stay just the verb's own span -- there's no single
      // contiguous Range that could cover "turn ... off" with "the lights"
      // excluded in between, so only the lemma changes to the phrasal
      // form. The particle token is dropped from the output (skip.add)
      // rather than left as its own ordinary word, since it's now "part
      // of" this verb the same way it would be in the contiguous case.
      out.push({ ...head, lemma: split.words.join(' ') });
      skip.add(split.particleIndex);
      continue;
    }
    out.push(head);
  }
  return out;
}

/** `candidates` is longest-first; returns the first (so longest) one that fully matches. */
function matchPhrase(tokens: Token[], start: number, candidates: PhraseCandidate[], text: string): PhraseCandidate | null {
  return candidates.find(({ words, nb }) => {
    if (start + words.length > tokens.length) return false;
    for (let k = 1; k < words.length; k++) {
      const prev = tokens[start + k - 1];
      const cur = tokens[start + k];
      if (cur.lemma !== words[k]) return false;
      if (!/^\s*$/.test(text.slice(prev.end, cur.start))) return false; // adjacent, no punctuation between
    }
    const last = tokens[start + words.length - 1];
    const next = tokens[start + words.length];
    if (nb && next && /^\s*$/.test(text.slice(last.end, next.start)) && nb.includes(next.pos)) return false;
    return true;
  }) ?? null;
}

// How far past the verb to look for a stranded particle -- long enough for
// a real short object noun phrase ("the lights", "her old reading glasses"),
// short enough to stay unlikely to wander into an unrelated later clause.
const MAX_SPLIT_GAP = 4;
// A plausible (if bare-bones) English noun phrase: determiner(s)/adjective(s)
// then a noun or pronoun head. Anything else between the verb and a
// same-lemma particle (another verb, a conjunction, straight-up unrelated
// text) is treated as "this isn't actually that phrasal verb."
const NP_POS = new Set(['DET', 'ADJ', 'NOUN', 'PRON']);

/**
 * Looks for a stranded particle past a short object noun phrase ("turn
 * [the lights] off"). Only ever tried for genuine two-word verb-phrase
 * entries — a longer idiom like "turn a blind eye" has a fixed object
 * that *is* the idiom, not a free slot something else can be inserted
 * into, so splitting it wouldn't mean anything. `candidates` is already
 * filtered to the head's matching class (headMatchesClass in the caller),
 * so an explicit pos==='v' check here additionally rules out a 'r'-class
 * (connector) candidate ever reaching this path, since connectors don't
 * have an object to split around either.
 */
function findSplitParticle(
  tokens: Token[],
  headIndex: number,
  candidates: PhraseCandidate[],
  text: string,
): { words: string[]; particleIndex: number } | null {
  const splitCandidates = candidates.filter((c) => c.pos === 'v' && c.words.length === 2);
  if (!splitCandidates.length) return null;

  // +1: MAX_SPLIT_GAP counts intervening object-noun-phrase words, and the
  // particle itself is one token past the last of those.
  for (let j = headIndex + 1; j <= headIndex + MAX_SPLIT_GAP + 1 && j < tokens.length; j++) {
    const prev = tokens[j - 1];
    const cur = tokens[j];
    if (!/^\s*$/.test(text.slice(prev.end, cur.start))) break; // punctuation breaks the run
    if (j > headIndex + 1) {
      const found = splitCandidates.find((c) => c.words[1] === cur.lemma);
      if (found) return { words: found.words, particleIndex: j };
    }
    if (!NP_POS.has(cur.pos)) break; // not a plausible object noun phrase word -- give up
  }
  return null;
}

function normalizeLemma(lemma: string, surface: string): string {
  const l = (lemma || surface).toLowerCase().replace(/’/g, "'");
  return l.normalize('NFC');
}
