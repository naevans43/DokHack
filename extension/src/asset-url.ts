// Where nlp.ts / krdict.ts / wordnet.ts fetch their bundled data files from.
// In the extension that's chrome.runtime.getURL; the review website
// (../web, which reuses these modules for its paste-text reader) serves the
// same files from its own root, so a plain relative path works there.
export function assetUrl(path: string): string {
  const api = (globalThis as { chrome?: { runtime?: { getURL?: (p: string) => string } } }).chrome?.runtime;
  return api?.getURL ? api.getURL(path) : `/${path}`;
}
