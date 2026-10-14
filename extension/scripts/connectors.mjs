// Hand-curated discourse connectors ("as a result," "on the other hand") --
// fixed, non-compositional phrases that function as sentence-level
// transitions. Same idea as roadmap item 4's phrasal verbs (a word-by-word
// reading doesn't give you the actual meaning), but these aren't in
// WordNet at all: it catalogs word senses, not discourse markers, so
// "as_a_result" simply doesn't exist there (checked every index file).
// WordNet DOES have some similar fixed adverbial phrases as multi-word
// entries ("as usual," "in a nutshell," "in any case") -- extract-wordnet.mjs
// pulls those in separately; this list exists only to cover the common
// ones WordNet is missing. Kept deliberately short and hand-checked rather
// than scraped, since a wrong Korean translation here is worse than no
// translation at all.
//
// Consumed by both extract-wordnet.mjs (English text + the phrase-match
// list) and extract-krdict.mjs (Korean gloss) -- one source of truth for
// both sides, like everything else these two scripts produce.
//
// `phrase`: lowercase, space-separated, already in lemma form (none of
// these inflect, so no lemmatization needed at lookup time).
// `en`: a short definition, same style/length as a WordNet gloss.
// `ko`: a single best-guess Korean equivalent -- these aren't ambiguous
// the way a word like "run" is, so there's no ranking to do, just one
// translation per entry.
export const CONNECTORS = [
  { phrase: 'as a result', en: 'as a consequence of something just mentioned', ko: '결과적으로, 그 결과' },
  { phrase: 'on the other hand', en: 'introducing a contrasting fact or point of view', ko: '반면에' },
  { phrase: 'in other words', en: 'expressing the same idea more clearly or simply', ko: '다시 말해서' },
  { phrase: 'for example', en: 'introducing an illustrative instance', ko: '예를 들어' },
  { phrase: 'for instance', en: 'introducing an illustrative instance', ko: '예를 들면' },
  { phrase: 'in addition', en: 'adding a further point', ko: '게다가, 추가로' },
  { phrase: 'in contrast', en: 'highlighting a difference between two things', ko: '대조적으로' },
  { phrase: 'on the contrary', en: 'asserting the opposite of what was just said', ko: '반대로, 그와는 반대로' },
  { phrase: 'as well as', en: 'in addition to', ko: '~뿐만 아니라, ~와 마찬가지로' },
  { phrase: 'in fact', en: 'used to emphasize that something is true', ko: '사실은, 실제로' },
  { phrase: 'of course', en: 'used to state something as obvious or expected', ko: '물론' },
  { phrase: 'after all', en: 'despite what was said or expected', ko: '결국은, 어쨌든' },
  { phrase: 'at least', en: 'not less than; if nothing else', ko: '적어도, 최소한' },
  { phrase: 'at last', en: 'after a long delay', ko: '마침내, 드디어' },
  { phrase: 'in general', en: 'considering things broadly, not in every specific case', ko: '일반적으로' },
  { phrase: 'in particular', en: 'specifically, especially', ko: '특히' },
  { phrase: 'in short', en: 'summarizing briefly', ko: '요컨대, 간단히 말해서' },
  { phrase: 'in summary', en: 'summarizing what was said', ko: '요약하면' },
  { phrase: 'in conclusion', en: 'introducing a final, summarizing point', ko: '결론적으로' },
  { phrase: 'by the way', en: 'introducing a related but secondary point', ko: '그런데, 그건 그렇고' },
  { phrase: 'on top of that', en: 'in addition to what was already mentioned', ko: '게다가, 그뿐만 아니라' },
  { phrase: 'all in all', en: 'considering everything together', ko: '전반적으로, 대체로' },
  { phrase: 'in the end', en: 'eventually, after everything else', ko: '결국' },
  { phrase: 'as long as', en: 'provided that; on condition that', ko: '~하는 한' },
  { phrase: 'as soon as', en: 'immediately when', ko: '~하자마자' },
  { phrase: 'even so', en: 'despite that fact', ko: '그렇다 하더라도, 그런데도' },
  { phrase: 'so far', en: 'up until now', ko: '지금까지' },
  { phrase: 'from now on', en: 'starting from the present moment', ko: '이제부터는' },
  { phrase: 'at first', en: 'in the beginning, before things changed', ko: '처음에는' },
  { phrase: 'at the same time', en: 'simultaneously; also considering the opposite side', ko: '동시에' },
  { phrase: 'due to', en: 'because of', ko: '~때문에' },
  { phrase: 'instead of', en: 'in place of', ko: '~대신에' },
  { phrase: 'in spite of', en: 'despite', ko: '~에도 불구하고' },
  { phrase: 'regardless of', en: 'without being affected by', ko: '~와 관계없이' },
  { phrase: 'in terms of', en: 'considering the specific aspect of', ko: '~측면에서, ~라는 점에서' },
  { phrase: 'with regard to', en: 'concerning; about', ko: '~에 관하여, ~에 대해서' },
];
