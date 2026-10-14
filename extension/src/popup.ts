import type { KoreanCandidate, LookupResult, Token, WordStatus } from './types';

// The word card that opens when you click a word. It lives in a closed
// shadow root so page CSS can't restyle it and page scripts can't read it.
//
// Visual idea: a page from a 단어장 (vocab notebook) — blue ruled paper, a
// red margin line, and the Korean meaning written in red pen, the ink
// Korean students cover with a red sheet to self-test.

const POS_KO: Record<string, string> = {
  noun: '명사', verb: '동사', adjective: '형용사', adverb: '부사',
  preposition: '전치사', conjunction: '접속사', pronoun: '대명사',
  interjection: '감탄사', determiner: '한정사', article: '관사',
};

const STATUSES: { value: Exclude<WordStatus, 'ignored'>; label: string; key: string }[] = [
  { value: 'unknown', label: '모름', key: '1' },
  { value: 'seen', label: '봤어요', key: '2' },
  { value: 'learning', label: '학습 중', key: '3' },
  { value: 'known', label: '알아요', key: '4' },
];

const CSS = `
:host { all: initial; }
.card {
  --paper: #FCFCFA;
  --ink: #1D2230;
  --muted: #697083;
  --rule: #D5E3F3;
  --margin: #F1B9C0;
  --redpen: #C8102E;
  --unknown: #CFE1FF;
  --learning: #FFE872;

  position: fixed;
  z-index: 2147483647;
  width: 320px;
  max-width: calc(100vw - 16px);
  box-sizing: border-box;
  padding: 14px 16px 12px 30px;
  background:
    linear-gradient(to right, transparent 17px, var(--margin) 17px, var(--margin) 18.5px, transparent 18.5px),
    var(--paper);
  color: var(--ink);
  border: 1px solid #C9CFDA;
  border-radius: 6px;
  box-shadow: 0 10px 30px -12px rgba(29, 34, 48, 0.35);
  font: 14px/1.6 "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif;
  transform-origin: top left;
  animation: open 120ms ease-out;
}
@keyframes open { from { opacity: 0; transform: scale(0.97); } }
@media (prefers-reduced-motion: reduce) { .card { animation: none; } }

.head { display: flex; align-items: center; gap: 8px; }
.lemma {
  font: 600 26px/1.15 "Iowan Old Style", Georgia, "Times New Roman", serif;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.speak {
  flex: none; width: 30px; height: 30px; margin-left: auto;
  display: grid; place-items: center;
  border: 1px solid #C9CFDA; border-radius: 50%;
  background: transparent; color: var(--ink); cursor: pointer;
}
.speak:hover { background: #EEF1F6; }
.sub { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); font-size: 13px; margin-top: 2px; }
.form:empty { display: none; }

.gloss {
  margin: 8px 0 0; padding: 6px 0; color: var(--redpen); font-size: 18px; font-weight: 700;
  border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule);
}
.gloss:empty { display: none; border: 0; padding: 0; margin: 0; }

.false-friend {
  margin: 10px 0 0; padding: 6px 8px; border-left: 3px solid var(--redpen); background: #FDF1F3;
  font-size: 13px; line-height: 1.5; color: var(--ink);
}
.false-friend[hidden] { display: none; }
.false-friend strong { color: var(--redpen); margin-right: 4px; }

.defs { margin: 10px 0; padding: 0 0 0 18px; color: var(--muted); font-size: 13px; line-height: 1.5; }
.defs li { margin: 2px 0; }
.defs em { font-style: normal; color: var(--ink); margin-right: 4px; }

.status { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.status button {
  font: inherit; font-size: 13px; padding: 6px 0; cursor: pointer;
  border: 1px solid #C9CFDA; border-radius: 4px; background: transparent; color: var(--ink);
}
.status button kbd { font: inherit; font-size: 11px; color: var(--muted); margin-left: 4px; }
.status button[aria-pressed="true"][data-v="unknown"] { background: var(--unknown); border-color: #8FB5F2; }
.status button[aria-pressed="true"][data-v="seen"] { background: #FFD9B3; border-color: #E0A060; }
.status button[aria-pressed="true"][data-v="learning"] { background: var(--learning); border-color: #D9B92C; }
.status button[aria-pressed="true"][data-v="known"] { border-color: var(--ink); font-weight: 700; }

.actions { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
.ignore { all: unset; font-size: 13px; color: var(--muted); cursor: pointer; }
.ignore:hover { color: var(--ink); text-decoration: underline; }
.save {
  font: inherit; font-weight: 700; padding: 6px 14px; cursor: pointer;
  border: 0; border-radius: 4px; background: var(--ink); color: #fff;
}

button:focus-visible { outline: 2px solid #3B6FD4; outline-offset: 2px; }
`;

