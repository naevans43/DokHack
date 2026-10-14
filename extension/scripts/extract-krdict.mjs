// Regenerates static/krdict.json from KRDICT's raw bulk data dump.
//
// KRDICT (한국어기초사전, 국립국어원) is a Korean-learners' dictionary: entries
// are Korean headwords with translations into English (and 11 other
// languages). We use it backwards from its intended direction — building an
// English-word -> Korean-gloss reverse index — since each entry is really
// just a Korean/English word pair regardless of which way the site's own
// search points. Live search only supports Korean-headword queries; there is
// no direct API for "look up this English word." This script processes the
// full offline data dump instead, which has no such restriction.
// CC BY-SA (see https://krdict.korean.go.kr/eng/kboardPolicy/copyRightTermsInfo)
// — commercial redistribution is fine with attribution.
//
// Usage:
//   1. https://krdict.korean.go.kr/kor/mainAction -> 사전 전체 내려받기 ->
//      "Json 전체 내려받기" (or GET /dicBatchDownload?seq=217 directly;
//      that seq number may change if they republish the download menu).
//   2. Unzip it somewhere -- you'll get ~11 files named `<n>_<count>_<date>.json`.
//   3. node scripts/extract-krdict.mjs <path to that unzipped folder>
//
// Output: static/krdict.json -- { [englishWord]: [ko, posChar, level, defWords, first][] }
//   - ko: the Korean word/phrase
//   - posChar: first character of the Korean part of speech (동/명/형/부/...)
//   - level: 1 (초급 beginner) / 2 (중급 intermediate) / 3 (고급 advanced)
//   - defWords: up to 8 stopword-filtered, lemmatized words from the English
//     definition, space-joined -- used for Lesk-style overlap scoring
//     against the sentence a word was clicked in (see src/krdict.ts, which
//     lemmatizes that sentence with the same tokenizer so irregular forms
//     like "felt"/"feels"/"feeling" actually line up instead of only
//     matching by exact string)
//   - first: 1 if this English word was the *first*-listed synonym in this
//     sense's own translation field ("run" in "run;dash;sprint"), 0 if it
//     was a later one -- a stronger signal of direct correspondence than a
//     buried alternate translation, used as a ranking bonus in src/krdict.ts
//     (roadmap item 10)
//
// Also tops up a handful of discourse connectors ("as a result", "due to")
// with a hand-picked Korean gloss from connectors.mjs -- KRDICT is a
// Korean-headword dictionary, so it has no reason to carry an idiomatic
// translation for an English-only connector phrase, and testing found it
// doesn't. Same list extract-wordnet.mjs uses for the English side; skips
// any phrase KRDICT already covers, so a real KRDICT entry is never shadowed.
//
// Not run at extension build/runtime -- this is a one-time (or
// re-run-when-KRDICT-updates) data prep step. ~1 GB of input, a few seconds
// to run, produces a ~7.8 MB / ~2 MB gzipped output.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

// A connector phrase's key must match the lemma nlp.ts's mergePhrasalVerbs()
// actually produces at runtime ("in terms of" -> "in term of", since a real
// sentence's "terms" lemmatizes to "term") -- same fix as
// extract-wordnet.mjs's lemmatizeWord(), found the same way (by testing).
function lemmatizeWord(word) {
  const words = lemmatize(word);
  return words.length === 1 ? words[0] : word;
}

const STOPWORDS = new Set(
  ('a an the of to in on at for from with by as is are was were be been being ' +
   'this that these those it its it\'s or and but not no do does did have has had ' +
   'will would can could should shall may might must if then than so such very ' +
   'about into onto over under between among through during before after above below ' +
   'up down out off again further once here there when where why how all any both ' +
   'each few more most other some such only own same too also just').split(' '),
);

const srcDir = process.argv[2];
if (!srcDir) {
  console.error('Usage: node scripts/extract-krdict.mjs <path to unzipped KRDICT dump>');
  process.exit(1);
}

function feats(node) {
  const f = node?.feat;
  if (!f) return {};
  const arr = Array.isArray(f) ? f : [f];
  const out = {};
  for (const { att, val } of arr) out[att] = val;
  return out;
}

const files = readdirSync(srcDir).filter((f) => /^\d+_\d+_\d+\.json$/.test(f));
if (!files.length) {
  console.error(`No "<n>_<count>_<date>.json" files found in ${srcDir}`);
  process.exit(1);
}

const index = new Map(); // english word -> [[ko, posChar, level, defWords], ...]

for (const file of files) {
  const data = JSON.parse(readFileSync(path.join(srcDir, file), 'utf-8'));
  for (const entry of data.LexicalResource.Lexicon.LexicalEntry) {
    const ko = entry.Lemma?.feat?.val;
    if (!ko) continue;
    const ef = feats(entry);
    const posChar = (ef.partOfSpeech ?? '')[0] || '';
    const level = ef.vocabularyLevel === '고급' ? 3 : ef.vocabularyLevel === '중급' ? 2 : 1;
    const senses = Array.isArray(entry.Sense) ? entry.Sense : entry.Sense ? [entry.Sense] : [];
    for (const sense of senses) {
      const equivalents = Array.isArray(sense.Equivalent)
        ? sense.Equivalent
        : sense.Equivalent ? [sense.Equivalent] : [];
      for (const eq of equivalents) {
        const eqf = feats(eq);
        if (eqf.language !== '영어') continue;
        const words = (eqf.lemma ?? '').split(/[;,]/).map((w) => w.trim().toLowerCase()).filter(Boolean);
        const defWords = lemmatize((eqf.definition ?? '').replace(/[^a-zA-Z0-9 ]/g, ' '))
          .filter((w) => w.length > 1 && !STOPWORDS.has(w))
          .slice(0, 8);
        for (const w of words) {
          if (!/^[a-z][a-z '-]*$/.test(w)) continue;
          let arr = index.get(w);
          if (!arr) index.set(w, (arr = []));
          arr.push([ko, posChar, level, defWords.join(' '), words.indexOf(w) === 0 ? 1 : 0]);
        }
      }
    }
  }
}

let connectorsAdded = 0;
for (const { phrase, ko } of CONNECTORS) {
  const lemmaPhrase = phrase.split(' ').map(lemmatizeWord).join(' ');
  if (index.has(lemmaPhrase)) continue;
  index.set(lemmaPhrase, [[ko, '부', 2, '', 1]]); // hand-curated 1:1 mapping -- counts as "first-listed"
  connectorsAdded++;
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'krdict.json');
const json = JSON.stringify(Object.fromEntries(index));
writeFileSync(out, json);
console.log(`Wrote ${out}`);
console.log(`${index.size} distinct English keys (${connectorsAdded} from connectors.mjs), ${Buffer.byteLength(json)} bytes`);
