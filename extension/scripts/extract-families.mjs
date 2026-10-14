// Regenerates static/families.json -- word families for the word card
// ("decide": decision, decisive, decisively...), from WordNet's
// derivationally-related-form links (pointer symbol "+" in the bundled
// wordnet-db data files; no download needed).
//
// A "+" pointer links one specific word of a synset to one specific word of
// another (its source/target field names the word numbers), so it's a real
// morphological relation, not just a related meaning. A word's family is its
// direct links plus their direct links (two hops: "decision" -> "decide" ->
// "decisive"), never further -- longer chains wander through polysemous words
// and connect unrelated ones. Single-word lemmas only, and every member must
// share a stem-like prefix with the word itself (the shorter word's first 4
// letters, or all of it if shorter): a few WordNet links ("go" ->
// "departure") are semantic in practice and would look random on a card.
// Capped at FAMILY_MAX per word, shortest first.
//
// Usage: node scripts/extract-families.mjs
// Output: { [lemma]: string[] }

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dict = require.resolve('wordnet-db').replace(/[\\/][^\\/]+$/, '') + '/dict';
const FAMILY_MAX = 8;
const WORD = /^[a-z][a-z'-]*$/;

const files = { n: 'data.noun', v: 'data.verb', a: 'data.adj', r: 'data.adv' };
const synsets = new Map(); // `${pos}:${offset}` -> { words, pointers }

for (const [pos, file] of Object.entries(files)) {
  for (const line of readFileSync(`${dict}/${file}`, 'utf8').split('\n')) {
    if (!line || line.startsWith('  ')) continue;
    const head = line.slice(0, line.indexOf(' | ') >= 0 ? line.indexOf(' | ') : line.length).split(' ');
    const offset = head[0];
    const wCnt = parseInt(head[3], 16);
    const words = [];
    for (let i = 0; i < wCnt; i++) words.push(head[4 + i * 2].replace(/\(.*\)$/, '').toLowerCase());
    let i = 4 + wCnt * 2;
    const pCnt = parseInt(head[i++], 10);
    const pointers = [];
    for (let k = 0; k < pCnt; k++, i += 4) {
      const [sym, target, tpos, st] = head.slice(i, i + 4); // adjective satellites ("s") live in data.adj, keyed "a"
      if (sym === '+' && st !== '0000') pointers.push({ target: `${tpos === 's' ? 'a' : tpos}:${target}`, src: parseInt(st.slice(0, 2), 16), dst: parseInt(st.slice(2, 4), 16) });
    }
    synsets.set(`${pos}:${offset}`, { words, pointers });
  }
}

const sameStem = (a, b) => {
  const n = Math.min(a.length, b.length, 4);
  return a.slice(0, n) === b.slice(0, n);
};
const links = new Map(); // direct links
const add = (a, b) => {
  if (a === b || !WORD.test(a) || !WORD.test(b) || !sameStem(a, b)) return;
  let set = links.get(a);
  if (!set) links.set(a, (set = new Set()));
  set.add(b);
};
for (const { words, pointers } of synsets.values()) {
  for (const p of pointers) {
    const other = synsets.get(p.target);
    const from = words[p.src - 1];
    const to = other?.words[p.dst - 1];
    if (!from || !to) continue;
    add(from, to);
    add(to, from);
  }
}

const families = new Map();
for (const [word, direct] of links) {
  const family = new Set(direct);
  for (const d of direct) for (const dd of links.get(d) ?? []) if (dd !== word && sameStem(word, dd)) family.add(dd);
  families.set(word, family);
}

const out = {};
for (const [lemma, set] of [...families].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
  out[lemma] = [...set].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).slice(0, FAMILY_MAX);
}
const json = JSON.stringify(out);
writeFileSync(new URL('../static/families.json', import.meta.url), json);
console.log(`static/families.json: ${Object.keys(out).length} words, ${(json.length / 1e6).toFixed(2)} MB`);
