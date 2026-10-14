import { base64ToBytes, bytesToBase64 } from './binary';
import { deleteBlob, getBlob, putBlob } from './blobstore';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config';
import { lookupKorean } from './krdict';
import { tokenize } from './nlp';
import { getAccount, getCards, getWords, type WordMap } from './storage';
import type { AccountSession, MinedCard, Request } from './types';
import { lookupEnglish } from './wordnet';
import { FREQUENCY_BANDS } from './wordlist';

// ---- serialized writes -------------------------------------------------
// Every storage write funnels through here so two tabs marking words at
// the same time can't overwrite each other's read-modify-write.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

// ---- account + review-website sync --------------------------------------
// Email OTP via Supabase Auth. Signing in here is independent from signing
// in on the review website — both just authenticate the same account, so
// there's nothing to "pair"; a card synced from either side lands in the
// same row set (see /web).

const supabaseHeaders = { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY };

// Same reasoning as LOOKUP_TIMEOUT_MS above: an unbounded fetch here doesn't
// fail, it just hangs — which from the "모두 동기화" button or a mined card
// looks exactly like "stuck syncing," with no error to react to.
const SUPABASE_TIMEOUT_MS = 8000;

function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs = SUPABASE_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function requestLoginCode(email: string): Promise<void> {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/otp`, {
    method: 'POST',
    headers: supabaseHeaders,
    body: JSON.stringify({ email, create_user: true }),
  });
  if (!res.ok) throw new Error(`otp-${res.status}`);
}

async function verifyLoginCode(email: string, code: string): Promise<AccountSession> {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: supabaseHeaders,
    body: JSON.stringify({ type: 'email', email, token: code }),
  });
  if (!res.ok) throw new Error(`verify-${res.status}`);
  const data = await res.json();
  const session: AccountSession = {
    email,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  await serial(async () => chrome.storage.local.set({ account: session }));
  return session;
}

async function logout(): Promise<void> {
  await serial(async () => chrome.storage.local.remove('account'));
}

async function refreshSession(session: AccountSession): Promise<AccountSession> {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: supabaseHeaders,
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  if (!res.ok) {
    // 400/401 means the refresh token itself is dead — expired, revoked, or
    // already rotated by a concurrent refresh from another tab. Retrying
    // later with the same stored token will just fail the same way forever,
    // silently, while the UI keeps claiming the account is linked. Clearing
    // it here makes that honest: the reader sees "signed out" and can
    // relink, instead of sync quietly never working again.
    if (res.status === 400 || res.status === 401) await logout();
    throw new Error(`refresh-${res.status}`);
  }
  const data = await res.json();
  const next: AccountSession = {
    email: session.email,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? session.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  await serial(async () => chrome.storage.local.set({ account: next }));
  return next;
}

/** The current session, refreshed first if it's about to expire. Null if not linked or refresh failed. */
async function ensureFreshSession(): Promise<AccountSession | null> {
  const session = await getAccount();
  if (!session) return null;
  if (session.expiresAt >= Date.now() + 30_000) return session;
  try {
    return await refreshSession(session);
  } catch {
    return null;
  }
}

function cardRow(card: MinedCard) {
  return {
    lemma: card.lemma, surface: card.surface, sentence: card.sentence,
    target_start: card.targetStart, definitions: card.definitions,
    url: card.url, title: card.title,
  };
}

/** Pushes one card to the review website's database. Resolves the new row's id (if readable), or null on any failure. Never throws. */
async function pushCard(card: MinedCard, session: AccountSession): Promise<{ remoteId?: string } | null> {
  const post = (s: AccountSession) => fetchWithTimeout(`${SUPABASE_URL}/rest/v1/cards`, {
    method: 'POST',
    headers: { ...supabaseHeaders, Authorization: `Bearer ${s.accessToken}`, Prefer: 'return=representation' },
    body: JSON.stringify(cardRow(card)),
  });
  try {
    let res = await post(session);
    if (res.status === 401) res = await post(await refreshSession(session));
    if (res.ok) {
      // The id is what lets a later edit on either side find this same row
      // (see updateCard / syncEdits below). A body we can't read just means
      // no id yet -- the card still synced, and linkRemoteIds can recover it.
      const rows = (await res.json().catch(() => [])) as { id?: string }[];
      return { remoteId: rows[0]?.id };
    }
    console.warn('[dokhack] card sync failed', res.status);
  } catch (err) {
    console.warn('[dokhack] card sync failed', err);
  }
  return null;
}

/** Marks locally-stored cards as synced (recording each one's website row id) so a later sync doesn't re-push and duplicate them. */
async function markSynced(synced: Map<string, string | undefined>): Promise<void> {
  return serial(async () => {
    const cards = await getCards();
    await chrome.storage.local.set({
      cards: cards.map((c) => (synced.has(c.id) ? { ...c, synced: true, remoteId: synced.get(c.id) ?? c.remoteId } : c)),
    });
  });
}

/** Fire-and-forget push for a just-saved card; failures are logged, never surfaced to the caller. */
async function syncCardInBackground(card: MinedCard): Promise<void> {
  const session = await ensureFreshSession();
  if (!session) return;
  const pushed = await pushCard(card, session);
  if (!pushed) return;
  await markSynced(new Map([[card.id, pushed.remoteId]]));
  if (card.audioBlobId || card.frameBlobId) await syncMedia(session, card.id);
}

/** Pushes cards not yet synced -- safe to call repeatedly without creating duplicate rows -- then reconciles edits. */
async function syncAllCards(): Promise<number> {
  const session = await ensureFreshSession();
  if (!session) return 0;
  const unsynced = (await getCards()).filter((c) => !c.synced);
  const succeeded = new Map<string, string | undefined>();
  for (const card of unsynced) {
    const pushed = await pushCard(card, session);
    if (pushed) succeeded.set(card.id, pushed.remoteId);
  }
  if (succeeded.size) await markSynced(succeeded);
  await syncEdits(session);
  await syncMedia(session);
  await syncVocab(session);
  return succeeded.size;
}

// ---- vocabulary sync (extension <-> website) --------------------------------
// The website's stats and its paste-text reader (../web) need to know which
// words the reader has marked. The extension owns that data (chrome.storage),
// so on every 모두 동기화 it (1) applies word marks the reader made on the
// website -- queued in the vocab_inbox table, which this then empties --
// (2) uploads the whole word map to the one-row-per-user `vocab` table when
// it changed, and (3) records today's known/seen/learning counts in
// `vocab_daily` for the website's growth chart. Needs the tables from
// ../web/schema.sql; until they exist every request here just fails quietly.

async function restFetch(session: AccountSession, path: string, init: RequestInit = {}): Promise<Response> {
  const go = (s: AccountSession) => fetchWithTimeout(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { ...supabaseHeaders, Authorization: `Bearer ${s.accessToken}`, ...(init.headers as Record<string, string> | undefined) },
  }, 20_000);
  let res = await go(session);
  if (res.status === 401) res = await go(await refreshSession(session));
  return res;
}

const VALID_MARKS = new Set(['seen', 'learning', 'known', 'ignored']);

/** Cheap content signature (FNV-1a over the JSON), so an unchanged word map isn't re-uploaded. */
function signature(words: object): string {
  const text = JSON.stringify(words);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}:${h >>> 0}`;
}

