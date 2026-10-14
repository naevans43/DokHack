// Regenerates static/wordnet.json from the Princeton WordNet 3.1 database
// files (bundled by the "wordnet-db" npm package, a devDependency here — no
// separate download needed, unlike scripts/extract-krdict.mjs).
//
// This replaces dictionaryapi.dev as the source of English definitions.
// dictionaryapi.dev is a free, unauthenticated hobby service, and it turned
// out to be unreliable in practice (see CLAUDE.md/Testing) — requests
// routinely took ~20s or came back as a Cloudflare 522 (origin unreachable)
// instead of a normal miss. WordNet is public-domain-adjacent (WordNet
// License — free for any use, attribution appreciated, no redistribution
// restriction) and, bundled locally, is available with zero network calls
// at all, same as krdict.ts's Korean gloss.
//
// WordNet's "database files" format (see wninput(5)/wndb(5)) has two parts
// per part-of-speech (noun/verb/adj/adv):
//   - index.<pos>: one line per headword, ending with a list of synset
//     byte-offsets *ordered by decreasing frequency of use* — i.e. the
//     first offset listed is that word's most common sense. We keep that
//     order as `rank` (0 = most common) so lookup can prefer it, the same
//     idea flagged in CLAUDE.md roadmap item 10 ("weight whether the
//     English word was the first-listed synonym") but for real this time.
//   - data.<pos>: one line per synset, keyed by its own offset (the first
//     field), holding the member words and the gloss (definition, then
//     "; "-separated usage examples in quotes, after a " | ").
//
// Output: static/wordnet.json -- { [word]: [pos, rank, text, defWords][] }
//   - pos: 'noun' | 'verb' | 'adjective' | 'adverb' (adjective satellites,
//     WordNet's "s" type, are folded into 'adjective' — same word class for
//     our purposes)
//   - rank: 0-indexed position in that word's sense-frequency order
//   - text: the definition, examples stripped, capped for display
//   - defWords: up to 8 stopword-filtered, lemmatized words from the
//     definition -- used for Lesk-style overlap scoring against the
//     sentence a word was clicked in (see src/wordnet.ts, mirroring
//     src/krdict.ts's approach for the Korean side)
//
// Also emits static/phrases.json -- roadmap item 4's "MWE list" half, for
// phrasal verbs and verbal idioms ("give up", "turn a blind eye") AND fixed
// adverbial phrases / discourse connectors ("as usual", "in a nutshell").
// WordNet's index.verb and index.adv both list these as ordinary
// (multi-word) entries, so anything lexicalized there is exactly the set
// we want; their definitions go into wordnet.json above under the
// space-joined phrase key ("give up"), same shape as single-word entries,
// so src/wordnet.ts's lookupEnglish() needs no changes to serve them.
// connectors.mjs's hand-curated list (see that file) tops up common
// connectors WordNet doesn't have at all ("as a result" isn't in any
// WordNet index) -- merged into the same two outputs, skipped if WordNet
// already covers that exact phrase.
//
// phrases.json -- { [firstWord]: { words: string[]; pos: 'v' | 'r' }[] } --
// for each first word, the full lemma-word sequences of phrases starting
// with it (longest first) and which class they are, so src/nlp.ts's
// mergePhrasalVerbs() can require the head token's actual POS to be
// verb-like for a 'v' entry or adposition/adverb-like for an 'r' one
// before merging -- without that, a NOUN "look" in "a good look up close"
// would wrongly merge with the verb phrase "look up" (found by testing);
// preposition-headed connectors need the looser check since e.g. "as" gets
// tagged ADP in "as a matter of fact" but ADV in "as usual" -- both valid,
// neither is the noun/verb-style ambiguity the strict check guards against.
// Capped at MAX_PHRASE_WORDS -- beyond that WordNet's entries are long-tail
// fixed idioms ("give_the_once_over") that a length cap trades away for a
// much smaller, simpler match structure.
//
// Not run at extension build/runtime -- a one-time (or re-run-when-
// wordnet-db-updates) data prep step. Takes a couple seconds.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import { CONNECTORS } from './connectors.mjs';

// Same tokenizer/lemmatizer as src/nlp.ts, so definition words here and the
// sentence words compared against them at lookup time normalize the same way.
const nlp = winkNLP(model, ['sbd', 'pos']);
const its = nlp.its;
function lemmatize(text) {
  const doc = nlp.readDoc(text);
  const out = [];
  doc.tokens().each((t) => {
    if (t.out(its.type) === 'word') out.push(t.out(its.lemma).toLowerCase());
  });
  return out;
}

const STOPWORDS = new Set(
  ('a an the of to in on at for from with by as is are was were be been being ' +
   'this that these those it its it\'s or and but not no do does did have has had ' +
   'will would can could should shall may might must if then than so such very ' +
   'about into onto over under between among through during before after above below ' +
   'up down out off again further once here there when where why how all any both ' +
   'each few more most other some such only own same too also just one someone something ' +
   'used usually especially typically').split(' '),
);

const POS_NAMES = { n: 'noun', v: 'verb', a: 'adjective', s: 'adjective', r: 'adverb' };
const dictDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'wordnet-db', 'dict');

function readLines(file) {
  return readFileSync(path.join(dictDir, file), 'utf-8').split('\n').filter(Boolean);
}

