import { apiFetch } from './supabase';

const MEDIA_BUCKET = 'card-media';
const mediaUrls = new Map<string, Promise<string | null>>();

/**
 * An object URL for a card's audio/frame, or null if it can't be loaded. The
 * bucket is private, so this fetches with the reader's login and hands the
 * bytes to an <img>/<audio> as a blob: URL. Cached per path for the page's life
 * (a re-recorded clip overwrites the same path, but only a reload can notice).
 */
export function mediaUrl(path: string): Promise<string | null> {
  let hit = mediaUrls.get(path);
  if (!hit) {
    hit = apiFetch(`/storage/v1/object/authenticated/${MEDIA_BUCKET}/${path}`)
      .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null))
      .catch(() => null);
    mediaUrls.set(path, hit);
  }
  return hit;
}

// The `cards` row shape (see ../schema.sql), shared by the review queue,
// the home page's stats, and the cards page's browse/preview/edit.

export interface CardDefinition {
  text: string;
  lang: 'ko' | 'en';
}

export interface CardRow {
  id: string;
  lemma: string;
  surface: string;
  sentence: string;
  target_start: number;
  definitions: CardDefinition[];
  url: string;
  title: string;
  created_at: string;
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: string | null;
  // Supabase Storage paths (bucket card-media) of a YouTube card's clip/frame; null if none.
  audio_path: string | null;
  frame_path: string | null;
}

// The same bar the extension uses to auto-promote a word to 알아요 (see
// ../../extension/src/background.ts's LEARNED_STATE/LEARNED_MIN_REPS): ts-fsrs
// State.Review (2), at least 3 reviews, never once lapsed. Kept in sync by
// hand -- it's what "익숙해진 카드" means here.
const STATE_REVIEW = 2;
const MASTERED_MIN_REPS = 3;
const STATE_NEW = 0;

export function isMastered(c: CardRow): boolean {
  return c.state === STATE_REVIEW && c.reps >= MASTERED_MIN_REPS && c.lapses === 0;
}

export function isNew(c: CardRow): boolean {
  return c.state === STATE_NEW;
}

export function isDue(c: CardRow, now = Date.now()): boolean {
  return new Date(c.due).getTime() <= now;
}

/** Every card for the signed-in user, newest first. Personal-scale data, so one fetch is fine. */
export async function fetchAllCards(): Promise<CardRow[]> {
  const res = await apiFetch('/rest/v1/cards?select=*&order=created_at.desc&limit=5000');
  if (!res.ok) throw new Error(`cards-${res.status}`);
  return (await res.json()) as CardRow[];
}

/** Just the number of due cards, without pulling any rows (reads PostgREST's Content-Range total). */
export async function fetchDueCount(): Promise<number> {
  const res = await apiFetch(
    `/rest/v1/cards?select=id&due=lte.${encodeURIComponent(new Date().toISOString())}&limit=1`,
    { headers: { Prefer: 'count=exact' } },
  );
  if (!res.ok) throw new Error(`due-${res.status}`);
  const total = res.headers.get('content-range')?.split('/')[1];
  return total && total !== '*' ? Number(total) : 0;
}

export async function patchCard(
  id: string,
  patch: Partial<Pick<CardRow, 'sentence' | 'target_start' | 'definitions'>>,
): Promise<void> {
  const res = await apiFetch(`/rest/v1/cards?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patch-${res.status}`);
}

export async function deleteCardRow(card: Pick<CardRow, 'id' | 'audio_path' | 'frame_path'>): Promise<void> {
  const res = await apiFetch(`/rest/v1/cards?id=eq.${card.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (!res.ok) throw new Error(`delete-${res.status}`);
  // The row is gone either way; removing its files is best-effort cleanup.
  const prefixes = [card.audio_path, card.frame_path].filter((p): p is string => !!p);
  if (prefixes.length) {
    apiFetch(`/storage/v1/object/${MEDIA_BUCKET}`, { method: 'DELETE', body: JSON.stringify({ prefixes }) }).catch(() => {});
  }
}

export function splitSentence(c: Pick<CardRow, 'sentence' | 'target_start' | 'surface'>) {
  const s = c.sentence;
  const i = c.target_start;
  const n = c.surface.length;
  return { before: s.slice(0, i), target: s.slice(i, i + n), after: s.slice(i + n) };
}

/** "오늘", "3일 후", "2일 전" -- relative due date for a card row. */
export function dueLabel(c: CardRow, now = Date.now()): string {
  if (isNew(c)) return '새 카드';
  const days = Math.round((new Date(c.due).getTime() - now) / 86_400_000);
  if (days <= 0) return '오늘 복습';
  return `${days}일 후`;
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}
