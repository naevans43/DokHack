import type { CardDefinition, CardLanguage, KoreanCandidate } from './types';

// The card-editing dialog: opens when you choose to save a sentence. Lets you
// pick which meanings to keep (Korean, from the local KRDICT index, and/or
// English, from the dictionary lookup), edit the sentence (pulling in
// neighboring sentences for context), and choose which language(s) to keep.
// A centered modal (its own closed shadow root, like popup.ts) rather than
// the small anchored word card, since editing needs more room — and this
// same shape is meant to be reused later for YouTube subtitle mining.

const WINK_POS_KO: Record<string, string> = {
  NOUN: '명사', PROPN: '명사', VERB: '동사', AUX: '동사', ADJ: '형용사', ADV: '부사',
  PRON: '대명사', DET: '한정사', ADP: '전치사', CONJ: '접속사', CCONJ: '접속사',
  SCONJ: '접속사', NUM: '수사', PART: '조사', INTJ: '감탄사',
};

export const POS_KO: Record<string, string> = {
  noun: '명사', verb: '동사', adjective: '형용사', adverb: '부사',
  preposition: '전치사', conjunction: '접속사', pronoun: '대명사',
  interjection: '감탄사', determiner: '한정사', article: '관사',
};

export interface EditorData {
  lemma: string;
  surface: string;
  pos: string; // wink-nlp universal tag
  sentence: string;
  dictionaryDefs: { pos: string; text: string }[];
  koreanCandidates: KoreanCandidate[];
  // Roadmap item 11: non-null only when this card came from youtube.ts's
  // custom transcript panel/subtitle bar (never the native-panel fallback,
  // never a plain page) -- null hides the whole capture section.
  youtubeCapture: { startMs: number; endMs: number; initialFrameDataUrl: string | null } | null;
}

export interface EditorResult {
  sentence: string;
  definitions: CardDefinition[];
  language: CardLanguage;
}

export interface EditorHandlers {
  onExpand(direction: 'before' | 'after'): string | null;
  onCollapse(direction: 'before' | 'after'): string | null;
  onSpeak(): void;
  onCancel(): void;
  onSave(result: EditorResult): Promise<void>;
  // Roadmap item 11 -- only ever called/relevant when EditorData.youtubeCapture
  // was non-null at open() time. Capture state never flows through
  // EditorResult/onSave: recording is a multi-second, user-triggered action
  // independent of the final "카드 저장" click, so it's a separate channel.
  onRangeRecalc?(): { startMs: number; endMs: number } | null;
  onRecordAudio?(
    startMs: number,
    endMs: number,
    onProgress: (elapsedMs: number) => void,
  ): { promise: Promise<{ previewUrl: string }>; cancel: () => void };
  onRetakeFrame?(): Promise<string | null>;
  // Fired exactly once on EVERY close path (Save, Cancel, ✕, backdrop,
  // Escape) -- see CardEditor.close().
  onClose?(): void;
}

interface Candidate {
  id: string;
  lang: 'ko' | 'en';
  label: string;
  checked: boolean;
}

