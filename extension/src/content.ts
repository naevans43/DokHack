import { bytesToBase64 } from './binary';
import { CardEditor } from './editor';
import { blockOf, Highlighter } from './highlighter';
import { REVIEW_SITE_URL } from './config';
import { ask } from './messaging';
import { WordPopup } from './popup';
import { DEFAULT_SETTINGS, getSettings, getWords, statusOf, type WordMap } from './storage';
import type { KoreanCandidate, LookupResult, Settings, TabCommand, TabStatus, Token, WordStatus } from './types';
import {
  captureAudioClip, captureFrame, disableYouTubeExtras, initYouTubeExtras,
  pauseIfBarWord, setAutoPauseLines, timeRangeForLines, transcriptContextFor, videoStats,
} from './youtube';

let words: WordMap = {};
let highlighter: Highlighter | null = null;
let popup: WordPopup | null = null;
let editor: CardEditor | null = null;
let session = 0; // guards against late responses for a word you've moved past

// State for the word currently open in the popup/editor, refreshed on each
// openWord() call. sentenceCtx holds the full segmented sentence list around
// it so the editor's "+ 앞/뒤 문장" buttons can pull in neighbors on demand.
let currentToken: Token | null = null;
let currentRange: Range | null = null;
let currentSentence = '';
let lastLookup: LookupResult | null = null;
let lastKorean: KoreanCandidate[] = [];
let sentenceCtx: { list: string[]; index: number; before: number; after: number; youtube: boolean } | null = null;

const host = location.hostname;

// Nothing is scanned until the reader asks (toolbar popup's 스캔 button) --
// unless they've turned on the autoScan setting. `scanRequested` is that
// per-page-load choice: null = follow the setting, true = the reader pressed
// scan, false = the reader pressed stop (stays off even with autoScan on,
// until the page reloads). The whole machinery (highlighter, observers,
// listeners, YouTube extras) only exists between enable() and disable(), so an
// unscanned page costs essentially nothing.
let settings: Settings = DEFAULT_SETTINGS;
let scanRequested: boolean | null = null;

async function main(): Promise<void> {
  if (!('highlights' in CSS)) {
    console.warn('[dokhack] CSS Custom Highlight API not supported here.');
    return;
  }
  const [s, w] = await Promise.all([getSettings(), getWords()]);
  words = w;
  applySettings(s);

  chrome.runtime.onMessage.addListener((msg: TabCommand, _sender, sendResponse) => {
    if (!msg || (msg.dokhack !== 'scan' && msg.dokhack !== 'unscan' && msg.dokhack !== 'status')) return;
    if (msg.dokhack === 'scan') scanRequested = true;
    else if (msg.dokhack === 'unscan') scanRequested = false;
    reconcile();
    sendResponse({
      active: !!highlighter, allowed: hostAllowed(),
      stats: highlighter?.stats(), videoStats: highlighter ? videoStats() : undefined,
    } satisfies TabStatus);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.words) {
      words = (changes.words.newValue as WordMap) ?? {};
      highlighter?.updateWords(words);
      if (popup?.current) popup.setStatus(statusOf(words, popup.current.lemma));
    }
    if (changes.settings) applySettings(changes.settings.newValue as Settings);
  });
}

function hostAllowed(): boolean {
  return !settings.disabledHosts?.includes(host);
}

function applySettings(next: Settings): void {
  settings = { ...DEFAULT_SETTINGS, ...next };
  setAutoPauseLines(settings.autoPauseLines);
  reconcile();
}

/** Brings the page in line with (site allowed) AND (scan requested, or else the autoScan setting). */
function reconcile(): void {
  const want = hostAllowed() && (scanRequested ?? settings.autoScan);
  if (want && !highlighter) enable();
  if (!want && highlighter) disable();
}

function enable(): void {
  popup = new WordPopup();
  editor = new CardEditor();
  highlighter = new Highlighter(words, () => popup?.host ?? null);
  highlighter.start();
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseleave', onMouseLeave);
  encounterTimer = setInterval(reportEncounters, ENCOUNTER_REPORT_MS);
  initYouTubeExtras((root) => highlighter?.stats(root) ?? { total: 0, known: 0, seen: 0, learning: 0, unknown: 0, ignored: 0 });
}

