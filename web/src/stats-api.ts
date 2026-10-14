import { apiFetch } from './supabase';

// Vocabulary and activity data for the home page's stats and the paste-text
// reader. All of it lives in tables from the second block of ../schema.sql;
// every function resolves null (not throws) when that block hasn't been run
// yet, so the pages just leave the section out.

export type WordStatus = 'unknown' | 'seen' | 'learning' | 'known' | 'ignored';
export type WordMap = Record<string, Exclude<WordStatus, 'unknown'>>;

export interface VocabDay {
  day: string; // YYYY-MM-DD
  known: number;
  seen: number;
  learning: number;
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await apiFetch(path);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** One row per day, oldest first. */
export async function fetchVocabDaily(days = 120): Promise<VocabDay[] | null> {
  const rows = await getJson<VocabDay[]>(`/rest/v1/vocab_daily?select=day,known,seen,learning&order=day.desc&limit=${days}`);
  return rows ? rows.reverse() : null;
}

/** When each card rating happened, newest first (capped). */
export async function fetchReviewTimes(sinceIso: string): Promise<string[] | null> {
  const rows = await getJson<{ reviewed_at: string }[]>(
    `/rest/v1/review_log?select=reviewed_at&reviewed_at=gte.${encodeURIComponent(sinceIso)}&order=reviewed_at.desc&limit=5000`,
  );
  return rows ? rows.map((r) => r.reviewed_at) : null;
}

/** When each card was saved since a date (saving counts as a day's activity, as on the home page). */
export async function fetchCardTimes(sinceIso: string): Promise<string[] | null> {
  const rows = await getJson<{ created_at: string }[]>(
    `/rest/v1/cards?select=created_at&created_at=gte.${encodeURIComponent(sinceIso)}&limit=5000`,
  );
  return rows ? rows.map((r) => r.created_at) : null;
}

/**
 * The reader's words: the extension's last uploaded map, with any marks made
 * here since then (still waiting in vocab_inbox) laid over it. Null if the
 * tables don't exist; an empty map if the extension has never synced.
 */
export async function fetchVocab(): Promise<WordMap | null> {
  const base = await getJson<{ words: WordMap }[]>('/rest/v1/vocab?select=words&limit=1');
  if (!base) return null;
  const words: WordMap = { ...(base[0]?.words ?? {}) };
  const inbox = await getJson<{ lemma: string; status: WordStatus }[]>('/rest/v1/vocab_inbox?select=lemma,status&order=id.asc&limit=5000');
  for (const m of inbox ?? []) {
    if (m.status === 'unknown') delete words[m.lemma];
    else words[m.lemma] = m.status;
  }
  return words;
}

/** Queues a word mark for the extension to apply on its next 모두 동기화. */
export async function markWord(lemma: string, status: WordStatus): Promise<void> {
  const res = await apiFetch('/rest/v1/vocab_inbox', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ lemma, status }),
  });
  if (!res.ok) throw new Error(`mark-${res.status}`);
}

/** Fire-and-forget: a failed log write must never get in the way of a review. */
export function logReview(cardId: string, rating: number): void {
  apiFetch('/rest/v1/review_log', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ card_id: cardId, rating }),
  }).catch(() => {});
}
