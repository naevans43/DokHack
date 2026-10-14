// "unknown" is the default and is never stored; only explicit choices are.
// 'seen' = looked up but not decided yet (set automatically when a word's card
// is opened, unless autoSeen is off); between not-knowing and studying it.
export type WordStatus = 'unknown' | 'seen' | 'learning' | 'known' | 'ignored';

export interface Token {
  start: number; // char offset inside the text node
  end: number;
  surface: string; // as written on the page ("running", or "gave up" for a merged phrasal verb)
  // Dictionary form ("run") — the key for word status. Can be a space-joined
  // phrase ("give up") when nlp.ts's mergePhrasalVerbs() collapsed several
  // tokens into one; nothing downstream (highlighting, status storage,
  // dictionary lookups) treats a lemma as necessarily one word.
  lemma: string;
  pos: string; // universal POS tag from wink-nlp
}

// One meaning picked in the card editor — an English dictionary definition,
// or a Korean gloss from the local KRDICT reverse index (src/krdict.ts).
export interface CardDefinition {
  text: string;
  lang: 'ko' | 'en';
}

export type CardLanguage = 'ko' | 'en' | 'both';

export interface MinedCard {
  id: string;
  lemma: string;
  surface: string;
  sentence: string;
  targetStart: number; // where `surface` begins inside `sentence`
  definitions: CardDefinition[]; // chosen in the card editor; may be empty
  url: string;
  title: string;
  createdAt: number;
  // Whether this card has been pushed to the review website. Undefined (for
  // cards saved before this field existed) is treated as "not yet synced,"
  // so old cards get picked up by the next syncAllCards() pass too.
  synced?: boolean;
  // YouTube audio-clip/frame capture (roadmap item 11) -- only ever set when
  // the card came from youtube.ts's custom transcript panel/subtitle bar.
  // References into the background worker's IndexedDB blob store
  // (src/blobstore.ts), never the blob itself -- see storeBlob/getBlob below.
  audioBlobId?: string;
  frameBlobId?: string;
  clipStartMs?: number;
  clipEndMs?: number;
  // The review website's `cards` row id, recorded when this card is pushed --
  // lets an edit made here (or there) find the same row. Absent on cards
  // synced before it existed; background.ts's linkRemoteIds() recovers it by
  // matching content. `dirty` = edited locally, not yet pushed to the website.
  remoteId?: string;
  dirty?: boolean;
  // Which captured blobs (by blob id) have been uploaded to the review
  // website's Supabase Storage bucket, so a sync only uploads what's new or
  // re-recorded -- see background.ts's syncMedia().
  mediaSynced?: { audio?: string; frame?: string };
}

export interface Settings {
  disabledHosts: string[];
  /**
   * Scan every page automatically as it loads. Off by default: highlighting a
   * whole page is a lot of visual noise (and tokenizing work) when the reader
   * isn't studying, so by default nothing happens until the toolbar popup's
   * "스캔" button is pressed on that page.
   */
  autoScan: boolean;
  /** Opening an unknown word's card marks it 봤어요 (seen). On by default. */
  autoSeen: boolean;
  /** YouTube: pause at the end of every subtitle line. OFF by default. */
  autoPauseLines: boolean;
}

/** Popup -> content script (via chrome.tabs.sendMessage). `dokhack` is the discriminator. */
export type TabCommand = { dokhack: 'scan' | 'unscan' | 'status' };

/** A content script's answer to any TabCommand. */
export interface TabStatus {
  /** This page is currently scanned (words highlighted, clicks/hover live). */
  active: boolean;
  /** The reader hasn't switched the extension off for this site. */
  allowed: boolean;
  /** Word-occurrence counts by status on the scanned page (only while active). */
  stats?: PageStats;
  /** YouTube only: the same counts restricted to the current video's transcript (once it's built). */
  videoStats?: PageStats;
}

/** Running-word counts by status (see Highlighter.stats and comprehension.ts). */
export interface PageStats { total: number; known: number; seen: number; learning: number; unknown: number; ignored: number }

// A signed-in link to the review website (see /web). Absent = not linked;
// mining/highlighting work exactly the same either way.
export interface AccountSession {
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface LookupResult {
  lemma: string;
  definitions: { pos: string; text: string }[];
  /** Konglish / false-friend note for this word (konglish.ts), if it's on the list. */
  falseFriend?: string | null;
}

// A Korean gloss candidate from the local KRDICT reverse index, ranked by
// Lesk-style overlap with the sentence the word was clicked in (see krdict.ts).
export interface KoreanCandidate {
  ko: string;
  level: 1 | 2 | 3; // 초급/중급/고급 (beginner/intermediate/advanced) — for reference/sorting
}

// Messages from content/pages to the background worker.
export type Request =
  | { type: 'tokenize'; texts: string[] }
  | { type: 'lookup'; lemma: string; sentence: string; pos: string; surface?: string }
  | { type: 'koreanGloss'; lemma: string; sentence: string; pos: string }
  | { type: 'setStatus'; lemma: string; status: WordStatus }
  | { type: 'saveSettings'; patch: Partial<Settings> }
  | { type: 'seedBands'; cutoff: number }
  | { type: 'importWords'; text: string; status: 'known' | 'seen' | 'learning' }
  | { type: 'saveCard'; card: Omit<MinedCard, 'id' | 'createdAt'> }
  | { type: 'deleteCard'; id: string }
  | { type: 'requestLoginCode'; email: string }
  | { type: 'verifyLoginCode'; email: string; code: string }
  | { type: 'logout' }
  | { type: 'syncAllCards' }
  | { type: 'pullLearnedWords' }
  // Roadmap item 11: YouTube audio-clip/frame capture. Blobs are handed to
  // the background worker as base64 strings (not Blob/ArrayBuffer: Chrome
  // JSON-serializes extension messages, which would turn those into `{}` --
  // see src/binary.ts; and see src/blobstore.ts's header comment for why this
  // has to cross into the background worker at all) and stored in its own
  // IndexedDB store, referenced from MinedCard by id. `replaceId`, when given,
  // best-effort-deletes the previous blob a re-record/retake is replacing,
  // so it isn't leaked.
  | { type: 'storeBlob'; kind: 'audio' | 'frame'; mimeType: string; data: string; replaceId?: string }
  | { type: 'getBlob'; id: string }
  | { type: 'deleteBlob'; id: string }
  // Edit a saved card's sentence/definitions (library page); propagated to the
  // review website when the card has been synced.
  | { type: 'updateCard'; id: string; sentence: string; targetStart: number; definitions: CardDefinition[] }
  // Cards due on the review website right now (null = not linked/unreachable).
  | { type: 'dueCount' }
  // "Seen it again": 학습 중 words that appear on the page being read (content.ts
  // reports each once per page); the background counts one encounter per page.
  | { type: 'encounter'; lemmas: string[]; url: string };

/**
 * "Seen it again" counter, keyed by lemma: how many different pages/videos a
 * word turned up on while it was 학습 중 (not counting the page its card came
 * from). `p` holds short hashes of the recent pages already counted -- never
 * the URLs themselves -- so a reload or a revisit doesn't count twice. Only
 * the counts are synced (vocab.encounters on the website).
 */
export type EncounterMap = Record<string, { n: number; p: string[] }>;

export type Response<T> = { ok: true; data: T } | { ok: false; error: string };
