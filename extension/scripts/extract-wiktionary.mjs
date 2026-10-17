// Regenerates static/wiktionary.json -- English -> Korean translations from
// Wiktionary, the main source for the word card's Korean meanings (src/krdict.ts
// merges it ahead of KRDICT).
//
// Why: KRDICT is a Korean -> English learners' dictionary, and static/krdict.json
// reads it backwards, so an English word only reaches the Korean words whose
// own entries happen to list it. Seen by the user: "horror" only reached 경악
// (공포's entry lists "fear", not "horror"), "scary" reached 호랑이. Wiktionary's
// English entries carry translation tables written per English sense, which is
// the direction we need.
//
// Sources (Wiktextract data from https://kaikki.org, CC BY-SA 4.0 / GFDL, like
// Wiktionary itself; neither file is committed):
//   1. English Wiktionary: raw-wiktextract-data.jsonl.gz (all languages, ~2.8 GB
//      compressed; read as a gzip stream, never unpacked). From each English
//      entry, its Korean translations and the English sense each belongs to.
//   2. Korean Wiktionary: ko-extract.jsonl.gz (~26 MB). Its English headwords
//      ("영어") are glossed directly in Korean ("공포, 전율, 소름끼침."), split on
//      commas/semicolons. Fills words the English edition has no Korean for.
//
// Usage: node scripts/extract-wiktionary.mjs <raw-wiktextract-data.jsonl.gz> <ko-extract.jsonl.gz>
//
// Output: static/wiktionary.json -- { [englishLemma]: Row[] }, the same row
// shape as krdict.json so krdict.ts ranks both the same way:
//   [ko, posChar, level, defWords, first]
//   - posChar: 명/동/형/부 (or "" when unknown)
//   - level: the Korean word's KRDICT level when KRDICT knows it, else 2
//   - defWords: up to 8 lemmatized, stopword-filtered words of the English
//     sense description ("intense distressing fear or repugnance"), for the
//     Lesk-style sentence overlap; "" for Korean-edition rows
//   - first: 1 for the first Korean word listed for that sense

import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';

const [rawPath, koPath] = process.argv.slice(2);
if (!rawPath || !koPath) {
  console.error('usage: node scripts/extract-wiktionary.mjs <raw-wiktextract-data.jsonl.gz> <ko-extract.jsonl.gz>');
  process.exit(1);
}