function disable(): void {
  highlighter?.stop();
  popup?.close();
  popup?.host.remove();
  editor?.close();
  editor?.host.remove();
  highlighter = popup = editor = null;
  hoverToken = null;
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('mouseleave', onMouseLeave);
  disableYouTubeExtras();
  clearInterval(encounterTimer);
}

// ---- "seen it again" ------------------------------------------------------
// While a page is scanned, every few seconds tell the background which 학습 중
// words are on it that haven't been reported for this page yet (text keeps
// arriving -- infinite scroll, YouTube's transcript). The background turns
// that into at most one encounter per word per page (background.ts's
// recordEncounters()).

const ENCOUNTER_REPORT_MS = 5000;
let encounterTimer: ReturnType<typeof setInterval> | undefined;
let reportedUrl = '';
let reported = new Set<string>();

function reportEncounters(): void {
  if (!highlighter) return;
  const url = location.href.split('#')[0];
  if (url !== reportedUrl) { reportedUrl = url; reported = new Set(); } // YouTube: a new video, same document
  const fresh = highlighter.presentLemmas().filter((l) => words[l] === 'learning' && !reported.has(l));
  if (!fresh.length) return;
  fresh.forEach((l) => reported.add(l));
  ask({ type: 'encounter', lemmas: fresh, url }).catch(() => {});
}

// ---- hover cue ----------------------------------------------------------
// Words get no visual affordance otherwise ("known" words paint no status
// color at all), so hovering paints a neutral highlight to show it's
// clickable. Recomputed at most once per frame via requestAnimationFrame.

let hoverRaf = 0;
let hoverToken: { node: Text; start: number; end: number } | null = null;

function onMouseMove(e: MouseEvent): void {
  if (editor?.isOpen || (popup?.isOpen && e.composedPath().includes(popup.host))) return;
  if (hoverRaf) return;
  const x = e.clientX;
  const y = e.clientY;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    const hit = wordAt(x, y);
    if (hit) {
      if (hoverToken && hoverToken.node === hit.node
        && hoverToken.start === hit.token.start && hoverToken.end === hit.token.end) return;
      hoverToken = { node: hit.node, start: hit.token.start, end: hit.token.end };
      highlighter?.setHover(hit.range);
    } else if (hoverToken) {
      hoverToken = null;
      highlighter?.setHover(null);
    }
  });
}

function onMouseLeave(): void {
  hoverToken = null;
  highlighter?.setHover(null);
}