// data.<pos> lines are keyed by their own leading field (a synset's byte
// offset in that same file) -- build offset -> {pos, text, defWords} so
// index.<pos> lines can look glosses up without re-parsing the pointer list.
function loadSynsets(posChar, dataFile) {
  const pos = POS_NAMES[posChar];
  const bySynset = new Map();
  for (const line of readLines(dataFile)) {
    const bar = line.indexOf(' | ');
    if (bar < 0) continue;
    const offset = line.slice(0, line.indexOf(' '));
    const gloss = line.slice(bar + 3);
    const defOnly = gloss.split('; ').filter((p) => !p.startsWith('"')).join('; ').trim();
    const defWords = lemmatize(defOnly.replace(/[^a-zA-Z0-9 ']/g, ' '))
      .filter((w) => w.length > 1 && !STOPWORDS.has(w))
      .slice(0, 8);
    bySynset.set(offset, { pos, text: defOnly.slice(0, 200), defWords: defWords.join(' ') });
  }
  return bySynset;
}

// WordNet stores some multi-word entries with an inflected non-head word
// ("call_the_shots", "in_other_words", "be_born") -- the phrase's own fixed
// citation form, not necessarily the lemma. But mergePhrasalVerbs() (nlp.ts)
// compares against a *sentence* token's lemma ("shots" in real text
// lemmatizes to "shot"), so an un-lemmatized phrase word could never match
// at runtime -- found by testing "in terms of" and it silently never
// merging. Re-lemmatize each phrase word the same way (skip if that doesn't
// cleanly produce exactly one word -- e.g. "one's" lemmatizes to two tokens
// "one" + "'s", and nlp.ts's tokenizer drops possessive "'s" as a
// contraction piece anyway, so those idioms can't merge either way; keep
// the original word rather than corrupting the phrase).
function lemmatizeWord(word) {
  const words = lemmatize(word);
  return words.length === 1 ? words[0] : word;
}

const MAX_PHRASE_WORDS = 4;
// Multi-word entries are only useful to us as phrases mergePhrasalVerbs()
// can actually anchor on: verb phrases (posChar 'v') and adverbial/
// connector phrases (posChar 'r'). Noun/adj multi-word entries ("happy
// hour") are dead weight -- tokenize() has no mechanism that would ever
// merge starting from an arbitrary noun phrase.
const PHRASE_POS = new Set(['v', 'r']);

const index = new Map(); // word (or "word word2 ...") -> [[pos, rank, text, defWords], ...]
const phrases = new Map(); // first word -> { words: string[]; pos: 'v'|'r' }[] (longest first)

function addPhrase(words, posChar) {
  let list = phrases.get(words[0]);
  if (!list) phrases.set(words[0], (list = []));
  list.push({ words, pos: posChar });
}

for (const [posChar, dataFile, indexFile] of [
  ['n', 'data.noun', 'index.noun'],
  ['v', 'data.verb', 'index.verb'],
  ['a', 'data.adj', 'index.adj'],
  ['r', 'data.adv', 'index.adv'],
]) {
  const synsets = loadSynsets(posChar, dataFile);
  for (const line of readLines(indexFile)) {
    const parts = line.split(' ');
    let i = 0;
    const lemma = parts[i++];
    i++; // pos char, already known from which index file this is
    const synsetCnt = parseInt(parts[i++], 10);
    const pCnt = parseInt(parts[i++], 10);
    i += pCnt; // pointer symbols, not needed
    i++; // sense_cnt (== synsetCnt)
    i++; // tagsense_cnt, not needed
    const offsets = parts.slice(i, i + synsetCnt);

    if (lemma.includes('-')) continue; // rare, and rarely tokenized as one lemma anyway
    let words = lemma.toLowerCase().split('_');
    if (words.some((w) => !/^[a-z][a-z']*$/.test(w))) continue;
    if (words.length > 1 && (!PHRASE_POS.has(posChar) || words.length > MAX_PHRASE_WORDS)) continue;
    if (words.length > 1) words = words.map(lemmatizeWord);

    const word = words.join(' ');
    let arr = index.get(word);
    if (!arr) index.set(word, (arr = []));
    offsets.forEach((offset, rank) => {
      const syn = synsets.get(offset);
      if (syn) arr.push([syn.pos, rank, syn.text, syn.defWords]);
    });

    if (words.length > 1) addPhrase(words, posChar);
  }
}

// Top up with hand-curated connectors WordNet doesn't have (see
// connectors.mjs) -- skip any WordNet already covers under that exact
// phrase, so we don't shadow real WordNet senses with a thinner entry.
// (Korean glosses for these come from the same list, added separately by
// extract-krdict.mjs -- this script only owns the English side.)
for (const { phrase, en } of CONNECTORS) {
  const words = phrase.split(' ').map(lemmatizeWord);
  const lemmaPhrase = words.join(' ');
  if (index.has(lemmaPhrase)) continue;
  index.set(lemmaPhrase, [['adverb', 0, en, '']]);
  addPhrase(words, 'r');
}

// Longest first, so src/nlp.ts's matcher tries "give the axe" before "give
// up" (falling back correctly when the longer phrase doesn't fully match).
for (const list of phrases.values()) list.sort((a, b) => b.words.length - a.words.length);

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static');

const wordnetJson = JSON.stringify(Object.fromEntries(index));
writeFileSync(path.join(outDir, 'wordnet.json'), wordnetJson);
console.log(`Wrote static/wordnet.json: ${index.size} distinct keys, ${Buffer.byteLength(wordnetJson)} bytes`);

const phrasesJson = JSON.stringify(Object.fromEntries(phrases));
writeFileSync(path.join(outDir, 'phrases.json'), phrasesJson);
console.log(`Wrote static/phrases.json: ${phrases.size} first-word keys, ${Buffer.byteLength(phrasesJson)} bytes`);