const CSS = `
:host { all: initial; }
.backdrop {
  position: fixed; inset: 0; z-index: 2147483647;
  background: rgba(20, 22, 30, 0.45);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  animation: fade 120ms ease-out;
}
@keyframes fade { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .backdrop { animation: none; } }

.dialog {
  --paper: #FCFCFA; --ink: #1D2230; --muted: #697083; --rule: #D5E3F3;
  --margin: #F1B9C0; --redpen: #C8102E; --unknown: #CFE1FF; --learning: #FFE872;

  width: 420px; max-width: 100%; max-height: calc(100vh - 48px); overflow-y: auto;
  box-sizing: border-box;
  padding: 18px 20px 18px 34px;
  background:
    linear-gradient(to right, transparent 19px, var(--margin) 19px, var(--margin) 20.5px, transparent 20.5px),
    var(--paper);
  color: var(--ink);
  border-radius: 8px;
  box-shadow: 0 20px 50px -16px rgba(29, 34, 48, 0.5);
  font: 14px/1.6 "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif;
  transform-origin: center;
  animation: pop 140ms ease-out;
}
@keyframes pop { from { opacity: 0; transform: scale(0.96); } }
@media (prefers-reduced-motion: reduce) { .dialog { animation: none; } }

.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.head-left { display: flex; align-items: center; gap: 8px; }
.lemma { font: 600 26px/1.15 "Iowan Old Style", Georgia, "Times New Roman", serif; overflow-wrap: anywhere; }
.speak {
  flex: none; width: 28px; height: 28px; display: grid; place-items: center;
  border: 1px solid #C9CFDA; border-radius: 50%; background: transparent; color: var(--ink); cursor: pointer;
}
.speak:hover { background: #EEF1F6; }
.close { all: unset; cursor: pointer; color: var(--muted); font-size: 16px; padding: 4px; line-height: 1; }
.close:hover { color: var(--ink); }
.sub { color: var(--muted); font-size: 13px; margin: 2px 0 14px; }

h3 { margin: 0 0 6px; font-size: 13px; font-weight: 700; }
.hint { font-weight: 400; color: var(--muted); }
section { margin-bottom: 16px; }

.defs-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.def-item {
  display: flex; align-items: baseline; gap: 8px; cursor: pointer;
  padding: 4px 6px; border-radius: 4px;
}
.def-item:hover { background: #F1F3F8; }
.def-item input { margin: 0; flex: none; }
.def-item .text { flex: 1; }
.def-item[data-lang="ko"] .text { color: var(--redpen); font-weight: 700; }
.empty-defs { color: var(--muted); margin: 0; }

.sentence-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.expand-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
.expand-buttons button {
  font: inherit; font-size: 12px; padding: 3px 8px; cursor: pointer;
  border: 1px solid #C9CFDA; border-radius: 999px; background: transparent; color: var(--ink);
}
.expand-buttons button:disabled { color: var(--muted); cursor: default; opacity: 0.5; }
.expand-buttons .collapse { color: var(--muted); }
.sentence-input {
  width: 100%; box-sizing: border-box; margin-top: 6px; padding: 8px 10px;
  border: 1px solid var(--rule); border-radius: 4px; background: #fff; color: var(--ink);
  font: 16px/1.6 "Iowan Old Style", Georgia, "Times New Roman", serif; resize: vertical; min-height: 4.8em;
}

.frame-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.frame-preview { width: 120px; height: 68px; object-fit: cover; border-radius: 4px; border: 1px solid var(--rule); background: #000; }
.frame-preview:not([src]) { visibility: hidden; }
.retake-frame, .clip-adjust {
  font: inherit; font-size: 12px; padding: 3px 8px; cursor: pointer;
  border: 1px solid #C9CFDA; border-radius: 999px; background: transparent; color: var(--ink);
}
.retake-frame:disabled, .clip-adjust:disabled { color: var(--muted); cursor: default; opacity: 0.5; }
.clip-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 13px; margin-bottom: 8px; }
.clip-range { font-weight: 600; }
.clip-stale { color: var(--redpen); font-size: 12px; }
.clip-actions { display: flex; align-items: center; gap: 8px; }
.record-btn, .cancel-record-btn { font: inherit; font-weight: 700; padding: 6px 14px; cursor: pointer; border: 0; border-radius: 4px; background: var(--ink); color: #fff; }
.cancel-record-btn { background: transparent; color: var(--ink); border: 1px solid #C9CFDA; font-weight: 400; }
.record-btn:disabled { opacity: 0.5; cursor: default; }
.record-progress { flex: 1; height: 4px; background: var(--rule); border-radius: 2px; overflow: hidden; }
.record-progress-bar { height: 100%; width: 0%; background: var(--redpen); transition: width 100ms linear; }
.clip-audio { height: 28px; }
.capture-error { margin: 6px 0 0; color: var(--redpen); font-size: 12px; }

.lang-row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; }
.lang-row label { display: flex; align-items: center; gap: 4px; cursor: pointer; }

.save-error { margin: 0 auto 0 0; color: var(--redpen); font-size: 13px; }
.actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 4px; }
.cancel { font: inherit; padding: 6px 14px; cursor: pointer; border: 1px solid #C9CFDA; border-radius: 4px; background: transparent; color: var(--ink); }
.confirm { font: inherit; font-weight: 700; padding: 6px 14px; cursor: pointer; border: 0; border-radius: 4px; background: var(--ink); color: #fff; }
.confirm:disabled { background: transparent; color: var(--muted); cursor: default; }

button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid #3B6FD4; outline-offset: 2px; }
`;

