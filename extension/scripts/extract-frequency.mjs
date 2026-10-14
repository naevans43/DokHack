// Regenerates static/frequency.json -- a lemma frequency ranking for the
// common/rare badge on highlighted words (src/frequency.ts).
//
// Two sources, best first:
//
//   node scripts/extract-frequency.mjs <path to en_50k.txt>
//     A word-frequency list from subtitles (hermitdave/FrequencyWords,
//     content/2018/en/en_50k.txt: OpenSubtitles 2018, "word count" per line,
//     CC BY-SA 4.0). Subtitles are close to what readers of this extension
//     watch and read. Each word is lemmatized with the same wink-nlp model the
//     extension tokenizes with (in isolation, so "saw" counts toward "see"),
//     counts are summed per lemma, and lemmas are ranked by total. A word
//     missing from the list is genuinely uncommon, so the badge may call it
//     rare.
//
//   node scripts/extract-frequency.mjs
//     No download needed: WordNet's SemCor sense-tag counts (index.sense's
//     tag_cnt, from the bundled wordnet-db package), summed per lemma, with
//     src/wordlist.ts's hand-made frequency bands (function words SemCor
//     doesn't tag) placed on top. SemCor is ~1960s text, so modern words
//     ("internet", "email", "video") are missing or ranked far too low --
//     this source only ever supports the "common" badge, never "rare".
//
// Output: static/frequency.json --
//   { source, commonMax, rareMin, words: string[] }  (words[0] is rank 1)
//   A word ranked <= commonMax gets the "common" badge; one ranked > rareMin,
//   or missing, gets "rare" -- rareMin is null when the source can't tell.
//   Thresholds live with the data because they depend on the source.
// Only single-word lemmas: merged phrases ("give up") get no badge.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';

const require = createRequire(import.meta.url);
const MAX_WORDS = 30_000;
const WORD = /^[a-z][a-z']*$/;

const nlp = winkNLP(model, ['sbd', 'pos']);
const its = nlp.its;

/** The lemma tokenize() would key this word under at runtime (nlp.ts's normalizeLemma), or null. */
function lemmaOf(word) {
  const toks = [];
  nlp.readDoc(word).tokens().each((t) => { if (t.out(its.type) === 'word') toks.push(t.out(its.lemma)); });
  if (toks.length !== 1) return null; // "don't" -> do + n't: a contraction, not a vocabulary word
  const lemma = toks[0].toLowerCase().replace(/’/g, "'").normalize('NFC');
  return WORD.test(lemma) ? lemma : null;
}

function fromSubtitleList(path) {
  const totals = new Map();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const [raw, countText] = line.trim().split(/\s+/);
    const count = Number(countText);
    if (!raw || !Number.isFinite(count) || !WORD.test(raw.toLowerCase())) continue;
    const lemma = lemmaOf(raw.toLowerCase());
    if (lemma) totals.set(lemma, (totals.get(lemma) ?? 0) + count);
  }
  const words = [...totals].sort((a, b) => b[1] - a[1]).map(([w]) => w);
  return { source: `OpenSubtitles 2018 frequency list (hermitdave/FrequencyWords, CC BY-SA 4.0), ${totals.size} lemmas`, commonMax: 3000, rareMin: 20000, words };
}

function fromSemCor() {
  const dict = require.resolve('wordnet-db').replace(/[\\/][^\\/]+$/, '');
  const totals = new Map();
  for (const line of readFileSync(`${dict}/dict/index.sense`, 'utf8').split('\n')) {
    const [key, , , tag] = line.split(' ');
    if (!key || !Number(tag)) continue;
    const lemma = key.slice(0, key.indexOf('%')).toLowerCase();
    if (WORD.test(lemma)) totals.set(lemma, (totals.get(lemma) ?? 0) + Number(tag));
  }
  // wordlist.ts is TypeScript; its bands are plain string literals, so read them directly.
  const bandText = readFileSync(new URL('../src/wordlist.ts', import.meta.url), 'utf8');
  const banded = [...bandText.matchAll(/"([a-z']+)"/g)].map((m) => m[1]);
  const top = [...new Set(banded)];
  const rest = [...totals].sort((a, b) => b[1] - a[1]).map(([w]) => w).filter((w) => !top.includes(w));
  // A small, old corpus: only its top ~2000 are trustworthy as "common" (rank
  // ~3000 already holds words like "glimpse"), and it can't call anything rare.
  return { source: `WordNet 3.1 SemCor tag counts + wordlist.ts bands, ${totals.size} lemmas`, commonMax: 2000, rareMin: null, words: [...top, ...rest] };
}

const listPath = process.argv[2];
const out = listPath ? fromSubtitleList(listPath) : fromSemCor();
out.words = out.words.slice(0, MAX_WORDS);
writeFileSync(new URL('../static/frequency.json', import.meta.url), JSON.stringify(out));
console.log(`static/frequency.json: ${out.words.length} words from ${out.source}`);
