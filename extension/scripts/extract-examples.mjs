// Regenerates ../web/static/examples.json -- short example sentences per word,
// for the review site's leech rescue (../web/src/leech.ts): a card you keep
// failing can be switched to an easier sentence, and WordNet's own usage
// examples are short, plain and written to show exactly one word in use.
//
// No download needed: reads the bundled wordnet-db data files (the same
// WordNet 3.1 that scripts/extract-wordnet.mjs uses; that script strips these
// examples from wordnet.json, which only keeps definitions). Each synset's
// gloss ends with `; "example"; "example"`. An example is kept for a synset
// word only if that word really occurs in it -- checked on lemmas with the same
// wink-nlp model the extension tokenizes with, so "He abandoned the thought"
// counts for "abandon", and multi-word entries ("give up") must appear as a
// contiguous run. Website-only data, so it's written straight into ../web/static
// rather than the extension's static/ (the extension never loads it).
//
// Usage: node scripts/extract-examples.mjs
// Output: { [lemma]: [sentence, targetStart, surface][] } -- up to 3 per lemma,
// at least 4 words and at most 100 characters each, whole sentences (starting
// with a capital) before fragments ("reluctant to help"), then shortest first.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';

const require = createRequire(import.meta.url);
const dict = require.resolve('wordnet-db').replace(/[\\/][^\\/]+$/, '') + '/dict';
const nlp = winkNLP(model, ['sbd', 'pos']);
const its = nlp.its;

const PER_WORD = 3;
const MAX_CHARS = 100;

/** Word tokens of a sentence with their lemma and character span. */
function tokens(text) {
  const out = [];
  let cursor = 0;
  nlp.readDoc(text).tokens().each((t) => {
    const surface = t.out();
    const at = text.indexOf(surface, cursor);
    if (at < 0) return;
    cursor = at + surface.length;
    if (t.out(its.type) === 'word') out.push({ start: at, end: cursor, lemma: t.out(its.lemma).toLowerCase() });
  });
  return out;
}

const examples = new Map(); // lemma -> Map(sentence -> [sentence, start, surface])

for (const file of ['data.noun', 'data.verb', 'data.adj', 'data.adv']) {
  for (const line of readFileSync(`${dict}/${file}`, 'utf8').split('\n')) {
    if (!line || line.startsWith('  ')) continue; // license header
    const bar = line.indexOf(' | ');
    if (bar < 0) continue;
    const fields = line.slice(0, bar).split(' ');
    const count = parseInt(fields[3], 16);
    const words = [];
    for (let i = 0; i < count; i++) words.push(fields[4 + i * 2].replace(/\(.*\)$/, '').toLowerCase());
    const sentences = [...line.slice(bar + 3).matchAll(/"([^"]+)"/g)].map((m) => m[1].trim())
      .filter((s) => s.length <= MAX_CHARS && s.split(/\s+/).length >= 4 && /^[\x20-\x7e]+$/.test(s));
    for (const sentence of sentences) {
      const toks = tokens(sentence);
      for (const word of words) {
        if (!/^[a-z][a-z'_-]*$/.test(word)) continue;
        const parts = tokens(word.replace(/_/g, ' ')).map((t) => t.lemma);
        if (!parts.length) continue;
        const lemma = parts.join(' ');
        for (let i = 0; i + parts.length <= toks.length; i++) {
          if (!parts.every((p, k) => toks[i + k].lemma === p)) continue;
          const start = toks[i].start;
          const surface = sentence.slice(start, toks[i + parts.length - 1].end);
          let byText = examples.get(lemma);
          if (!byText) examples.set(lemma, (byText = new Map()));
          if (!byText.has(sentence)) byText.set(sentence, [sentence, start, surface]);
          break;
        }
      }
    }
  }
}

const out = {};
for (const [lemma, byText] of examples) {
  const whole = (s) => (/^[A-Z]/.test(s) ? 0 : 1);
  out[lemma] = [...byText.values()].sort((a, b) => whole(a[0]) - whole(b[0]) || a[0].length - b[0].length).slice(0, PER_WORD);
}
const json = JSON.stringify(out);
writeFileSync(new URL('../../web/static/examples.json', import.meta.url), json);
console.log(`web/static/examples.json: ${Object.keys(out).length} lemmas, ${(json.length / 1e6).toFixed(1)} MB`);
