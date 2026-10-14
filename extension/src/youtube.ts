// YouTube subtitle mining, phase 2: a DokHack-styled transcript viewer and
// subtitle bar, modeled on Kimchi Reader's equivalent pair (real markup the
// user pasted from it, not guessed from memory) -- distinct from roadmap
// item 7's original approach (mining directly off YouTube's own "Show
// transcript" panel via Alt+click, which still works and is untouched).
//
// Both surfaces are plain light-DOM elements, not a shadow root like
// popup.ts/editor.ts -- deliberately, so the existing Highlighter/content.ts
// click pipeline mines their text exactly like any other page's, with no
// changes needed in either file. The only highlighter.ts change is adding
// our own timestamp badge's class to SKIP_CLASSES, the same mechanism
// already used for YouTube's native ".segment-timestamp".

import { comprehensionOf, TARGET_PCT } from './comprehension';
import { ask } from './messaging';
import type { PageStats } from './types';

interface TranscriptLine {
  text: string;
  startMs: number;
}

// ---- pause after every subtitle line (opt-in) ------------------------------
// Off by default (settings.autoPauseLines): it changes how the video plays, so
// it's only ever on if the reader turned it on -- here via the chip in the
// panel header, or in the options page. While on, playback stops just before
// each next line begins, so the line you just heard stays on screen to click.
// A requestAnimationFrame watcher (not just the ~4 Hz 'timeupdate', which
// would let a few hundred ms of the next line leak out before pausing) runs
// only while the video is playing. Resuming from a pause must not instantly
// re-pause at the same boundary, hence pausedBoundary.
let autoPauseLines = false;
const PAUSE_LEAD_MS = 60;
let pausedBoundary = -1; // index of the line whose start we last paused in front of
let pauseRaf = 0;
let pauseChip: HTMLButtonElement | null = null;

function indexAtMs(ms: number): number {
  let i = Math.max(currentIndex, 0);
  if (lines[i] && lines[i].startMs > ms) i = 0; // a backward jump: rescan from the top
  while (i + 1 < lines.length && lines[i + 1].startMs <= ms) i++;
  return lines[i] && lines[i].startMs <= ms ? i : -1;
}

let lastSeekAt = 0;
let selfSeek = false;

/**
 * Pauses if playback is at the end of a line. Two cases: (1) within
 * PAUSE_LEAD_MS of the next line's start -- the normal, frame-accurate case;
 * (2) the video has *just crossed* into the next line (the rAF watcher doesn't
 * run in a hidden tab, and 'timeupdate' is only ~4 Hz) -- step back to just
 * before that line and pause there, so the line that was playing stays on
 * screen. Case 2 ignores crossings caused by the reader seeking.
 */
function maybePauseAtLineEnd(): boolean {
  if (!autoPauseLines || !video || video.paused || video.ended || !lines.length) return false;
  const ms = video.currentTime * 1000;
  const idx = indexAtMs(ms);
  if (idx < 0) return false;
  const next = lines[idx + 1];
  if (next && next.startMs - ms <= PAUSE_LEAD_MS && pausedBoundary !== idx + 1) {
    pausedBoundary = idx + 1;
    video.pause();
    return true;
  }
  if (currentIndex >= 0 && idx === currentIndex + 1 && pausedBoundary !== idx
      && !video.seeking && performance.now() - lastSeekAt > 1000) {
    pausedBoundary = idx;
    selfSeek = true;
    video.currentTime = (lines[idx].startMs - 1) / 1000;
    video.pause();
    return true;
  }
  if (pausedBoundary >= 0 && idx >= pausedBoundary) pausedBoundary = -1; // moved past it
  return false;
}

function watchLineEnd(): void {
  pauseRaf = 0;
  if (!autoPauseLines || !video || video.paused || video.ended) return;
  if (maybePauseAtLineEnd()) return; // the 'play' listener restarts the watcher
  pauseRaf = requestAnimationFrame(watchLineEnd);
}

function startPauseWatcher(): void {
  if (autoPauseLines && !pauseRaf && video && !video.paused) pauseRaf = requestAnimationFrame(watchLineEnd);
}

function onVideoSeeking(): void {
  if (selfSeek) { selfSeek = false; return; } // our own step-back, not the reader
  pausedBoundary = -1; // a manual jump: forget where we last paused
  lastSeekAt = performance.now();
}

/** Applied from the settings (and the chip); safe to call before any video exists. */
export function setAutoPauseLines(on: boolean): void {
  autoPauseLines = on;
  if (pauseChip) {
    pauseChip.setAttribute('aria-pressed', String(on));
    pauseChip.classList.toggle('dokhack-yt-chip-on', on);
  }
  if (on) startPauseWatcher();
  else if (pauseRaf) { cancelAnimationFrame(pauseRaf); pauseRaf = 0; }
}

const PANEL_ID = 'dokhack-yt-panel';
const BAR_ID = 'dokhack-yt-bar';