async function syncVocab(session: AccountSession): Promise<void> {
  const uid = userIdOf(session);
  if (!uid) return;
  try {
    // 1. Marks made on the website since the last sync.
    const inboxRes = await restFetch(session, '/rest/v1/vocab_inbox?select=id,lemma,status&order=id.asc&limit=5000');
    if (inboxRes.ok) {
      const inbox = (await inboxRes.json()) as { id: number; lemma: string; status: string }[];
      if (inbox.length) {
        await serial(async () => {
          const words = await getWords();
          for (const m of inbox) {
            if (!/^[a-z][a-z' -]*$/.test(m.lemma)) continue;
            if (m.status === 'unknown') delete words[m.lemma];
            else if (VALID_MARKS.has(m.status)) words[m.lemma] = m.status as WordMap[string];
          }
          await chrome.storage.local.set({ words });
        });
        await restFetch(session, `/rest/v1/vocab_inbox?id=in.(${inbox.map((m) => m.id).join(',')})`, {
          method: 'DELETE', headers: { Prefer: 'return=minimal' },
        });
      }
    } else {
      console.warn('[dokhack] vocab inbox unavailable', inboxRes.status);
      return; // tables not created yet -- nothing else here will work either
    }

    // 2. The word map itself, only when it changed.
    const words = await getWords();
    const sig = signature(words);
    const { vocabSig } = await chrome.storage.local.get('vocabSig');
    if (sig !== vocabSig) {
      const res = await restFetch(session, '/rest/v1/vocab', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: uid, words, updated_at: new Date().toISOString() }),
      });
      if (res.ok) await chrome.storage.local.set({ vocabSig: sig });
      else console.warn('[dokhack] vocab upload failed', res.status);
    }

    // 3. Today's counts, for the growth chart (one row per day; later syncs the same day overwrite it).
    const counts = { known: 0, seen: 0, learning: 0 };
    for (const s of Object.values(words)) if (s in counts) counts[s as keyof typeof counts]++;
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await restFetch(session, '/rest/v1/vocab_daily?on_conflict=user_id,day', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: uid, day, ...counts }),
    });
  } catch (err) {
    console.warn('[dokhack] vocab sync failed', err);
  }
}

