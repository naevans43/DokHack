import type { AccountSession, EncounterMap, MinedCard, RewatchVideo, Settings, WordStatus } from './types';

// Everything lives in chrome.storage.local (with the unlimitedStorage
// permission). Content scripts only READ from here; all writes go through
// the background worker so tabs don't clobber each other.

export type WordMap = Record<string, Exclude<WordStatus, 'unknown'>>;

export const DEFAULT_SETTINGS: Settings = {
  disabledHosts: [],
  autoScan: false,
  autoSeen: true,
  autoPauseLines: false,
  freqBadges: true,
};

export async function getWords(): Promise<WordMap> {
  const { words } = await chrome.storage.local.get('words');
  return (words as WordMap) ?? {};
}

export async function getCards(): Promise<MinedCard[]> {
  const { cards } = await chrome.storage.local.get('cards');
  return (cards as MinedCard[]) ?? [];
}

export async function getEncounters(): Promise<EncounterMap> {
  const { encounters } = await chrome.storage.local.get('encounters');
  return (encounters as EncounterMap) ?? {};
}

export async function getRewatch(): Promise<RewatchVideo[]> {
  const { rewatch } = await chrome.storage.local.get('rewatch');
  return (rewatch as RewatchVideo[]) ?? [];
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings>) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  await chrome.storage.local.set({ settings: { ...current, ...patch } });
}

export function statusOf(words: WordMap, lemma: string): WordStatus {
  return words[lemma] ?? 'unknown';
}

export async function getAccount(): Promise<AccountSession | null> {
  const { account } = await chrome.storage.local.get('account');
  return (account as AccountSession) ?? null;
}