let lines: TranscriptLine[] = [];
let currentIndex = -1;
let panelEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;
let jumpBtn: HTMLButtonElement | null = null;
let barEl: HTMLElement | null = null;
let barTextEl: HTMLElement | null = null;
let video: HTMLVideoElement | null = null;
let collapsed = false;
let userScrolledAway = false;
let suppressScrollUntil = 0;
let generation = 0; // bumps on every SPA navigation so stale async work bails out

// Which line index a given rendered text element belongs to -- lets
// content.ts's segmentBlock() treat the *other* lines as this one's
// neighboring sentences, the same way it already does for YouTube's own
// transcript panel (see TRANSCRIPT_SEGMENT_TAG there). Auto-generated
// captions have no sentence-ending punctuation and each line is its own
// block, so without this the editor's "+ 앞/뒤 문장" buttons would have
// nothing to expand into.
const lineIndexOf = new WeakMap<Element, number>();

/** content.ts calls this from segmentBlock() before falling back to its generic path. */
export function transcriptContextFor(block: Element): { sentences: string[]; index: number } | null {
  const idx = lineIndexOf.get(block);
  if (idx === undefined) return null;
  return { sentences: lines.map((l) => l.text), index: idx };
}

/**
 * content.ts calls this when a word is opened -- pauses playback by default
 * if the word came from the subtitle bar, since the line (and the moment)
 * would otherwise keep moving while the reader's still reading the lookup.
 * Not applied to the transcript panel, which is meant to be browsed
 * independently of what's currently playing.
 */
export function pauseIfBarWord(node: Node): void {
  if (barTextEl?.contains(node)) video?.pause();
}

// ---- audio-clip + frame capture (roadmap item 11) --------------------------
// `video` and `lines` stay module-private as everywhere else in this file --
// these three functions are the only consumers that need them, and nothing
// outward-facing needs the element or the raw line array itself, only what
// these compute from them.

/**
 * content.ts calls this with the line-index range it currently has expanded
 * (sentenceCtx.index - before .. index + after) to get the capture
 * boundary. Indices into `sentenceCtx.list` are already indices into `lines`
 * -- transcriptContextFor() above returns `lines.map(l => l.text)` as
 * `sentences` -- so no separate mapping is needed on the caller's side.
 * Returns null only if there's no harvested transcript at all (e.g. called
 * after teardown()).
 */
const DEFAULT_TAIL_MS = 4000; // last-resort clip length past the final line, if there's no next line and no known video duration

export function timeRangeForLines(firstIndex: number, lastIndex: number): { startMs: number; endMs: number } | null {
  if (!lines.length) return null;
  const first = Math.max(0, Math.min(firstIndex, lines.length - 1));
  const last = Math.max(first, Math.min(lastIndex, lines.length - 1));
  const startMs = lines[first].startMs;
  const videoEndMs = video && isFinite(video.duration) ? video.duration * 1000 : null;
  let endMs = last + 1 < lines.length ? lines[last + 1].startMs : (videoEndMs ?? startMs + DEFAULT_TAIL_MS);
  if (videoEndMs !== null) endMs = Math.min(endMs, videoEndMs);
  if (endMs <= startMs) endMs = startMs + 300; // guard a degenerate range
  return { startMs, endMs };
}

/**
 * Instant screen-capture of the video's current frame as a JPEG data URL, or
 * null on any failure. Confirmed live (see CLAUDE.md roadmap item 11) that
 * drawing YouTube's <video> to a canvas does NOT taint it -- the player is
 * fed via a same-origin blob: URL (MediaSource Extensions), so this is safe.
 */
export function captureFrame(): string | null {
  if (!video || video.readyState < 2) return null; // HAVE_CURRENT_DATA
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx || !canvas.width || !canvas.height) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return null;
  }
}

const CLIP_MIME = 'audio/webm;codecs=opus';

export interface CaptureResult { audioBlob: Blob; startMs: number; endMs: number }

/**
 * Captures real audio from the video's own soundtrack between startMs and
 * endMs -- one function for both the initial capture and a re-record, the
 * caller just passes new times. Confirmed live (see CLAUDE.md roadmap item
 * 11) that video.captureStream()'s audio track fed into a MediaRecorder
 * produces a real, valid WebM/Opus blob -- but there's no instant
 * seek-and-extract: this seeks, starts recording, actually plays the video
 * in real time for the clip's duration, then stops, so the promise doesn't
 * resolve faster than the clip itself. Restores the video's original
 * currentTime/paused state afterward, so a reader who had it paused (e.g.
 * via pauseIfBarWord) is left paused once capture finishes. `signal` cancels
 * an in-flight capture (stops the recorder, rejects cleanly) -- needed since
 * this can run for several real seconds.
 */
