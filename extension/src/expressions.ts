import { assetUrl } from './asset-url';

// Slang and collocation flags, from the hand-written static/expressions.json
// (same idea as konglish.json; edit it directly). Two kinds of note:
//
//  - slang ("lock in", "no cap", "low-key"): matched against the clicked
//    word's sentence by its written forms. Literal readings are the risk
//    ("lock in the door", "no cap on spending", "lit a candle"), so an entry
//    can say which words may not follow (`notBefore`), that it only counts at
//    the end of a clause (`atClauseEnd`), or only as a whole utterance
//    (`standalone`: "Bet."); words that are simply ambiguous ("salty",
//    "slay") get a note that explains both meanings instead. Verb-headed
//    entries with `merge` are also folded into phrases.json by
//    scripts/extract-wordnet.mjs, so they're one clickable token
//    ("hit different") with their own part-of-speech guard in nlp.ts.
//  - collocations Korean speakers often get wrong ("make a mistake", not
//    "do a mistake"): shown when one of the pair is clicked and the other is
//    within `gap` words of it in the right order ("made a big mistake").
//
// The clicked word has to be inside the matched span, so clicking "door" in
// "lock in the door" never shows a slang note anyway.

export interface ExpressionNote { kind: 'slang' | 'collocation'; phrase: string; note: string }

interface SlangEntry { forms: string[]; notBefore?: string[]; atClauseEnd?: boolean; standalone?: boolean; merge?: { phrase: string; nb?: string[] }; note: string }
interface CollocationEntry { first: string[]; second: string[]; gap?: number; note: string }
interface Compiled { kind: ExpressionNote['kind']; re: RegExp; words: Set<string> | null; merged: string | null; note: string }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DEFAULT_GAP = 3;

function compile(data: { slang: SlangEntry[]; collocations: CollocationEntry[] }): Compiled[] {
  const out: Compiled[] = [];
  for (const e of data.slang) {
    const forms = e.forms.map((f) => esc(f).replace(/ /g, '\\s+')).join('|');
    let tail = '';
    if (e.notBefore?.length) tail += `(?!\\s+(?:${e.notBefore.map(esc).join('|')})\\b)`;
    if (e.atClauseEnd) tail += `(?=\\s*(?:[.!?,;:)"]|$))`;
    const body = `(?<![\\w'-])(?:${forms})(?![\\w'-])${tail}`;
    out.push({ kind: 'slang', re: new RegExp(e.standalone ? `^\\s*${body}\\s*[.!]*\\s*$` : body, 'gi'), words: null, merged: e.merge?.nb ? e.merge.phrase : null, note: e.note });
  }
  for (const e of data.collocations) {
    const gap = e.gap ?? DEFAULT_GAP;
    const re = new RegExp(`\\b(?:${e.first.map(esc).join('|')})(?:\\s+[a-z'-]+){0,${gap}}?\\s+(?:${e.second.map(esc).join('|')})\\b`, 'gi');
    out.push({ kind: 'collocation', re, words: new Set([...e.first, ...e.second]), merged: null, note: e.note });
  }
  return out;
}

let compiled: Promise<Compiled[]> | null = null;

/**
 * Slang/collocation notes for `surface` (lemma `lemma`) as clicked in `sentence`,
 * at most two. A merged slang phrase with a part-of-speech guard (`nb`) needs the clicked token to *be* that
 * merged phrase: nlp.ts declined the merge in "hit different targets", so the
 * slang reading doesn't apply there even though the words match.
 */
export async function lookupExpressions(surface: string, sentence: string, lemma?: string): Promise<ExpressionNote[]> {
  if (!compiled) {
    compiled = fetch(assetUrl('expressions.json')).then((r) => r.json()).then(compile)
      .catch(() => { compiled = null; return []; });
  }
  const entries = await compiled;
  const text = sentence.replace(/[’‘]/g, "'");
  const word = surface.replace(/[’‘]/g, "'").toLowerCase();
  const notes: ExpressionNote[] = [];
  for (const e of entries) {
    // A collocation note only for one of its two words (not "big" in "made a big mistake").
    if (e.words && !word.split(/\s+/).some((w) => e.words!.has(w))) continue;
    if (e.merged && lemma !== undefined && lemma !== e.merged) continue;
    e.re.lastIndex = 0;
    for (let m = e.re.exec(text); m; m = e.re.exec(text)) {
      const span = m[0].toLowerCase();
      if (new RegExp(`(?<![\\w'])${esc(word).replace(/ /g, '\\s+')}(?![\\w'])`).test(span)) {
        notes.push({ kind: e.kind, phrase: m[0].trim().replace(/\s+/g, ' '), note: e.note });
        break;
      }
    }
    if (notes.length >= 2) break;
  }
  return notes;
}