// ---- hit testing -------------------------------------------------------

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) return { node: pos.offsetNode, offset: pos.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

function wordAt(x: number, y: number): { node: Text; token: Token; range: Range } | null {
  const caret = caretAt(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !highlighter) return null;
  const node = caret.node as Text;
  const found = highlighter.hitAt(node, caret.offset);
  if (!found) return null;
  // The highlighter's own Range: token offsets are block-flat, not node-local,
  // so rebuilding a Range from them on `node` broke every word after inline markup.
  const { token } = found;
  const range = found.range.cloneRange();
  // caret APIs snap to the nearest character, even from far away —
  // make sure the pointer is actually on the word.
  const hit = [...range.getClientRects()].some(
    (r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1,
  );
  return hit ? { node, token, range } : null;
}

// Inside links and buttons a plain click keeps its normal job; Alt+click
// looks up the word instead.
const INTERACTIVE = 'a[href], button, [role="button"], label, summary, select';

function onClick(e: MouseEvent): void {
  if (editor?.isOpen) return; // the editor's own backdrop/dialog handle its clicks
  if (!popup || e.button !== 0 || e.composedPath().includes(popup.host)) return;
  const sel = getSelection();
  if (sel && !sel.isCollapsed) return; // user is selecting text

  const target = e.target as Element | null;
  if (target?.closest(INTERACTIVE) && !e.altKey) return;

  const hit = wordAt(e.clientX, e.clientY);
  if (!hit) return popup.close();

  if (e.altKey) {
    e.preventDefault();
    e.stopPropagation();
  }
  openWord(hit.node, hit.token, hit.range);
}

function onPointerDown(e: PointerEvent): void {
  if (editor?.isOpen) return;
  if (popup?.isOpen && !e.composedPath().includes(popup.host)) {
    // Let the click handler decide whether a new word opens; closing here
    // would flicker. Only close when the pointer isn't on a word.
    if (!wordAt(e.clientX, e.clientY)) popup.close();
  }
}

function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement;
  const inField = t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);

  if (editor?.isOpen) {
    // Let normal typing through (e.g. editing the sentence); only Escape is
    // ours. Not while a recording is in progress (roadmap item 11) -- that
    // can only be stopped via the capture section's own "중단" button, so
    // closing the whole editor mid-recording is structurally impossible
    // through the UI rather than something cleanup has to handle.
    if (e.key !== 'Escape' || editor.isRecording) return;
    editor.close();
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (inField || !popup?.isOpen || !popup.current) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const map: Record<string, WordStatus> = { '1': 'unknown', '2': 'seen', '3': 'learning', '4': 'known' };
  if (e.key === 'Escape') popup.close();
  else if (map[e.key]) setStatus(popup.current.lemma, map[e.key]);
  else if (e.key.toLowerCase() === 's') openEditor();
  else return;
  e.preventDefault();
  e.stopPropagation();
}

// ---- opening a word ----------------------------------------------------

function openWord(node: Text, token: Token, range: Range): void {
  if (!popup) return;
  pauseIfBarWord(node);
  const id = ++session;
  const { sentences, index, youtube } = segmentBlock(range);
  const sentence = sentences[index] ?? token.surface;

  currentToken = token;
  currentRange = range;
  currentSentence = sentence;
  lastLookup = null;
  lastKorean = [];
  sentenceCtx = { list: sentences, index, before: 0, after: 0, youtube };

  popup.open(range, token, statusOf(words, token.lemma), {
    onStatus: (s) => setStatus(token.lemma, s),
    onSpeak: () => speak(token.lemma),
    onOpenEditor: () => openEditor(),
  });
  // Looking a word up marks it seen (unless the reader turned that off) -- only
  // ever from "unknown", so it never overrides a status they chose.
  if (settings.autoSeen && statusOf(words, token.lemma) === 'unknown') setStatus(token.lemma, 'seen');

  ask<LookupResult>({ type: 'lookup', lemma: token.lemma, sentence, pos: token.pos, surface: token.surface })
    .then((r) => {
      if (id !== session) return;
      lastLookup = r;
      popup?.setLookup(r);
      if (editor?.isOpen) { editor.setDictionaryDefs(r.definitions); editor.setFalseFriend(r.falseFriend ?? null); }
    })
    .catch(() => id === session && popup?.setLookup(null));

  ask<KoreanCandidate[]>({ type: 'koreanGloss', lemma: token.lemma, sentence, pos: token.pos })
    .then((candidates) => {
      if (id !== session) return;
      lastKorean = candidates;
      popup?.setKoreanGloss(candidates);
      if (editor?.isOpen) editor.setKoreanCandidates(candidates);
    })
    .catch(() => {});
}

// Roadmap item 11: a captured audio-clip/frame blob is pushed to the
// background worker's IndexedDB store (src/blobstore.ts) immediately on
// capture, not deferred to the final Save click -- the capture itself is
// already a committed real-time action, so buffering it only in memory
// risks losing a multi-second recording if the editor dies before Save.
interface PendingCapture {
  audioBlobId?: string;
  frameBlobId?: string;
  clipStartMs?: number;
  clipEndMs?: number;
}

async function storeCapturedBlob(kind: 'audio' | 'frame', blob: Blob, replaceId: string | undefined): Promise<string> {
  const data = bytesToBase64(await blob.arrayBuffer()); // see binary.ts: ArrayBuffers don't survive Chrome's message serialization
  const { id } = await ask<{ id: string }>({ type: 'storeBlob', kind, mimeType: blob.type, data, replaceId });
  return id;
}

interface SentencePick {
  token: Token;
  sentence: string;
  ctx: { list: string[]; index: number; youtube: boolean };
}

/**
 * One-unknown sentence picks: other sentences on this page where the clicked
 * word is the only one not yet known, nearest first (at most three), plus how
 * many other unknown words the clicked sentence itself has. Only sentences of
 * the same kind are offered -- a YouTube transcript line for a YouTube card
 * (so its audio clip still lines up), page prose otherwise.
 */
function sentencePicks(lemma: string, clicked: Range | null, youtube: boolean): { currentOthers: number | null; picks: SentencePick[] } {
  const all = highlighter?.sentencesWith(lemma) ?? [];
  const at = clicked
    ? all.findIndex((c) => c.range.startContainer === clicked.startContainer && c.range.startOffset === clicked.startOffset)
    : -1;
  const seen = new Set([currentSentence]);
  const picks: SentencePick[] = [];
  const near = all
    .map((c, i) => ({ c, d: Math.abs(i - Math.max(at, 0)) }))
    .filter(({ c }, i) => c.others === 0 && i !== at)
    .sort((a, b) => a.d - b.d);
  for (const { c } of near) {
    if (picks.length >= 3) break;
    const seg = segmentBlock(c.range);
    const sentence = seg.sentences[seg.index];
    if (seg.youtube !== youtube || !sentence || seen.has(sentence)) continue;
    seen.add(sentence);
    picks.push({ token: c.token, sentence, ctx: { list: seg.sentences, index: seg.index, youtube: seg.youtube } });
  }
  return { currentOthers: at >= 0 ? all[at].others : null, picks };
}

function openEditor(): void {
  if (!editor || !currentToken) return;
  // `token` is reassigned when the reader switches to a suggested sentence
  // (its surface form there can differ: "ran" vs "running").
  let token = currentToken;
  const ctx = sentenceCtx;
  popup?.close();

  const { currentOthers, picks } = sentencePicks(token.lemma, currentRange, !!ctx?.youtube);
  const original: SentencePick | null = ctx
    ? { token, sentence: currentSentence, ctx: { list: ctx.list, index: ctx.index, youtube: ctx.youtube } }
    : null;

  // Closure-local, not module state -- matches the existing "handlers
  // rebuilt fresh per open()" pattern below. Relies on CardEditor.close()
  // always firing onClose exactly once, on every exit path, so an
  // unclaimed capture never leaks in IndexedDB. A one-field ref object
  // rather than a reassigned `let`, so TS doesn't narrow its type to the
  // value seen at the closures' definition point (it reassigns itself
  // asynchronously, inside several of the closures below).
  const pending: { capture: PendingCapture | null } = { capture: null };
  let activeAbort: AbortController | null = null;

  let youtubeCapture: { startMs: number; endMs: number; initialFrameDataUrl: string | null } | null = null;
  if (ctx?.youtube) {
    const range = timeRangeForLines(ctx.index - ctx.before, ctx.index + ctx.after);
    if (range) {
      const initialFrameDataUrl = captureFrame();
      youtubeCapture = { ...range, initialFrameDataUrl };
      if (initialFrameDataUrl) {
        // Fire-and-forget: a failed auto-capture just leaves no frame yet:
        // the editor's "다시 캡처" button lets the reader try again.
        (async () => {
          const blob = await (await fetch(initialFrameDataUrl)).blob();
          const id = await storeCapturedBlob('frame', blob, pending.capture?.frameBlobId).catch(() => null);
          if (id) pending.capture = { ...pending.capture, frameBlobId: id };
        })();
      }
    }
  }

  editor.open(
    {
      lemma: token.lemma,
      surface: token.surface,
      pos: token.pos,
      sentence: currentSentence,
      dictionaryDefs: lastLookup?.definitions ?? [],
      koreanCandidates: lastKorean,
      falseFriend: lastLookup?.falseFriend ?? null,
      youtubeCapture,
      sentencePick: { currentOthers, suggestions: picks.map((p) => p.sentence) },
    },
    {
      onExpand: (dir) => expandSentence(dir),
      onCollapse: (dir) => collapseSentence(dir),
      onSpeak: () => speak(token.lemma),
      onCancel: () => editor?.close(),
      onPickSentence: (i) => {
        const p = i < 0 ? original : picks[i];
        if (!p) return null;
        token = p.token;
        currentSentence = p.sentence;
        sentenceCtx = { ...p.ctx, before: 0, after: 0 };
        return p.sentence;
      },
      onRangeRecalc: () => {
        if (!sentenceCtx?.youtube) return null;
        return timeRangeForLines(sentenceCtx.index - sentenceCtx.before, sentenceCtx.index + sentenceCtx.after);
      },
      onRecordAudio: (startMs, endMs, onProgress) => {
        const controller = new AbortController();
        activeAbort = controller;
        const promise = captureAudioClip(startMs, endMs, onProgress, controller.signal)
          .then(async ({ audioBlob, startMs: s, endMs: e }) => {
            const previewUrl = URL.createObjectURL(audioBlob);
            const id = await storeCapturedBlob('audio', audioBlob, pending.capture?.audioBlobId);
            pending.capture = { ...pending.capture, audioBlobId: id, clipStartMs: s, clipEndMs: e };
            return { previewUrl };
          })
          .finally(() => { activeAbort = null; });
        return { promise, cancel: () => controller.abort() };
      },
      onRetakeFrame: async () => {
        const dataUrl = captureFrame();
        if (!dataUrl) return null;
        const blob = await (await fetch(dataUrl)).blob();
        const id = await storeCapturedBlob('frame', blob, pending.capture?.frameBlobId).catch(() => null);
        if (id) pending.capture = { ...pending.capture, frameBlobId: id };
        return dataUrl;
      },
      onClose: () => {
        activeAbort?.abort();
        activeAbort = null;
        const capture = pending.capture;
        if (capture) {
          if (capture.audioBlobId) ask({ type: 'deleteBlob', id: capture.audioBlobId }).catch(() => {});
          if (capture.frameBlobId) ask({ type: 'deleteBlob', id: capture.frameBlobId }).catch(() => {});
          pending.capture = null;
        }
      },
      onSave: async (result) => {
        const targetStart = Math.max(0, result.sentence.indexOf(token.surface));
        const capture = pending.capture;
        pending.capture = null; // claim ownership before editor.close() below fires onClose
        try {
          await ask({
            type: 'saveCard',
            card: {
              lemma: token.lemma, surface: token.surface,
              sentence: result.sentence, targetStart, definitions: result.definitions,
              url: location.href, title: document.title,
              ...(capture?.audioBlobId ? { audioBlobId: capture.audioBlobId } : {}),
              ...(capture?.frameBlobId ? { frameBlobId: capture.frameBlobId } : {}),
              ...(capture ? { clipStartMs: capture.clipStartMs, clipEndMs: capture.clipEndMs } : {}),
            },
          });
        } catch (e) {
          pending.capture = capture; // save failed -- restore so close() still cleans up correctly
          throw e;
        }
        // Saving a card implies you're learning the word.
        if (['unknown', 'seen'].includes(statusOf(words, token.lemma))) setStatus(token.lemma, 'learning');
        editor?.close();
      },
    },
  );
}

function expandSentence(direction: 'before' | 'after'): string | null {
  const ctx = sentenceCtx;
  if (!ctx) return null;
  if (direction === 'before') {
    const i = ctx.index - ctx.before - 1;
    if (i < 0) return null;
    ctx.before++;
    return ctx.list[i];
  }
  const i = ctx.index + ctx.after + 1;
  if (i >= ctx.list.length) return null;
  ctx.after++;
  return ctx.list[i];
}

/** Undoes the most recent expandSentence() on that side. Returns the sentence dropped. */
function collapseSentence(direction: 'before' | 'after'): string | null {
  const ctx = sentenceCtx;
  if (!ctx) return null;
  if (direction === 'before') {
    if (ctx.before <= 0) return null;
    const text = ctx.list[ctx.index - ctx.before];
    ctx.before--;
    return text;
  }
  if (ctx.after <= 0) return null;
  const text = ctx.list[ctx.index + ctx.after];
  ctx.after--;
  return text;
}

function setStatus(lemma: string, status: WordStatus): void {
  // Paint immediately; storage.onChanged will confirm it.
  words = { ...words };
  if (status === 'unknown') delete words[lemma];
  else words[lemma] = status;
  highlighter?.updateWords(words);
  popup?.setStatus(status);
  ask({ type: 'setStatus', lemma, status }).catch(() => {});
  if (status === 'ignored') popup?.close();
}

function speak(word: string): void {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  u.lang = 'en-US';
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

// ---- sentence extraction ----------------------------------------------

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

// YouTube's transcript panel (roadmap item 7) renders each caption line as
// its own block-level element, not as sentences inside one shared
// paragraph -- so treating "the block" as the sentence list, like any
// other page, would only ever find that single line, leaving the editor's
// "+ 앞/뒤 문장" buttons nothing to expand into. Sibling caption lines take
// the place of neighboring sentences instead. Auto-generated captions also
// rarely have real sentence-ending punctuation, which is exactly why this
// needs to be a real special case rather than relying on Intl.Segmenter to
// find "sentences" within a merged blob of lines.
const TRANSCRIPT_SEGMENT_TAG = 'YTD-TRANSCRIPT-SEGMENT-RENDERER';

function segmentTranscriptLines(block: Element): { sentences: string[]; index: number } {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  const siblings = [...(block.parentElement?.children ?? [block])]
    .filter((el) => el.tagName === TRANSCRIPT_SEGMENT_TAG);
  // Just the caption text -- a segment also contains a .segment-timestamp
  // ("0:03") that textContent on the whole element would fold in.
  const sentences = siblings.map((el) => clean(el.querySelector('.segment-text')?.textContent ?? el.textContent ?? ''));
  return { sentences, index: Math.max(0, siblings.indexOf(block)) };
}

/**
 * Every sentence in the block around `token`, even if a sentence spans
 * several text nodes (links, bold), plus which one contains it — so the
 * editor's "+ 앞/뒤 문장" buttons can pull in a neighbor on demand. `youtube`
 * is true only on the transcriptContextFor() branch (youtube.ts's own
 * custom transcript panel/subtitle bar, which tracks real timestamps) --
 * never the native-panel fallback (segmentTranscriptLines(), no timestamp
 * data) or a plain page -- it's the sole signal openEditor() uses to decide
 * whether to show the audio/frame capture section at all (roadmap item 11).
 */
function segmentBlock(word: Range): { sentences: string[]; index: number; youtube: boolean } {
  const block = blockOf(word.startContainer);
  const ytCtx = transcriptContextFor(block);
  if (ytCtx) return { ...ytCtx, youtube: true };
  if (block.tagName === TRANSCRIPT_SEGMENT_TAG) return { ...segmentTranscriptLines(block), youtube: false };

  const before = document.createRange();
  before.setStart(block, 0);
  before.setEnd(word.startContainer, word.startOffset);
  let offset = before.toString().length;
  let text = block.textContent ?? '';

  // Don't segment an entire page body; a window around the word is enough.
  if (text.length > 6000) {
    const from = Math.max(0, offset - 2000);
    text = text.slice(from, offset + 2000);
    offset -= from;
  }

  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  const sentences: string[] = [];
  let index = 0;
  for (const seg of segmenter.segment(text)) {
    const s = clean(seg.segment);
    if (!s) continue;
    if (offset >= seg.index && offset < seg.index + seg.segment.length) index = sentences.length;
    sentences.push(s);
  }
  return { sentences, index, youtube: false };
}

/**
 * The review website's placement test (../web/src/placement.ts) can't write to
 * extension storage itself, so it talks to this content script over
 * window.postMessage -- registered ONLY on the website's own origin (zero cost
 * everywhere else), and only for messages that page itself posted. The site
 * sends how many frequency bands the reader knows; background.ts expands that
 * into words, so the page can't seed arbitrary lemmas.
 */
function initSiteBridge(): void {
  if (location.origin !== new URL(REVIEW_SITE_URL).origin) return;
  const reply = (msg: Record<string, unknown>) =>
    window.postMessage({ source: 'dokhack-ext', ...msg }, location.origin);
  window.addEventListener('message', async (e) => {
    const m = e.data;
    if (e.source !== window || e.origin !== location.origin || !m || m.source !== 'dokhack-site') return;
    if (m.type === 'ping') {
      reply({ type: 'pong', id: m.id });
    } else if (m.type === 'seedBands' && Number.isInteger(m.cutoff)) {
      try {
        reply({ type: 'seeded', id: m.id, added: await ask<number>({ type: 'seedBands', cutoff: m.cutoff }) });
      } catch {
        reply({ type: 'error', id: m.id });
      }
    }
  });
}

initSiteBridge();
main();