export function captureAudioClip(
  startMs: number,
  endMs: number,
  onProgress: (elapsedMs: number) => void,
  signal: AbortSignal,
): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    if (!video) return reject(new Error('dokhack-capture-no-video'));
    const v = video;
    if (!(endMs - startMs > 0)) return reject(new Error('dokhack-capture-invalid-range'));
    if (!MediaRecorder.isTypeSupported(CLIP_MIME)) return reject(new Error('dokhack-capture-unsupported'));

    const captureStream = (v as HTMLVideoElement & { captureStream(): MediaStream }).captureStream;
    const tracks = captureStream.call(v).getAudioTracks();
    if (!tracks.length) return reject(new Error('dokhack-capture-no-audio-track'));

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: CLIP_MIME });
    } catch {
      return reject(new Error('dokhack-capture-recorder-init-failed'));
    }

    const chunks: Blob[] = [];
    const wasPaused = v.paused;
    const originalTime = v.currentTime;
    let settled = false;
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    let seeked = false;

    const cleanupPlayback = () => {
      v.removeEventListener('timeupdate', onEndCheck);
      if (progressTimer !== null) clearInterval(progressTimer);
      v.currentTime = originalTime;
      if (wasPaused) v.pause();
    };
    const finish = (err: Error | null, blob?: Blob) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      cleanupPlayback();
      if (err) reject(err); else resolve({ audioBlob: blob!, startMs, endMs });
    };
    const onAbort = () => {
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* already stopped */ }
      finish(new Error('dokhack-capture-cancelled'));
    };
    signal.addEventListener('abort', onAbort);

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onerror = () => finish(new Error('dokhack-capture-recorder-error'));
    recorder.onstop = () => { if (!settled) finish(null, new Blob(chunks, { type: CLIP_MIME })); };

    function onEndCheck() {
      if (v.currentTime * 1000 >= endMs || v.ended) {
        v.removeEventListener('timeupdate', onEndCheck);
        if (recorder.state !== 'inactive') recorder.stop();
      }
    }
    const onSeeked = () => {
      v.removeEventListener('seeked', onSeeked);
      seeked = true;
      if (signal.aborted) return;
      const startedAt = Date.now();
      recorder.start();
      v.addEventListener('timeupdate', onEndCheck);
      progressTimer = setInterval(() => onProgress(Date.now() - startedAt), 150);
      v.play().catch(() => finish(new Error('dokhack-capture-play-failed')));
    };
    v.addEventListener('seeked', onSeeked);
    try {
      v.currentTime = startMs / 1000;
    } catch {
      v.removeEventListener('seeked', onSeeked);
      finish(new Error('dokhack-capture-seek-failed'));
    }

    setTimeout(() => {
      if (!settled && !seeked) {
        v.removeEventListener('seeked', onSeeked);
        finish(new Error('dokhack-capture-seek-timeout'));
      }
    }, 5000);
  });
}

let lastPath = '';
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ---- comprehension meter (per video) -----------------------------------------
// The panel header shows what share of this video's transcript words the
// reader knows (comprehension.ts; 95% is the target band). Counted by
// content.ts's Highlighter over our own transcript list only -- the rest of a
// YouTube page (titles, comments) would swamp it otherwise.
/** What content.ts lends this file: the Highlighter's counts and a way to open the word card. */
export interface YouTubeHooks {
  stats(root: Node): PageStats;
  topUnknown(root: Node, n: number, minRank?: number): { lemma: string; count: number; first: Range }[];
  openAt(range: Range): void;
}
let hooks: YouTubeHooks | null = null;
const statsFor = (root: Node) => hooks?.stats(root) ?? null;
let meterEl: HTMLElement | null = null;

/** This video's transcript word counts, or undefined before a transcript is built. */
export function videoStats(): PageStats | undefined {
  return (listEl && statsFor(listEl)) || undefined;
}

// ---- pre-watch word list -----------------------------------------------------
// Before (or as) the video plays: the few not-yet-known words that come up most
// in its transcript, most frequent first (general frequency breaks ties), each
// with its best Korean gloss and one-click 알아요 / 학습 중. Clicking the word
// opens the normal word card on its first line, where 카드 만들기 is. Built
// once per video, after the transcript list has finished highlighting (its
// word count stopped changing), and kept as is so marked words show as done
// instead of the list reshuffling under the reader's cursor.
const PREWATCH_WORDS = 5;
// Seen live on a profile with few words marked 알아요: the list was "the, and,
// a, be, of" (with glosses like "ㅏ"). The most frequent words in English are
// never what a reader needs flagged before a video, so they're skipped.
const PREWATCH_SKIP_RANK = 200;
let prewatchEl: HTMLElement | null = null;
let prewatchShown = false;
let lastTotal = -1;
let stableTicks = 0;