// ---- audio clip + frame upload --------------------------------------------
// A YouTube card's audio/frame live in the extension's IndexedDB (blobstore.ts),
// which the website can't read. So once a card has a website row id, its blobs
// are uploaded to a private Supabase Storage bucket under {user id}/{row id}/,
// and the row's audio_path/frame_path columns point at them -- the website
// fetches them with the reader's own login. Needs the one-time SQL in
// ../web/schema.sql (the columns, the bucket, and per-user storage policies);
// until that's been run every upload here just fails quietly and is retried on
// the next sync, never affecting the text sync.

const MEDIA_BUCKET = 'card-media';
const MEDIA_TIMEOUT_MS = 20_000;

/** The signed-in user's id -- the `sub` claim of the (unverified, ours-to-read) access token. */
function userIdOf(session: AccountSession): string | null {
  try {
    const payload = session.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return (JSON.parse(atob(payload)) as { sub?: string }).sub ?? null;
  } catch {
    return null;
  }
}

async function uploadMedia(path: string, blob: Blob, session: AccountSession): Promise<boolean> {
  const put = (s: AccountSession) => fetchWithTimeout(`${SUPABASE_URL}/storage/v1/object/${MEDIA_BUCKET}/${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${s.accessToken}`, 'Content-Type': blob.type || 'application/octet-stream', 'x-upsert': 'true' },
    body: blob,
  }, MEDIA_TIMEOUT_MS);
  try {
    let res = await put(session);
    if (res.status === 401) res = await put(await refreshSession(session));
    if (!res.ok) console.warn('[dokhack] media upload failed', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (err) {
    console.warn('[dokhack] media upload failed', err);
    return false;
  }
}

/** Uploads captured audio/frames not yet on the website (or re-recorded since). `onlyId` limits it to one local card. */
async function syncMedia(session: AccountSession, onlyId?: string): Promise<void> {
  const uid = userIdOf(session);
  if (!uid) return;
  const done = new Map<string, NonNullable<MinedCard['mediaSynced']>>();
  const cards = (await getCards()).filter((c) => (!onlyId || c.id === onlyId) && c.remoteId);
  // A failed step stops the whole pass (the likely causes -- no bucket/columns
  // yet, or offline -- would fail every card) but still records what did finish.
  scan: for (const c of cards) {
    const state = { ...c.mediaSynced };
    const row: Record<string, string> = {};
    for (const [kind, blobId, file, column] of [
      ['audio', c.audioBlobId, 'audio.webm', 'audio_path'],
      ['frame', c.frameBlobId, 'frame.jpg', 'frame_path'],
    ] as const) {
      if (!blobId || state[kind] === blobId) continue;
      const stored = await getBlob(blobId).catch(() => null);
      if (!stored) continue;
      const path = `${uid}/${c.remoteId}/${file}`;
      if (!(await uploadMedia(path, stored.blob, session))) break scan;
      row[column] = path;
      state[kind] = blobId;
    }
    if (!Object.keys(row).length) continue;
    // Only record the upload as done once the row points at it.
    if (await patchRemoteCard(c.remoteId!, row, session)) done.set(c.id, state);
    else break scan;
  }
  if (!done.size) return;
  await serial(async () => {
    const latest = await getCards();
    await chrome.storage.local.set({
      cards: latest.map((c) => (done.has(c.id) ? { ...c, mediaSynced: { ...c.mediaSynced, ...done.get(c.id) } } : c)),
    });
  });
}

// ---- card edits, both directions ------------------------------------------
// A card's sentence/definitions can be edited in the extension's library page
// and on the website's cards page. Each local card stores its website row id
// (`remoteId`, recorded when it's pushed) so an edit on either side can find
// the same row. `dirty` marks a local edit that hasn't reached the website
// yet, so the pull below never overwrites it with the website's older copy.

interface RemoteCard {
  id: string;
  lemma: string;
  sentence: string;
  target_start: number;
  definitions: MinedCard['definitions'];
  url: string;
}

async function fetchRemoteCards(session: AccountSession): Promise<RemoteCard[] | null> {
  const get = (s: AccountSession) => fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/cards?select=id,lemma,sentence,target_start,definitions,url&limit=5000`,
    { headers: { ...supabaseHeaders, Authorization: `Bearer ${s.accessToken}` } },
  );
  try {
    let res = await get(session);
    if (res.status === 401) res = await get(await refreshSession(session));
    return res.ok ? ((await res.json()) as RemoteCard[]) : null;
  } catch (err) {
    console.warn('[dokhack] fetching website cards failed', err);
    return null;
  }
}

async function patchRemoteCard(remoteId: string, body: object, session: AccountSession): Promise<boolean> {
  const patch = (s: AccountSession) => fetchWithTimeout(`${SUPABASE_URL}/rest/v1/cards?id=eq.${encodeURIComponent(remoteId)}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders, Authorization: `Bearer ${s.accessToken}`, Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  try {
    let res = await patch(session);
    if (res.status === 401) res = await patch(await refreshSession(session));
    return res.ok;
  } catch (err) {
    console.warn('[dokhack] card edit sync failed', err);
    return false;
  }
}

/**
 * Cards synced before `remoteId` existed have no stored row id. Match them
 * to a website row by content (lemma + sentence + url) so they can be edited
 * too; `sentenceOverrides` lets a caller that has *already* applied a local
 * edit match on the sentence as it was when it synced. Each website row is
 * claimed at most once, since re-syncing bugs in the past could leave
 * duplicate rows with identical content.
 */
async function linkRemoteIds(remote: RemoteCard[], sentenceOverrides: Map<string, string> = new Map()): Promise<void> {
  const cards = await getCards();
  const claimed = new Set(cards.map((c) => c.remoteId).filter(Boolean));
  const links = new Map<string, string>();
  for (const c of cards) {
    if (!c.synced || c.remoteId) continue;
    const sentence = sentenceOverrides.get(c.id) ?? c.sentence;
    const hit = remote.find((r) => !claimed.has(r.id) && r.lemma === c.lemma && r.sentence === sentence && r.url === c.url);
    if (hit) { claimed.add(hit.id); links.set(c.id, hit.id); }
  }
  if (!links.size) return;
  await serial(async () => {
    const latest = await getCards();
    await chrome.storage.local.set({
      cards: latest.map((c) => (links.has(c.id) && !c.remoteId ? { ...c, remoteId: links.get(c.id) } : c)),
    });
  });
}

const sameDefs = (a: MinedCard['definitions'], b: MinedCard['definitions']) => JSON.stringify(a) === JSON.stringify(b);

/** Pushes local edits that haven't reached the website, then pulls website-side edits into local cards. */
async function syncEdits(session: AccountSession): Promise<void> {
  const remote = await fetchRemoteCards(session);
  if (!remote) return;
  await linkRemoteIds(remote);

  const byId = new Map(remote.map((r) => [r.id, r]));
  const cards = await getCards();
  const pushed = new Set<string>();
  const pulled = new Map<string, Pick<MinedCard, 'sentence' | 'targetStart' | 'definitions'>>();
  for (const c of cards) {
    if (!c.remoteId) continue;
    if (c.dirty) {
      const ok = await patchRemoteCard(
        c.remoteId, { sentence: c.sentence, target_start: c.targetStart, definitions: c.definitions }, session,
      );
      if (ok) pushed.add(c.id);
      continue; // never pull over an edit that hasn't gone up yet
    }
    const r = byId.get(c.remoteId);
    if (r && (r.sentence !== c.sentence || r.target_start !== c.targetStart || !sameDefs(r.definitions, c.definitions))) {
      pulled.set(c.id, { sentence: r.sentence, targetStart: r.target_start, definitions: r.definitions });
    }
  }
  if (!pushed.size && !pulled.size) return;
  await serial(async () => {
    const latest = await getCards();
    await chrome.storage.local.set({
      cards: latest.map((c) => {
        if (pushed.has(c.id)) return { ...c, dirty: false };
        const p = pulled.get(c.id);
        return p && !c.dirty ? { ...c, ...p } : c;
      }),
    });
  });
}

/** Edits a card locally, then (fire-and-forget) tries to propagate it to the website. */
async function updateCard(
  id: string, sentence: string, targetStart: number, definitions: MinedCard['definitions'],
): Promise<MinedCard> {
  let oldSentence = '';
  const updated = await serial(async () => {
    const cards = await getCards();
    const card = cards.find((c) => c.id === id);
    if (!card) throw new Error('card-not-found');
    oldSentence = card.sentence;
    const next: MinedCard = { ...card, sentence, targetStart, definitions, dirty: !!card.synced };
    await chrome.storage.local.set({ cards: cards.map((c) => (c.id === id ? next : c)) });
    return next;
  });
  if (updated.synced) propagateEdit(id, oldSentence).catch(() => {});
  return updated;
}

async function propagateEdit(id: string, oldSentence: string): Promise<void> {
  const session = await ensureFreshSession();
  if (!session) return; // stays dirty; the next 모두 동기화 pushes it
  let card = (await getCards()).find((c) => c.id === id);
  if (!card) return;
  if (!card.remoteId) {
    const remote = await fetchRemoteCards(session);
    if (!remote) return;
    await linkRemoteIds(remote, new Map([[id, oldSentence]]));
    card = (await getCards()).find((c) => c.id === id);
    if (!card?.remoteId) return;
  }
  const sent = card;
  const ok = await patchRemoteCard(
    card.remoteId, { sentence: sent.sentence, target_start: sent.targetStart, definitions: sent.definitions }, session,
  );
  if (!ok) return;
  await serial(async () => {
    const cards = await getCards();
    // Only clear `dirty` if no newer edit landed while this one was in flight.
    await chrome.storage.local.set({
      cards: cards.map((c) => (c.id === id && c.sentence === sent.sentence ? { ...c, dirty: false } : c)),
    });
  });
}

/** How many cards are due on the review website right now, for the toolbar popup's badge. Null if not linked or unreachable. */
async function fetchDueCount(): Promise<number | null> {
  const session = await ensureFreshSession();
  if (!session) return null;
  const url = `${SUPABASE_URL}/rest/v1/cards?select=id&due=lte.${encodeURIComponent(new Date().toISOString())}&limit=1`;
  const get = (s: AccountSession) => fetchWithTimeout(url, {
    headers: { ...supabaseHeaders, Authorization: `Bearer ${s.accessToken}`, Prefer: 'count=exact' },
  });
  try {
    let res = await get(session);
    if (res.status === 401) res = await get(await refreshSession(session));
    if (!res.ok) return null;
    const total = res.headers.get('content-range')?.split('/')[1];
    return total && total !== '*' ? Number(total) : 0;
  } catch {
    return null;
  }
}

// ---- FSRS review results -> word status (roadmap item 9) ----------------
// The only direction this sync ran before: a mined card goes extension ->
// Supabase, and the website schedules/reviews it with ts-fsrs, writing
// state back onto that same row (see ../web/src/review.ts's fromCard()).
// Nothing ever read that back. This closes the loop the other way: once a
// word's reviews show it's genuinely stuck, auto-mark it 알아요 locally
// instead of leaving the reader to notice and do it by hand.
//
// "Genuinely stuck" is kept narrow and simple on purpose, not tuned to
// ts-fsrs's own scheduling internals: state Review (ts-fsrs's
// State.Review, whose numeric value is 2 — graduated out of the initial
// Learning phase) with at least LEARNED_MIN_REPS reviews and zero lapses
// (never once rated Again against it). This is a nudge, not the only path
// to 알아요 — the reader can always just mark a word themselves, and this
// never touches a word they've already explicitly marked 알아요 or 모르는
// 단어 one way or the other (only ever promotes from 학습 중).
const LEARNED_STATE = 2;
const LEARNED_MIN_REPS = 3;

/** Pulls lemmas with enough successful reviews and promotes matching 학습 중 words to 알아요. */
async function pullLearnedWords(): Promise<number> {
  const session = await ensureFreshSession();
  if (!session) return 0;

  const query = `select=lemma&state=eq.${LEARNED_STATE}&reps=gte.${LEARNED_MIN_REPS}&lapses=eq.0`;
  const get = (s: AccountSession) => fetchWithTimeout(`${SUPABASE_URL}/rest/v1/cards?${query}`, {
    headers: { ...supabaseHeaders, Authorization: `Bearer ${s.accessToken}` },
  });

  let res: Response;
  try {
    res = await get(session);
    if (res.status === 401) res = await get(await refreshSession(session));
    if (!res.ok) return 0;
  } catch (err) {
    console.warn('[dokhack] pulling learned words failed', err);
    return 0;
  }

  const rows = (await res.json()) as { lemma: string }[];
  const learnedLemmas = new Set(rows.map((r) => r.lemma));
  if (!learnedLemmas.size) return 0;

  return serial(async () => {
    const words = await getWords();
    let promoted = 0;
    for (const lemma of learnedLemmas) {
      if (words[lemma] === 'learning') {
        words[lemma] = 'known';
        promoted++;
      }
    }
    if (promoted) await chrome.storage.local.set({ words });
    return promoted;
  });
}

/**
 * Marks every word in pasted text (a plain word list, an Anki "notes as text"
 * export, any prose) with a status. Words are lemmatized by the same tokenizer
 * the page uses, so "running" and "ran" both land on "run", and HTML left over
 * from an Anki export is stripped first. Only fills words with no status yet --
 * never overrides a choice already made. Returns how many words were added and
 * how many distinct words the text had.
 */
async function importWords(text: string, status: 'known' | 'seen' | 'learning'): Promise<{ added: number; distinct: number }> {
  const clean = text.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
  const lemmas = new Set<string>();
  const CHUNK = 20_000; // keeps each tokenize() call bounded for a big file
  for (let i = 0; i < clean.length; i += CHUNK) {
    let piece = clean.slice(i, i + CHUNK);
    // Don't cut a word in half at the chunk edge: extend to the next whitespace.
    if (i + CHUNK < clean.length) {
      const rest = clean.slice(i + CHUNK);
      const gap = rest.search(/\s/);
      if (gap > 0) { piece += rest.slice(0, gap); i += gap; }
    }
    for (const t of await tokenize(piece)) if (/^[a-z][a-z'-]*$/.test(t.lemma)) lemmas.add(t.lemma);
  }
  return serial(async () => {
    const words = await getWords();
    let added = 0;
    for (const lemma of lemmas) {
      if (!(lemma in words)) { words[lemma] = status; added++; }
    }
    if (added) await chrome.storage.local.set({ words });
    return { added, distinct: lemmas.size };
  });
}

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case 'tokenize':
      // The NLP model (~3 MB) lives here, loaded once, instead of in every tab.
      return Promise.all(req.texts.map(tokenize));
    case 'lookup':
      return lookupEnglish(req.lemma, req.sentence, req.pos);
    case 'koreanGloss':
      return lookupKorean(req.lemma, req.sentence, req.pos);
    case 'setStatus':
      return serial(async () => {
        const words = await getWords();
        if (req.status === 'unknown') delete words[req.lemma];
        else words[req.lemma] = req.status;
        await chrome.storage.local.set({ words });
      });
    case 'importWords':
      return importWords(req.text, req.status);
    case 'saveSettings':
      // A content script's way to change a setting (it may only READ storage itself).
      return serial(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...(settings ?? {}), ...req.patch } });
      });
    case 'seedBands':
      // The placement test runs on the website (../web), which only reports
      // how many of the frequency bands the reader knows; the word lists
      // themselves stay here, so a web page can never inject arbitrary lemmas.
      // Only fills in words with no status yet, so it never overrides a
      // choice the reader already made (manually, or from an earlier test).
      return serial(async () => {
        const cutoff = Math.max(0, Math.min(FREQUENCY_BANDS.length, Math.floor(req.cutoff)));
        const words = await getWords();
        let added = 0;
        for (const lemma of FREQUENCY_BANDS.slice(0, cutoff).flat()) {
          if (!(lemma in words)) {
            words[lemma] = 'known';
            added++;
          }
        }
        await chrome.storage.local.set({ words });
        return added;
      });
    case 'saveCard':
      return serial(async () => {
        const cards = await getCards();
        const card: MinedCard = {
          ...req.card, id: crypto.randomUUID(), createdAt: Date.now(), synced: false,
        };
        await chrome.storage.local.set({ cards: [card, ...cards] });
        return card;
      }).then((card) => {
        // Outside serial() on purpose: awaiting the network here would make
        // every card save (and every other tab's storage write, since
        // they're all queued behind the same chain) wait on Supabase before
        // the editor can close. A sync failure must never make the local
        // save — which already happened above — look like it failed too.
        syncCardInBackground(card).catch(() => {});
        return card;
      });
    case 'deleteCard':
      return serial(async () => {
        const cards = await getCards();
        const gone = cards.find((c) => c.id === req.id);
        await chrome.storage.local.set({ cards: cards.filter((c) => c.id !== req.id) });
        // A deleted card's captured audio/frame would otherwise leak in IndexedDB forever.
        for (const blobId of [gone?.audioBlobId, gone?.frameBlobId]) {
          if (blobId) deleteBlob(blobId).catch(() => {});
        }
      });
    case 'updateCard':
      return updateCard(req.id, req.sentence, req.targetStart, req.definitions);
    case 'dueCount':
      return fetchDueCount();
    case 'requestLoginCode':
      return requestLoginCode(req.email);
    case 'verifyLoginCode':
      return verifyLoginCode(req.email, req.code);
    case 'logout':
      return logout();
    case 'syncAllCards':
      return syncAllCards();
    case 'pullLearnedWords':
      return pullLearnedWords();
    case 'storeBlob': {
      const id = await putBlob(req.kind, req.mimeType, base64ToBytes(req.data).buffer);
      // Best-effort: a stale cleanup failure must never fail the new store.
      if (req.replaceId) deleteBlob(req.replaceId).catch((e) => console.warn('[dokhack] stale blob cleanup failed', e));
      return { id };
    }
    case 'getBlob': {
      const rec = await getBlob(req.id);
      if (!rec) return null;
      return { mimeType: rec.mimeType, data: bytesToBase64(await rec.blob.arrayBuffer()) };
    }
    case 'deleteBlob':
      return deleteBlob(req.id).catch(() => {}); // best-effort; never surfaces as a failure to the caller
  }
}

chrome.runtime.onMessage.addListener((req: Request, _sender, sendResponse) => {
  handle(req)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true; // keep the channel open for the async response
});
