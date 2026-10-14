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

import { ask } from './messaging';

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

export function initYouTubeExtras(): void {
  if (location.hostname !== 'www.youtube.com') return;
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
  pollTimer = setInterval(checkNavigation, 1000);
  checkNavigation();
}

/** Mirrors content.ts's disable() -- e.g. the reader turned DokHack off for youtube.com. */
export function disableYouTubeExtras(): void {
  document.removeEventListener('yt-navigate-finish', checkNavigation);
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
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
// holding the same segment list -- one
// visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED", the other "..._HIDDEN"
// -- seen both as two panels sharing target-id
// "engagement-panel-searchable-transcript" (654 raw segments for 327 real
// lines) and, on the newer view-model UI, as target-id flipping between
// "PAmodern_transcript_view" and "null" across the two copies. Only a panel
// that's actually EXPANDED is trusted -- see harvestTranscript()'s comment
// on why *any* segments in the DOM, expanded or not, turned out unsafe.
function findExpandedTranscriptPanel(): Element | null {
  const panels = document.querySelectorAll(
    'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]',
  );
  for (const p of panels) {
    if (p.querySelector(SEGMENT_SELECTOR)) return p;
  }
  return null;
}

async function harvestTranscript(gen: number): Promise<TranscriptLine[] | null> {
  // Never trust whatever panel state exists at the start of a harvest --
  // confirmed live that requiring EXPANDED (see findExpandedTranscriptPanel)
  // still wasn't enough: on an in-page SPA navigation to a second video,
  // YouTube can carry the *same* transcript panel component over already
  // EXPANDED, still showing the FIRST video's real, genuine segments --
  // not hidden leftovers this time, but a live, visible, expanded panel
  // that simply hasn't been repopulated for the new video yet (especially
  // if the new video's captions take a moment to attach, or the panel
  // reuses cached data until something tells it not to). The original
  // "if already EXPANDED with segments, use it" fast path had no way to
  // tell that apart from a genuine same-video re-check, so it would read
  // and show the *previous* video's transcript under the new video's page
  // with no error. Force-closing unconditionally first, before ever
  // looking for an existing panel, guarantees the click below is always a
  // real fresh open for *this* navigation rather than a no-op read of
  // whatever was already sitting open.
  closeAnyOpenTranscriptPanels();

  let panel: Element | null = null;
  {
    // Both trigger controls and the segments they reveal can take several
    // seconds to exist -- confirmed live: on a real video, the description's
    // "Show transcript" button didn't exist in the DOM until ~9s after
    // navigation (YouTube's description/transcript UI renders well after
    // document_idle, when this content script runs). One combined deadline
    // covers waiting for a trigger, clicking it once it appears, and then
    // waiting for the panel it opens.
    const deadline = Date.now() + 20000;
    let clicked = false;
    while (Date.now() < deadline) {
      if (gen !== generation) return null;
      if (!clicked) {
        const chip = document.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Transcript"]');
        const showBtn = document.querySelector<HTMLButtonElement>('button[aria-label="Show transcript"]');
        if (chip || showBtn) { chip?.click(); showBtn?.click(); clicked = true; }
      }
      panel = findExpandedTranscriptPanel();
      if (panel) break;
      await sleep(300);
    }
  }
  if (!panel) {
    // We may have opened a panel above even though it never populated --
    // don't leave it stuck open with nothing of ours to show for it.
    closeAnyOpenTranscriptPanels();
    return null;
  }

  const out: TranscriptLine[] = [];
  panel.querySelectorAll(SEGMENT_SELECTOR).forEach((seg) => {
    const data = extractSegment(seg);
    if (data) out.push({ text: data.text, startMs: parseTimestamp(data.ts) });
  });

  // We render our own copy below, so close YouTube's.
  closeAnyOpenTranscriptPanels();

  return out.length ? out : null;
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
  header.append(el('span', { class: 'dokhack-yt-header-actions' }, ''));
  (header.lastChild as HTMLElement).append(pauseChip, toggleBtn);
  panelEl.append(header);

  listEl = el('div', { class: 'dokhack-yt-panel-list' });
  listEl.addEventListener('scroll', onListScroll);

  lines.forEach((line, i) => {
    const row = el('div', { class: 'dokhack-yt-line' });
    const lineText = el('div', { class: 'dokhack-yt-line-text' }, line.text);
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
    if (barTextEl.textContent !== text) barTextEl.textContent = text;
    barEl.style.display = text ? '' : 'none';
    if (currentIndex >= 0) lineIndexOf.set(barTextEl, currentIndex);
  }

  if (listEl) {
    const rows = listEl.children;
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('dokhack-yt-line-current', i === currentIndex);
    if (!userScrolledAway) scrollToCurrent(true);
  }
}