function updatePrewatch(): void {
  if (prewatchShown || !prewatchEl || !listEl || !hooks) return;
  const total = hooks.stats(listEl).total;
  stableTicks = total > 0 && total === lastTotal ? stableTicks + 1 : 0;
  lastTotal = total;
  if (stableTicks < 2) return; // highlighting arrives in batches; wait for two quiet seconds
  prewatchShown = true;
  const words = hooks.topUnknown(listEl, PREWATCH_WORDS, PREWATCH_SKIP_RANK);
  if (!words.length) return;

  const head = el('div', { class: 'dokhack-yt-prewatch-head' });
  head.append(el('span', {}, '이 영상에서 자주 나오는 모르는 단어'));
  const close = el('button', { type: 'button', class: 'dokhack-yt-icon-btn', 'aria-label': '닫기' }, '✕') as HTMLButtonElement;
  close.addEventListener('click', () => { if (prewatchEl) prewatchEl.hidden = true; });
  head.append(close);
  const list = el('ul', { class: 'dokhack-yt-prewatch-list' });
  for (const w of words) {
    const li = el('li');
    const word = el('button', { type: 'button', class: 'dokhack-yt-prewatch-word', title: '단어 카드 열기' }, w.lemma) as HTMLButtonElement;
    word.addEventListener('click', () => {
      // Bring its first line into view without tripping "현재 자막으로 이동".
      suppressScrollUntil = Date.now() + 600;
      w.first.startContainer.parentElement?.scrollIntoView({ block: 'center' });
      hooks?.openAt(w.first);
    });
    const gloss = el('span', { class: 'dokhack-yt-prewatch-gloss' }, '');
    const line = w.first.startContainer.parentElement?.closest('.dokhack-yt-line-text')?.textContent ?? '';
    ask<{ ko: string }[]>({ type: 'koreanGloss', lemma: w.lemma, sentence: line, pos: '' })
      .then((c) => { gloss.textContent = c[0]?.ko ?? ''; }).catch(() => {});
    const count = el('span', { class: 'dokhack-yt-prewatch-count' }, `${w.count}번`);
    const acts = el('span', { class: 'dokhack-yt-prewatch-acts' });
    for (const [status, label] of [['known', '알아요'], ['learning', '학습 중']] as const) {
      const b = el('button', { type: 'button', class: 'dokhack-yt-chip' }, label) as HTMLButtonElement;
      b.addEventListener('click', () => {
        ask({ type: 'setStatus', lemma: w.lemma, status }).catch(() => {});
        li.classList.add('dokhack-yt-prewatch-done');
        acts.replaceChildren(el('span', { class: 'dokhack-yt-prewatch-mark' }, status === 'known' ? '알아요로 표시했어요' : '학습 중으로 표시했어요'));
      });
      acts.append(b);
    }
    li.append(word, gloss, count, acts);
    list.append(li);
  }
  prewatchEl.replaceChildren(head, list);
  prewatchEl.hidden = false;
}

// ---- "good to rewatch" ------------------------------------------------------
// A video counts as watched after REWATCH_MIN_S seconds of actual playback (or
// half of it, for a short one). If its comprehension is in the 95% band at
// that point, the background remembers it (device-only list on the library
// page); the score is re-sent whenever it changes, e.g. as words get marked.
const REWATCH_MIN_S = 60;
let watchedS = 0;
let reportedPct = -1;

function noteWatching(pct: number | null): void {
  if (!video || video.paused || video.ended) return;
  watchedS++;
  const needed = isFinite(video.duration) ? Math.min(REWATCH_MIN_S, video.duration / 2) : REWATCH_MIN_S;
  if (watchedS < needed || pct === null || pct < TARGET_PCT || pct === reportedPct) return;
  const id = new URLSearchParams(location.search).get('v');
  if (!id) return;
  reportedPct = pct;
  const title = document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '');
  ask({ type: 'rememberVideo', url: `https://www.youtube.com/watch?v=${id}`, title, pct }).catch(() => {});
}

function updateMeter(): void {
  if (!meterEl) return;
  const c = comprehensionOf(videoStats());
  noteWatching(c?.pct ?? null);
  meterEl.hidden = !c;
  if (!c) return;
  meterEl.textContent = `이해도 ${c.pct}%`;
  meterEl.dataset.band = c.band;
  meterEl.title = `이 영상 자막 단어의 ${c.pct}%를 알아요. ${c.label} (목표 ${TARGET_PCT}% 이상)`;
}

export function initYouTubeExtras(h: YouTubeHooks): void {
  if (location.hostname !== 'www.youtube.com') return;
  hooks = h;
  // YouTube is a single-page app -- switching videos never reloads the
  // page, so 'yt-navigate-finish' is the intended way to notice a new video
  // loaded. Confirmed live, though, that it doesn't always fire -- reliably
  // through some link paths (e.g. a real click on an
  // ytd-compact-video-renderer link) but intermittently through others (seen
  // missing after navigating via a yt-lockup-view-model link, one of
  // YouTube's newer component variants) -- and when it's missed, nothing
  // ever tears down the previous video's panel/bar, leaving them stuck
  // showing the wrong video's transcript indefinitely with no way to
  // recover short of a real page reload. checkNavigation() is a lightweight
  // location.pathname poll that catches any change the event missed,
  // running alongside it rather than replacing it (the event, when it does
  // fire, reacts immediately; the poll is only a backstop).
  document.addEventListener('yt-navigate-finish', checkNavigation);
  pollTimer = setInterval(() => { checkNavigation(); updateMeter(); updatePrewatch(); }, 1000);
  checkNavigation();
}