export interface PopupHandlers {
  onStatus(status: WordStatus): void;
  onOpenEditor(): void;
  onSpeak(): void;
}

export class WordPopup {
  readonly host: HTMLElement;
  private root: ShadowRoot;
  private card?: HTMLElement;
  private anchor?: Range;
  current?: Token;

  constructor() {
    this.host = document.createElement('dokhack-popup');
    this.root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.root.append(style);
    window.addEventListener('scroll', () => this.reposition(), { passive: true, capture: true });
    window.addEventListener('resize', () => this.reposition(), { passive: true });
  }

  get isOpen(): boolean { return !!this.card; }

  open(anchor: Range, token: Token, status: WordStatus, handlers: PopupHandlers): void {
    this.close();
    this.anchor = anchor;
    this.current = token;
    if (!this.host.isConnected) document.documentElement.append(this.host);

    const card = el('div', { class: 'card', role: 'dialog', 'aria-label': `${token.lemma} 단어 정보` });
    card.innerHTML = `
      <div class="head">
        <span class="lemma"></span>
        <button class="speak" aria-label="발음 듣기" title="발음 듣기">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1.5v9l8-4.5z" fill="currentColor"/></svg>
        </button>
      </div>
      <div class="sub"><span class="form"></span></div>
      <p class="gloss"></p>
      <p class="false-friend" hidden><strong>콩글리시 주의</strong><span></span></p>
      <ol class="defs"></ol>
      <div class="status" role="group" aria-label="단어 상태"></div>
      <div class="actions">
        <button class="ignore">이 단어 무시하기</button>
        <button class="save">카드 만들기</button>
      </div>`;
    q(card, '.lemma').textContent = token.lemma;
    if (token.surface.toLowerCase() !== token.lemma) {
      q(card, '.form').textContent = `${token.surface}의 기본형`;
    }

    const statusBox = q(card, '.status');
    for (const s of STATUSES) {
      const b = el('button', { 'data-v': s.value, 'aria-pressed': 'false' });
      b.append(s.label, el('kbd', {}, s.key));
      b.addEventListener('click', () => handlers.onStatus(s.value));
      statusBox.append(b);
    }
    q(card, '.speak').addEventListener('click', () => handlers.onSpeak());
    q(card, '.ignore').addEventListener('click', () => handlers.onStatus('ignored'));
    q(card, '.save').addEventListener('click', () => handlers.onOpenEditor());

    this.card = card;
    this.root.append(card);
    this.setStatus(status);
    this.reposition();
  }

  close(): void {
    this.card?.remove();
    this.card = undefined;
    this.anchor = undefined;
    this.current = undefined;
  }

  setStatus(status: WordStatus): void {
    this.card?.querySelectorAll<HTMLButtonElement>('.status button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.v === status));
    });
  }

  /** The single best-guess Korean gloss, if the local KRDICT index had one. */
  setKoreanGloss(candidates: KoreanCandidate[]): void {
    if (!this.card) return;
    q(this.card, '.gloss').textContent = candidates[0]?.ko ?? '';
    this.reposition();
  }

  setLookup(r: LookupResult | null): void {
    if (!this.card) return;
    const list = q(this.card, '.defs');
    list.replaceChildren();
    for (const d of r?.definitions ?? []) {
      const li = el('li');
      li.append(el('em', {}, POS_KO[d.pos] ?? d.pos), d.text);
      list.append(li);
    }
    list.hidden = !list.childElementCount;
    const ff = q(this.card, '.false-friend');
    ff.hidden = !r?.falseFriend;
    ff.lastElementChild!.textContent = r?.falseFriend ?? '';
    this.reposition();
  }

  private reposition(): void {
    if (!this.card || !this.anchor) return;
    const rect = this.anchor.getBoundingClientRect();
    if (!rect.width && !rect.height) return this.close(); // anchor left the DOM
    const w = this.card.offsetWidth;
    const h = this.card.offsetHeight;
    const gap = 8;
    let top = rect.bottom + gap;
    if (top + h > innerHeight - gap && rect.top - h - gap > gap) top = rect.top - h - gap;
    const left = Math.min(Math.max(gap, rect.left), innerWidth - w - gap);
    this.card.style.top = `${top}px`;
    this.card.style.left = `${left}px`;
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
