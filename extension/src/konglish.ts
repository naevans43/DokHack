import { assetUrl } from './asset-url';

// Konglish / false-friend flags: English words whose Korean loanword means
// something else ("notebook" = 노트북 = a laptop in Korean, a paper notebook
// in English), plus a few Konglish coinages ("handphone") that turn up in
// English written by Korean speakers. static/konglish.json is a small,
// hand-curated list (unlike krdict/wordnet.json, not generated) mapping a
// lowercase word to a short Korean note. Looked up by surface form first, then
// lemma: "Fighting!" lemmatizes to "fight", which must not flag every "fight".
// Hyphenated items ("one-shot") are left out -- the tokenizer splits them into
// separate words, so they could never match. Fetched lazily like the other
// dictionaries; used by the background worker's lookup and the website reader.

/** Prefix on a card definition that carries a false-friend note (so it survives edits and syncs as plain text). */
export const FALSE_FRIEND_PREFIX = '콩글리시 주의: ';

export function isFalseFriendNote(text: string): boolean {
  return text.startsWith(FALSE_FRIEND_PREFIX);
}

/** CSS class for showing a saved card definition: a false-friend note, a Korean gloss, or an English definition. */
export function definitionClass(d: { text: string; lang: 'ko' | 'en' }): 'false-friend' | 'gloss' | 'def' {
  return isFalseFriendNote(d.text) ? 'false-friend' : d.lang === 'ko' ? 'gloss' : 'def';
}

let listPromise: Promise<Record<string, string>> | null = null;

export async function lookupFalseFriend(surface: string | undefined, lemma: string): Promise<string | null> {
  if (!listPromise) {
    listPromise = fetch(assetUrl('konglish.json')).then((r) => r.json()).catch(() => {
      listPromise = null; // try again next time rather than caching a failure
      return {};
    });
  }
  const list = await listPromise;
  const note = (w: string | undefined): string | null => {
    const k = w?.toLowerCase();
    return k && Object.prototype.hasOwnProperty.call(list, k) ? list[k] : null;
  };
  return note(surface) ?? note(lemma);
}