/** Mirrors content.ts's disable() -- e.g. the reader turned DokHack off for youtube.com. */
export function disableYouTubeExtras(): void {
  document.removeEventListener('yt-navigate-finish', checkNavigation);
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  lastPath = ''; // so scanning again on the same video rebuilds the panel (it used to see "same page" and do nothing)
  generation++;
  teardown();
}

function checkNavigation(): void {
  const path = location.pathname + location.search;
  if (path === lastPath) return;
  lastPath = path;
  onNavigate();
}

function onNavigate(): void {
  generation++;
  teardown();
  if (!/^\/watch/.test(location.pathname)) return;
  setup(generation);
}

function teardown(): void {
  lines = [];
  currentIndex = -1;
  collapsed = false;
  userScrolledAway = false;
  if (video) {
    video.removeEventListener('timeupdate', onTimeUpdate);
    video.removeEventListener('play', startPauseWatcher);
    video.removeEventListener('seeking', onVideoSeeking);
  }
  if (pauseRaf) { cancelAnimationFrame(pauseRaf); pauseRaf = 0; }
  pausedBoundary = -1;
  pauseChip = null;
  meterEl = null;
  prewatchEl = null;
  prewatchShown = false;
  watchedS = 0;
  reportedPct = -1;
  lastTotal = -1;
  stableTicks = 0;
  video = null;
  panelEl?.remove();
  barEl?.remove();
  panelEl = listEl = toggleBtn = jumpBtn = barEl = barTextEl = null;
}

async function setup(gen: number): Promise<void> {
  const harvested = await harvestTranscript(gen);
  if (gen !== generation || !harvested) return;
  lines = harvested;
  video = document.querySelector('video');
  if (!video) return;
  buildPanel();
  buildBar();
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('play', startPauseWatcher);
  video.addEventListener('seeking', onVideoSeeking);
  onTimeUpdate();
  startPauseWatcher();
}

// ---- harvesting the line list --------------------------------------------
// No transcript API is reachable from a content script (see CLAUDE.md's
// Testing notes on the PoToken wall), so this reads the same rendered
// ".segment-text"/".segment-timestamp" markup item 7 already relies on,
// triggering YouTube's own transcript panel first if it isn't already open.
// Two live-confirmed surprises drove the shape of this function (neither
// matched the pasted reference markup, which turned out to have been
// captured before either UI had finished loading):
//
// 1. The "Show transcript" button under the description exists in the DOM
//    but is never actually laid out (`offsetParent === null`) until the
//    reader expands the description -- clicking it does nothing most of the
//    time. The reliable trigger turned out to be the "Transcript" tab
//    (role="tab", aria-label="Transcript") in the separate "In this video"
//    panel, which *is* visible and clickable as soon as it exists. Both are
//    clicked when found (harmless if one is a no-op), rather than picking
//    one and hoping.
// 2. Its real close button is labeled the generic "Close", shared by every
//    engagement panel on the page (comments, chapters, ads...), so a
//    page-wide label selector risks closing an unrelated one -- it has to
//    be looked up scoped to a specific panel's own header. And it has to be
//    *clicked*, not just hidden: while a transcript panel is open, YouTube
//    puts #secondary into `position: fixed` spanning the full page width
//    (presumably so panels can render as overlays); hiding the panel
//    element with display:none instead of closing it left that layout
//    state stuck, visibly breaking the whole sidebar.
// 3. Harvesting can fail outright (a transcript that never finishes loading
//    within the deadline below, seen live on a real video) *after* we've
//    already triggered the panel open -- if cleanup only ran on the success
//    path, a failed harvest left YouTube's own panel stuck open with
//    nothing of ours built to replace it. closeAnyOpenTranscriptPanels()
//    runs unconditionally at the end instead of being tied to success, and
//    sweeps *all* matching panels rather than just the one segments were
//    read from, since by the time it runs there's no guarantee only one
//    is open.
//
// Assumes an English YouTube UI (the aria-label selectors below); on a
// different UI language these won't match and the feature just stays off,
// same as a video with no transcript at all.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTimestamp(s: string): number {
  const parts = s.trim().split(':').map((p) => Number(p) || 0);
  let ms = 0;
  for (const p of parts) ms = ms * 60 + p;
  return ms * 1000;
}

// YouTube renders transcript lines with two different, unrelated markups
// depending on which panel implementation a given video gets (confirmed
// live -- same account, same session, different videos): the older
// "ytd-transcript-segment-renderer" (".segment-timestamp"/".segment-text",
// what item 7's original Alt+click mining already relied on) and a newer
// "transcript-segment-view-model" web component, whose class names are
// hashed/generated per build and unusable as selectors -- its timestamp is
// just "first child div" and its text lives in a "span[role=text]". Both
// are queried for and handled everywhere a segment is read.
const SEGMENT_SELECTOR = 'ytd-transcript-segment-renderer, transcript-segment-view-model';