const nlp = winkNLP(model, ['sbd', 'pos']);
const its = nlp.its;
const STOPWORDS = new Set(
  ('a an the of to in on at for from with by as is are was were be been being this that these those it its ' +
   'or and but not no do does did have has had will would can could should may might must if then than so such ' +
   'very about into onto over under up down out off all any both each more most other some only own same too ' +
   'also just one someone something someone\'s especially usually often etc').split(' '),
);
const POS = { noun: '명', verb: '동', adj: '형', adv: '부', name: '명', phrase: '', prep: '', 동사: '동', 명사: '명', 형용사: '형', 부사: '부' };
const HANGUL = /[가-힣]/;
const ENGLISH_WORD = /^[a-z][a-z' -]*$/;
const MAX_PER_WORD = 24;

// Korean word -> lowest KRDICT level, so Wiktionary rows rank like KRDICT ones.
const krdict = JSON.parse(readFileSync(new URL('../static/krdict.json', import.meta.url), 'utf8'));
const levelOf = new Map();
for (const rows of Object.values(krdict)) for (const [ko, , level] of rows) levelOf.set(ko, Math.min(level, levelOf.get(ko) ?? 3));

function lemmatize(text) {
  const out = [];
  nlp.readDoc(text).tokens().each((t) => { if (t.out(its.type) === 'word') out.push(t.out(its.lemma).toLowerCase()); });
  return out;
}
const lemmaCache = new Map();
/** The lemma tokenize() would key a headword under ("ran" stays a headword of its own in Wiktionary; phrases keep their words). */
function headLemma(word) {
  let l = lemmaCache.get(word);
  if (l === undefined) {
    const parts = lemmatize(word);
    l = parts.length === word.split(/\s+/).length ? parts.join(' ') : word;
    lemmaCache.set(word, l);
  }
  return l;
}
const defCache = new Map();
function defWords(sense) {
  if (!sense) return '';
  let d = defCache.get(sense);
  if (d === undefined) {
    d = lemmatize(sense.replace(/[^a-zA-Z' ]/g, ' ')).filter((w) => w.length > 1 && !STOPWORDS.has(w)).slice(0, 8).join(' ');
    defCache.set(sense, d);
  }
  return d;
}
/** Korean surface form cleaned of romanization/notes: "공포 (gongpo)" -> "공포". */
function cleanKo(s) {
  return String(s ?? '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/[.。]$/, '').trim();
}

const index = new Map(); // lemma -> Map(ko -> row), first row per Korean word wins (keeps its sense)
function add(lemma, row) {
  if (!ENGLISH_WORD.test(lemma)) return;
  let rows = index.get(lemma);
  if (!rows) index.set(lemma, (rows = new Map()));
  const prev = rows.get(row[0]);
  if (!prev || (row[3] && !prev[3])) rows.set(row[0], row); // prefer a row that has a sense description
}

async function* lines(path) {
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

// 1. English Wiktionary translation tables.
let seen = 0, kept = 0;
for await (const line of lines(rawPath)) {
  if (++seen % 1_000_000 === 0) console.error(`  ${seen / 1e6}M lines, ${kept} English entries with Korean`);
  if (!line.includes('"lang_code": "ko"') || !line.includes('"lang_code": "en"')) continue;
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  if (e.lang_code !== 'en' || !e.word) continue;
  const translations = [...(e.translations ?? []), ...(e.senses ?? []).flatMap((s) => s.translations ?? [])]
    .filter((t) => t.lang_code === 'ko' && t.word && HANGUL.test(t.word));
  if (!translations.length) continue;
  kept++;
  const lemma = headLemma(e.word.toLowerCase());
  const posChar = POS[e.pos] ?? '';
  const firstOfSense = new Set();
  for (const t of translations) {
    const ko = cleanKo(t.word);
    if (!ko || !HANGUL.test(ko) || ko.length > 20) continue;
    const sense = t.sense ?? '';
    const first = firstOfSense.has(sense) ? 0 : 1;
    firstOfSense.add(sense);
    add(lemma, [ko, posChar, levelOf.get(ko) ?? 2, defWords(sense), first]);
  }
}
console.error(`English Wiktionary: ${kept} English entries with Korean translations`);

// 2. Korean Wiktionary: English headwords glossed in Korean (fills gaps only).
let koAdded = 0;
for await (const line of lines(koPath)) {
  if (!line.includes('"lang_code": "en"')) continue;
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  if (e.lang_code !== 'en' || !e.word) continue;
  const lemma = headLemma(e.word.toLowerCase());
  const posChar = POS[e.pos] ?? '';
  for (const s of e.senses ?? []) {
    for (const g of s.glosses ?? []) {
      // "(자) 달리다. 뛰다. 질주하다." / "공포, 전율, 소름끼침." -> separate words
      const parts = g.replace(/\(.*?\)|㉶|㉥/g, ' ').split(/[,;.·]/).map(cleanKo).filter((p) => p && HANGUL.test(p) && p.length <= 12 && !/\s.*\s/.test(p));
      parts.forEach((ko, i) => {
        const before = index.get(lemma)?.size ?? 0;
        add(lemma, [ko, posChar, levelOf.get(ko) ?? 2, '', i === 0 ? 1 : 0]);
        if ((index.get(lemma)?.size ?? 0) > before) koAdded++;
      });
    }
  }
}
console.error(`Korean Wiktionary: ${koAdded} rows added`);

const out = {};
for (const [lemma, rows] of [...index].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out[lemma] = [...rows.values()].slice(0, MAX_PER_WORD);
const json = JSON.stringify(out);
writeFileSync(new URL('../static/wiktionary.json', import.meta.url), json);
console.log(`static/wiktionary.json: ${Object.keys(out).length} English words, ${(json.length / 1e6).toFixed(1)} MB`);