export class CardEditor {
  readonly host: HTMLElement;
  private root: ShadowRoot;
  private backdrop?: HTMLElement;
  private dialog?: HTMLElement;
  private handlers?: EditorHandlers;
  private candidates: Candidate[] = [];
  private language: CardLanguage = 'both';
  private nextId = 0;
  private recording = false; // roadmap item 11 -- true while a capture is in flight

  constructor() {
    this.host = document.createElement('dokhack-editor');
    this.root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.root.append(style);
  }

  get isOpen(): boolean { return !!this.dialog; }
  get isRecording(): boolean { return this.recording; }

  open(data: EditorData, handlers: EditorHandlers): void {
    this.close();
    this.handlers = handlers;
    this.candidates = [];
    this.language = 'both';
    this.recording = false;
    if (!this.host.isConnected) document.documentElement.append(this.host);

    const backdrop = el('div', { class: 'backdrop' });
    backdrop.addEventListener('mousedown', (e) => { if (this.recording) return; if (e.target === backdrop) handlers.onCancel(); });

    const dialog = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '단어 카드 만들기' });
    dialog.addEventListener('mousedown', (e) => e.stopPropagation());
    dialog.innerHTML = `
      <div class="head">
        <div class="head-left">
          <span class="lemma"></span>
          <button class="speak" aria-label="발음 듣기" title="발음 듣기">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1.5v9l8-4.5z" fill="currentColor"/></svg>
          </button>
        </div>
        <button class="close" aria-label="닫기">✕</button>
      </div>
      <p class="sub"><span class="pos"></span></p>

      <section>
        <h3>뜻 <span class="hint">담을 항목을 고르세요</span></h3>
        <ul class="defs-list"></ul>
      </section>

      <section>
        <div class="sentence-head">
          <h3>문장</h3>
          <div class="expand-buttons">
            <button type="button" class="collapse-before collapse" disabled>− 앞 문장</button>
            <button type="button" class="expand-before">+ 앞 문장</button>
            <button type="button" class="expand-after">+ 뒤 문장</button>
            <button type="button" class="collapse-after collapse" disabled>− 뒤 문장</button>
          </div>
        </div>
        <textarea class="sentence-input"></textarea>
      </section>

      <section class="capture-section" hidden>
        <h3>영상 캡처 <span class="hint">이 구간의 소리와 화면</span></h3>
        <div class="frame-row">
          <img class="frame-preview" alt="장면 캡처" />
          <button type="button" class="retake-frame">다시 캡처</button>
        </div>
        <div class="clip-row">
          <span class="clip-range"></span>
          <button type="button" class="clip-adjust" data-which="start" data-dir="-1">시작 −0.5s</button>
          <button type="button" class="clip-adjust" data-which="start" data-dir="1">시작 +0.5s</button>
          <button type="button" class="clip-adjust" data-which="end" data-dir="-1">끝 −0.5s</button>
          <button type="button" class="clip-adjust" data-which="end" data-dir="1">끝 +0.5s</button>
          <span class="clip-stale" hidden>범위가 바뀌었어요 — 다시 녹음하세요</span>
        </div>
        <div class="clip-actions">
          <button type="button" class="record-btn">녹음</button>
          <button type="button" class="cancel-record-btn" hidden>중단</button>
          <div class="record-progress" hidden><div class="record-progress-bar"></div></div>
          <audio class="clip-audio" controls hidden></audio>
        </div>
        <p class="capture-error" hidden></p>
      </section>

      <section class="lang-row">
        <span>표시 언어</span>
        <label><input type="radio" name="lang" value="ko" /> 한국어</label>
        <label><input type="radio" name="lang" value="en" /> 영어</label>
        <label><input type="radio" name="lang" value="both" checked /> 둘 다</label>
      </section>

      <div class="actions">
        <p class="save-error" hidden></p>
        <button type="button" class="cancel">취소</button>
        <button type="button" class="confirm">카드 저장</button>
      </div>`;

    q(dialog, '.lemma').textContent = data.lemma;
    q(dialog, '.pos').textContent = WINK_POS_KO[data.pos] ?? '';
    (q(dialog, '.sentence-input') as HTMLTextAreaElement).value = data.sentence;

    q(dialog, '.speak').addEventListener('click', () => handlers.onSpeak());
    q(dialog, '.close').addEventListener('click', () => handlers.onCancel());
    q(dialog, '.cancel').addEventListener('click', () => handlers.onCancel());
    q(dialog, '.confirm').addEventListener('click', () => this.confirm());

    dialog.querySelectorAll<HTMLInputElement>('input[name="lang"]').forEach((r) => {
      r.addEventListener('change', () => {
        if (r.checked) { this.language = r.value as CardLanguage; this.renderDefs(); }
      });
    });

    // Roadmap item 11: the current clip boundary, shared by the expand/
    // collapse wiring below (which recomputes it on every context change)
    // and the capture-section wiring further down (which records/adjusts
    // it). Declared here, not inside the capture-section block, since both
    // need it and the capture section isn't built at all when
    // data.youtubeCapture is null.
    let range = data.youtubeCapture ? { startMs: data.youtubeCapture.startMs, endMs: data.youtubeCapture.endMs } : null;
    let haveClip = false;
    const rangeLabel = q(dialog, '.clip-range');
    const staleLabel = q(dialog, '.clip-stale');
    const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const renderRange = () => { if (range) rangeLabel.textContent = `${fmt(range.startMs)} – ${fmt(range.endMs)}`; };
    const recalcRange = () => {
      if (!range || !handlers.onRangeRecalc) return;
      const next = handlers.onRangeRecalc();
      if (next) { range = next; renderRange(); if (haveClip) staleLabel.hidden = false; }
    };

    const expandBtn = { before: q(dialog, '.expand-before') as HTMLButtonElement, after: q(dialog, '.expand-after') as HTMLButtonElement };
    const collapseBtn = { before: q(dialog, '.collapse-before') as HTMLButtonElement, after: q(dialog, '.collapse-after') as HTMLButtonElement };
    (['before', 'after'] as const).forEach((dir) => {
      expandBtn[dir].addEventListener('click', () => {
        const extra = handlers.onExpand(dir);
        if (extra === null) { expandBtn[dir].disabled = true; return; }
        const ta = q(dialog, '.sentence-input') as HTMLTextAreaElement;
        ta.value = dir === 'before' ? `${extra} ${ta.value}` : `${ta.value} ${extra}`;
        collapseBtn[dir].disabled = false;
        recalcRange();
      });
      collapseBtn[dir].addEventListener('click', () => {
        const removed = handlers.onCollapse(dir);
        if (removed === null) { collapseBtn[dir].disabled = true; return; }
        const ta = q(dialog, '.sentence-input') as HTMLTextAreaElement;
        if (dir === 'before' && ta.value.startsWith(`${removed} `)) {
          ta.value = ta.value.slice(removed.length + 1);
        } else if (dir === 'after' && ta.value.endsWith(` ${removed}`)) {
          ta.value = ta.value.slice(0, ta.value.length - removed.length - 1);
        }
        expandBtn[dir].disabled = false; // freed up a sentence to expand into again
        recalcRange();
      });
    });

    if (data.youtubeCapture && handlers.onRecordAudio) {
      (q(dialog, '.capture-section') as HTMLElement).hidden = false;
      renderRange();
      const frameImg = q(dialog, '.frame-preview') as HTMLImageElement;
      if (data.youtubeCapture.initialFrameDataUrl) frameImg.src = data.youtubeCapture.initialFrameDataUrl;

      q(dialog, '.retake-frame').addEventListener('click', async () => {
        const url = await handlers.onRetakeFrame?.();
        if (url) frameImg.src = url;
      });

      dialog.querySelectorAll<HTMLButtonElement>('.clip-adjust').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!range) return;
          const delta = Number(btn.dataset.dir) * 500;
          if (btn.dataset.which === 'start') range.startMs = Math.max(0, range.startMs + delta);
          else range.endMs = range.endMs + delta;
          if (range.endMs - range.startMs < 300) {
            if (btn.dataset.which === 'start') range.startMs = range.endMs - 300;
            else range.endMs = range.startMs + 300;
          }
          renderRange();
          if (haveClip) staleLabel.hidden = false;
        });
      });

      const recordBtn = q(dialog, '.record-btn') as HTMLButtonElement;
      const stopBtn = q(dialog, '.cancel-record-btn') as HTMLButtonElement;
      const progress = q(dialog, '.record-progress') as HTMLElement;
      const progressBar = q(dialog, '.record-progress-bar') as HTMLElement;
      const audioEl = q(dialog, '.clip-audio') as HTMLAudioElement;
      const errorEl = q(dialog, '.capture-error');
      let cancelRecording: (() => void) | null = null;

      const setRecordingUi = (active: boolean) => {
        this.recording = active;
        recordBtn.disabled = active;
        stopBtn.hidden = !active;
        progress.hidden = !active;
        dialog.querySelectorAll<HTMLButtonElement>('.clip-adjust').forEach((b) => { b.disabled = active; });
        (q(dialog, '.cancel') as HTMLButtonElement).disabled = active;
        (q(dialog, '.close') as HTMLButtonElement).disabled = active;
        (q(dialog, '.confirm') as HTMLButtonElement).disabled = active;
      };

      recordBtn.addEventListener('click', () => {
        if (!range || !handlers.onRecordAudio) return;
        errorEl.hidden = true;
        staleLabel.hidden = true;
        setRecordingUi(true);
        progressBar.style.width = '0%';
        const total = range.endMs - range.startMs;
        const handle = handlers.onRecordAudio(range.startMs, range.endMs, (elapsed) => {
          progressBar.style.width = `${Math.min(100, (elapsed / total) * 100)}%`;
        });
        cancelRecording = handle.cancel;
        handle.promise
          .then((res) => {
            haveClip = true;
            audioEl.src = res.previewUrl;
            audioEl.hidden = false;
            recordBtn.textContent = '다시 녹음';
          })
          .catch((err) => {
            if (String((err as Error)?.message) !== 'dokhack-capture-cancelled') {
              errorEl.textContent = '녹음에 실패했습니다. 다시 시도해 주세요.';
              errorEl.hidden = false;
            }
          })
          .finally(() => { cancelRecording = null; setRecordingUi(false); });
      });
      stopBtn.addEventListener('click', () => cancelRecording?.());
    }

    backdrop.append(dialog);
    this.root.append(backdrop);
    this.backdrop = backdrop;
    this.dialog = dialog;

    // Top-ranked Korean candidate is pre-checked (it's the "best guess," like
    // the old AI gloss was); English dictionary defs start unchecked — pick
    // them in if you want more detail.
    data.koreanCandidates.forEach((c, i) => this.upsertCandidate(`ko-${i}`, 'ko', c.ko, i === 0));
    data.dictionaryDefs.forEach((d, i) => {
      this.upsertCandidate(`dict-${i}`, 'en', `${POS_KO[d.pos] ?? d.pos}: ${d.text}`);
    });
    this.renderDefs();
    (q(dialog, '.sentence-input') as HTMLTextAreaElement).focus();
  }

  close(): void {
    if (!this.dialog) return; // already closed -- avoids double-firing onClose
    this.handlers?.onClose?.();
    this.recording = false;
    this.backdrop?.remove();
    this.backdrop = undefined;
    this.dialog = undefined;
    this.handlers = undefined;
  }

  /** Merge in English defs that arrive after the dialog is already open. */
  setDictionaryDefs(defs: { pos: string; text: string }[]): void {
    if (!this.dialog) return;
    defs.forEach((d, i) => this.upsertCandidate(`dict-${i}`, 'en', `${POS_KO[d.pos] ?? d.pos}: ${d.text}`));
    this.renderDefs();
  }

  /** Merge in Korean candidates that arrive after the dialog is already open. */
  setKoreanCandidates(candidates: KoreanCandidate[]): void {
    if (!this.dialog) return;
    const hadNone = !this.candidates.some((c) => c.lang === 'ko');
    candidates.forEach((c, i) => this.upsertCandidate(`ko-${i}`, 'ko', c.ko, hadNone && i === 0));
    this.renderDefs();
  }

  private upsertCandidate(id: string, lang: 'ko' | 'en', label: string, defaultChecked = false): void {
    if (this.candidates.some((c) => c.id === id)) return;
    this.candidates.push({ id: `${id}-${this.nextId++}`, lang, label, checked: defaultChecked });
  }

  private renderDefs(): void {
    if (!this.dialog) return;
    const list = q(this.dialog, '.defs-list');
    list.replaceChildren();
    const visible = this.candidates.filter((c) => this.language === 'both' || c.lang === this.language);
    if (!visible.length) {
      list.append(el('p', { class: 'empty-defs' }, '표시할 뜻이 없습니다. 문장만 저장할 수 있어요.'));
      return;
    }
    for (const c of visible) {
      const li = el('li', { class: 'def-item', 'data-lang': c.lang });
      const checkbox = el('input', { type: 'checkbox' }) as HTMLInputElement;
      checkbox.checked = c.checked;
      checkbox.addEventListener('change', () => { c.checked = checkbox.checked; });
      const label = el('label', { class: 'text' }, c.label);
      li.append(checkbox, label);
      li.addEventListener('click', (e) => {
        if (e.target !== checkbox) { checkbox.checked = !checkbox.checked; c.checked = checkbox.checked; }
      });
      list.append(li);
    }
  }

  private async confirm(): Promise<void> {
    if (!this.dialog || !this.handlers) return;
    const btn = q(this.dialog, '.confirm') as HTMLButtonElement;
    const error = q(this.dialog, '.save-error');
    error.hidden = true;
    btn.disabled = true;
    const sentence = (q(this.dialog, '.sentence-input') as HTMLTextAreaElement).value.trim();
    const definitions: CardDefinition[] = this.candidates
      .filter((c) => c.checked && (this.language === 'both' || c.lang === this.language))
      .map((c) => ({ text: c.label, lang: c.lang }));
    try {
      await this.handlers.onSave({ sentence, definitions, language: this.language });
    } catch {
      btn.disabled = false;
      error.textContent = '저장하지 못했습니다. 다시 시도해 주세요.';
      error.hidden = false;
    }
  }
}

function el(tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function q(root: ParentNode, sel: string): HTMLElement {
  return root.querySelector(sel) as HTMLElement;
}