function extractSegment(seg: Element): { text: string; ts: string } | null {
  if (seg.tagName === 'YTD-TRANSCRIPT-SEGMENT-RENDERER') {
    const text = seg.querySelector('.segment-text')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const ts = seg.querySelector('.segment-timestamp')?.textContent ?? '';
    return text ? { text, ts } : null;
  }
  // transcript-segment-view-model
  const text = seg.querySelector('span[role="text"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const ts = seg.children[0]?.textContent?.trim() ?? '';
  return text ? { text, ts } : null;
}

/** Closes every expanded transcript-related engagement panel, scoped to each one's own header. */
function closeAnyOpenTranscriptPanels(): void {
  const panels = document.querySelectorAll(
    'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]',
  );
  panels.forEach((panel) => {
    // target-id is NOT a reliable way to spot a transcript panel: confirmed
    // live that the newer view-model UI can carry target-id="null" on the
    // very panel actually holding the transcript segments (it seemingly
    // gets reassigned as YouTube recycles panel instances), which silently
    // defeated a target-id-only check here -- the panel never got closed,
    // leaving YouTube's own native panel stuck open next to ours. Also
    // matching on "does it contain segments" catches that case regardless
    // of what its target-id says.
    const looksLikeTranscript =
      /transcript/i.test(panel.getAttribute('target-id') ?? '') || panel.querySelector(SEGMENT_SELECTOR) !== null;
    if (!looksLikeTranscript) return;
    const header = panel.querySelector('ytd-engagement-panel-title-header-renderer');
    const closeBtn = [...(header?.querySelectorAll('button') ?? [])]
      .find((b) => b.getAttribute('aria-label') === 'Close');
    (closeBtn as HTMLButtonElement | undefined)?.click();
  });
}

// Confirmed live on real videos: YouTube can render *two* engagement panels
// holding the same segment list (one EXPANDED, one HIDDEN; target-id can't be
// trusted to say which -- "engagement-panel-searchable-transcript" twice on
// the older UI, "PAmodern_transcript_view" vs "null" on the newer one).
// harvestTranscript() reads an expanded panel first and otherwise only
// segments that appeared since it started, so either copy is fine.

// How long to keep trying for a transcript. The old fixed 20 s started before
// the trigger even existed (seen live: the Transcript tab appeared ~12 s into a
// load) and YouTube fills the panel only when it renders -- in a tab that isn't
// being painted it stayed empty until the tab was shown, then filled at once.
// So the sidebar appeared or not depending on timing. Now: wait up to 90 s, and
// accept segments that arrive late into a panel we've already closed (they
// still land in the DOM), not just ones in an open panel.
const HARVEST_TIMEOUT_MS = 90_000;
// A click on a trigger that YouTube was about to replace (the previous
// video's description during an in-page navigation) opens nothing, and the
// old code only ever clicked once -- so re-click while no transcript panel is open.
const RECLICK_MS = 4000;
const PANEL_SELECTOR = 'ytd-engagement-panel-section-list-renderer';
const EXPANDED = 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';

// Signatures of the transcripts recently shown, by page. With autoScan on, a
// harvest starts the moment an in-page navigation finishes, while YouTube can
// still be showing (and re-opening) the *previous* video's transcript -- the
// "transcript from the previous video" bug. Lines matching what another video
// showed are never accepted for this one.
const recentHarvests: { path: string; sig: string; keys: Set<string> }[] = [];
// Seen live, switching between real TED videos: mid-navigation YouTube's panel
// briefly held the new video's 212 segments *followed by* the previous video's
// 158, and that mixed list sat still long enough to look settled. Its first
// lines were new and its last timestamp fit inside the new video, so it was
// accepted -- 370 lines, half from the wrong video. Two checks catch it: lines
// of one transcript never go back in time, and a real transcript shares
// (almost) no timestamped lines with another video's.
const MAX_SHARED_LINES = 0.2;

const lineKey = (l: TranscriptLine) => `${l.startMs}|${l.text}`;

function linesSig(lines: TranscriptLine[]): string {
  return `${lines.length}:${lines.slice(0, 5).map(lineKey).join('|')}`;
}

function isStale(lines: TranscriptLine[], path: string): boolean {
  if (lines.some((l, i) => i > 0 && l.startMs < lines[i - 1].startMs)) return true; // two transcripts run together
  const sig = linesSig(lines);
  for (const h of recentHarvests) {
    if (h.path === path) continue;
    if (h.sig === sig) return true;
    const shared = lines.filter((l) => h.keys.has(lineKey(l))).length;
    if (shared > lines.length * MAX_SHARED_LINES) return true;
  }
  // A transcript running well past this video's end belongs to another video.
  const durationMs = video && isFinite(video.duration) ? video.duration * 1000 : (() => {
    const v = document.querySelector('video');
    return v && isFinite(v.duration) ? v.duration * 1000 : NaN;
  })();
  return isFinite(durationMs) && lines[lines.length - 1].startMs > durationMs + 5000;
}

function readLines(segs: Element[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const seg of segs) {
    const data = extractSegment(seg);
    if (data) out.push({ text: data.text, startMs: parseTimestamp(data.ts) });
  }
  return out;
}

function anyTranscriptPanelOpen(): boolean {
  return [...document.querySelectorAll(`${PANEL_SELECTOR}[visibility="${EXPANDED}"]`)]
    .some((p) => /transcript/i.test(p.getAttribute('target-id') ?? '') || p.querySelector(SEGMENT_SELECTOR));
}

async function harvestTranscript(gen: number): Promise<TranscriptLine[] | null> {
  // Never trust whatever panel state exists at the start of a harvest --
  // confirmed live that YouTube can carry an EXPANDED transcript panel over to
  // the next video, still showing the previous one's segments. Force-close
  // first so the click below is a fresh open for this navigation, and remember
  // which segment nodes already existed: those belong to an earlier video
  // unless they're in a panel that's open again.
  closeAnyOpenTranscriptPanels();
  const before = new Set(document.querySelectorAll(SEGMENT_SELECTOR));
  const path = location.pathname + location.search;
  const counts = new WeakMap<Element, number>(); // segment count per panel at the last poll

  const deadline = Date.now() + HARVEST_TIMEOUT_MS;
  let lastClick = 0;
  while (Date.now() < deadline) {
    if (gen !== generation) return null;
    if (!anyTranscriptPanelOpen() && Date.now() - lastClick > RECLICK_MS) {
      // Both trigger controls can take several seconds to exist (the
      // description renders well after document_idle); see the header notes.
      const chip = document.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Transcript"]');
      const showBtn = document.querySelector<HTMLButtonElement>('button[aria-label="Show transcript"]');
      if (chip || showBtn) { chip?.click(); showBtn?.click(); lastClick = Date.now(); }
    }

    // An open panel first, then any panel whose segments are new since this harvest began.
    const panels = [...document.querySelectorAll(PANEL_SELECTOR)]
      .sort((a, b) => Number(b.getAttribute('visibility') === EXPANDED) - Number(a.getAttribute('visibility') === EXPANDED));
    for (const panel of panels) {
      const segs = [...panel.querySelectorAll(SEGMENT_SELECTOR)];
      const settled = segs.length > 0 && counts.get(panel) === segs.length; // stopped growing since the last poll
      counts.set(panel, segs.length);
      if (!settled) continue;
      if (panel.getAttribute('visibility') !== EXPANDED && segs.every((s) => before.has(s))) continue;
      const lines = readLines(segs);
      if (!lines.length || isStale(lines, path)) continue;
      closeAnyOpenTranscriptPanels(); // we render our own copy
      recentHarvests.unshift({ path, sig: linesSig(lines), keys: new Set(lines.map(lineKey)) });
      // YouTube was seen re-opening its own panel a moment after a navigation;
      // ours replaces it, so close it again once things have settled.
      for (const ms of [2000, 6000]) setTimeout(() => { if (gen === generation) closeAnyOpenTranscriptPanels(); }, ms);
      recentHarvests.length = Math.min(recentHarvests.length, 8);
      return lines;
    }
    await sleep(300);
  }
  // We may have opened a panel above even though it never populated --
  // don't leave it stuck open with nothing of ours to show for it.
  closeAnyOpenTranscriptPanels();
  return null;
}

// ---- transcript panel -----------------------------------------------------

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function el(tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

const TOGGLE_ICON = {
  collapse: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4.5 6 8.5 10 4.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  expand: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 7.5 6 3.5 10 7.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const PLAY_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1.2v7.6L8 5z" fill="currentColor"/></svg>';

function buildPanel(): void {
  const secondary = document.querySelector('#secondary');
  if (!secondary) return;

  panelEl = el('div', { class: 'dokhack-yt-panel' });

  const header = el('div', { class: 'dokhack-yt-panel-header' });
  header.append(el('span', { class: 'dokhack-yt-panel-title' }, '독해크 대본'));
  toggleBtn = el('button', {
    type: 'button', class: 'dokhack-yt-icon-btn', 'aria-label': '패널 접기',
  }) as HTMLButtonElement;
  toggleBtn.innerHTML = TOGGLE_ICON.collapse;
  toggleBtn.addEventListener('click', onToggleCollapse);
  pauseChip = el('button', {
    type: 'button', class: 'dokhack-yt-chip', 'aria-pressed': String(autoPauseLines),
    title: '켜면 자막 한 줄이 끝날 때마다 영상이 멈춰요',
  }) as HTMLButtonElement;
  pauseChip.textContent = '줄마다 멈춤';
  pauseChip.classList.toggle('dokhack-yt-chip-on', autoPauseLines);
  pauseChip.addEventListener('click', () => {
    const next = !autoPauseLines;
    setAutoPauseLines(next);
    ask({ type: 'saveSettings', patch: { autoPauseLines: next } }).catch(() => {});
  });
  meterEl = el('span', { class: 'dokhack-yt-meter', hidden: '' });
  header.append(el('span', { class: 'dokhack-yt-header-actions' }, ''));
  (header.lastChild as HTMLElement).append(meterEl, pauseChip, toggleBtn);
  panelEl.append(header);
  prewatchEl = el('div', { class: 'dokhack-yt-prewatch', hidden: '' });
  panelEl.append(prewatchEl);

  listEl = el('div', { class: 'dokhack-yt-panel-list' });
  listEl.addEventListener('scroll', onListScroll);

  lines.forEach((line, i) => {
    const row = el('div', { class: 'dokhack-yt-line' });
    const lineText = el('div', { class: 'dokhack-yt-line-text' });
    renderLineText(lineText, line.text);
    lineIndexOf.set(lineText, i);
    row.append(lineText);

    const meta = el('div', { class: 'dokhack-yt-line-meta' });
    meta.append(el('span', { class: 'dokhack-yt-ts' }, formatTime(line.startMs)));
    const jump = el('button', {
      type: 'button', class: 'dokhack-yt-icon-btn', 'aria-label': '이 구간으로 이동',
    }) as HTMLButtonElement;
    jump.innerHTML = PLAY_ICON;
    jump.addEventListener('click', () => { if (video) video.currentTime = line.startMs / 1000; });
    meta.append(jump);

    row.append(meta);
    listEl!.append(row);
  });
  panelEl.append(listEl);

  jumpBtn = el('button', { type: 'button', class: 'dokhack-yt-jump-current', hidden: '' }) as HTMLButtonElement;
  jumpBtn.textContent = '현재 자막으로 이동';
  jumpBtn.addEventListener('click', () => {
    userScrolledAway = false;
    jumpBtn!.hidden = true;
    scrollToCurrent(true);
  });
  panelEl.append(jumpBtn);

  secondary.prepend(panelEl);
}

// Caption sound cues ("[music]", "[Applause]", "(Laughter)") go in their own
// span, excluded from highlighting and counts (highlighter.ts's SKIP_CLASSES);
// the line's text is otherwise unchanged.
const CUE = /\[[^\]]*\]|\([A-Z][a-z]+\)/g;

function renderLineText(target: HTMLElement, text: string): void {
  const parts: Node[] = [];
  let at = 0;
  for (const m of text.matchAll(CUE)) {
    if (m.index! > at) parts.push(document.createTextNode(text.slice(at, m.index)));
    parts.push(el('span', { class: 'dokhack-yt-cue' }, m[0]));
    at = m.index! + m[0].length;
  }
  if (at < text.length) parts.push(document.createTextNode(text.slice(at)));
  target.replaceChildren(...parts);
}

function onToggleCollapse(): void {
  collapsed = !collapsed;
  panelEl?.classList.toggle('dokhack-yt-panel-collapsed', collapsed);
  if (toggleBtn) {
    toggleBtn.innerHTML = collapsed ? TOGGLE_ICON.expand : TOGGLE_ICON.collapse;
    toggleBtn.setAttribute('aria-label', collapsed ? '패널 펼치기' : '패널 접기');
  }
}

function onListScroll(): void {
  if (Date.now() < suppressScrollUntil) return;
  userScrolledAway = true;
  if (jumpBtn) jumpBtn.hidden = false;
}

function scrollToCurrent(smooth: boolean): void {
  if (!listEl || currentIndex < 0) return;
  const row = listEl.children[currentIndex] as HTMLElement | undefined;
  if (!row) return;
  // scrollIntoView fires its own 'scroll' events (several, if smooth) --
  // this window keeps those from being mistaken for the reader scrolling
  // away and re-showing "현재 자막으로 이동" right after we just jumped there.
  suppressScrollUntil = Date.now() + (smooth ? 500 : 100);
  row.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
}

// ---- subtitle bar ----------------------------------------------------------

function buildBar(): void {
  const player = document.querySelector('#movie_player') ?? document.querySelector('.html5-video-player');
  if (!player) return;
  barEl = el('div', { class: 'dokhack-yt-bar' });
  barTextEl = el('div', { class: 'dokhack-yt-bar-text' });
  barEl.append(barTextEl);
  barEl.style.display = 'none';
  player.append(barEl);
}

// ---- playback sync ----------------------------------------------------------

function onTimeUpdate(): void {
  if (!video || !lines.length) return;
  if (maybePauseAtLineEnd()) return; // keep showing the line that just ended
  const ms = video.currentTime * 1000;
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startMs <= ms) { idx = i; break; }
  }
  if (idx === currentIndex) return;
  currentIndex = idx;

  if (barTextEl && barEl) {
    const text = currentIndex >= 0 ? lines[currentIndex].text : '';
    if (barTextEl.textContent !== text) renderLineText(barTextEl, text);
    barEl.style.display = text ? '' : 'none';
    if (currentIndex >= 0) lineIndexOf.set(barTextEl, currentIndex);
  }

  if (listEl) {
    const rows = listEl.children;
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('dokhack-yt-line-current', i === currentIndex);
    if (!userScrolledAway) scrollToCurrent(true);
  }
}
