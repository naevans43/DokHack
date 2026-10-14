import { lookupKorean } from '../../extension/src/krdict';
import { tokenize } from '../../extension/src/nlp';
import { lookupEnglish } from '../../extension/src/wordnet';
import type { KoreanCandidate, LookupResult, Token } from '../../extension/src/types';
import { apiFetch } from './supabase';
import { renderNav, requireSession } from './nav';
import { fetchVocab, markWord, type WordMap, type WordStatus } from './stats-api';

// The paste-text reader: paste any English text, see which words you know, tap
// a word for its meaning, mark it, or turn its sentence into a card -- the
// extension's core loop on a phone, where there's no extension. Reuses the
// extension's own tokenizer and dictionary modules (so word forms, phrasal
// verbs and meanings come out the same), loading its ~23 MB of dictionary data
// only when a word is first tapped. Word marks are queued for the extension
// (vocab_inbox) and applied on its next 모두 동기화; cards go straight to the
// same table the extension syncs to.

const MAX_CHARS = 20_000;
const POS_KO: Record<string, string> = {
  noun: '명사', verb: '동사', adjective: '형용사', adverb: '부사', preposition: '전치사',
  conjunction: '접속사', pronoun: '대명사', interjection: '감탄사', determiner: '한정사', article: '관사',
};
const STATUSES: { value: Exclude<WordStatus, 'ignored'>; label: string }[] = [
  { value: 'unknown', label: '모름' },
  { value: 'seen', label: '봤어요' },
  { value: 'learning', label: '학습 중' },
  { value: 'known', label: '알아요' },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let words: WordMap = {};
let paragraphs: { text: string; tokens: Token[] }[] = [];

// ---- rendering ---------------------------------------------------------------

const statusOf = (lemma: string): WordStatus => words[lemma] ?? 'unknown';

function paint(span: HTMLElement): void {
  span.className = `w s-${statusOf(span.dataset.lemma!)}`;
}

function renderDoc(): void {
  const doc = $('doc');
  doc.replaceChildren(
    ...paragraphs.map((p, pi) => {
      const el = document.createElement('p');
      let at = 0;
      for (const t of p.tokens) {
        if (t.start > at) el.append(p.text.slice(at, t.start));
        const span = document.createElement('span');
        span.textContent = p.text.slice(t.start, t.end);
        span.dataset.lemma = t.lemma;
        span.dataset.p = String(pi);
        span.dataset.t = String(p.tokens.indexOf(t));
        paint(span);
        el.append(span);
        at = t.end;
      }
      if (at < p.text.length) el.append(p.text.slice(at));
      return el;
    }),
  );
  updateCoverage();
}

/** "You know N% of this text" -- occurrences, ignored words left out of both sides. */
function updateCoverage(): void {
  let total = 0, known = 0, unknown = 0;
  for (const p of paragraphs) {
    for (const t of p.tokens) {
      const s = statusOf(t.lemma);
      if (s === 'ignored') continue;
      total++;
      if (s === 'known') known++; else unknown++;
    }
  }
  const box = $('coverage');
  box.hidden = total === 0;
  if (!total) return;
  const pct = Math.round((known / total) * 100);
  ($('coverageBar').firstElementChild as HTMLElement).style.width = `${pct}%`;
  $('coverageText').textContent = `이 글의 단어 ${pct}%를 알아요 · 모르는 단어 ${unknown}개 (전체 ${total}개)`;
}

function repaint(lemma: string): void {
  document.querySelectorAll<HTMLElement>('#doc .w').forEach((s) => { if (s.dataset.lemma === lemma) paint(s); });
  updateCoverage();
}

// ---- marking words -------------------------------------------------------------

async function setStatus(lemma: string, status: WordStatus): Promise<void> {
  if (status === 'unknown') delete words[lemma];
  else words[lemma] = status;
  repaint(lemma);
  try {
    await markWord(lemma, status);
  } catch {
    $('markNote').hidden = false; // saved for this page only
  }
}

// ---- the word sheet ----------------------------------------------------------------

interface Open { lemma: string; token: Token; sentence: string; targetStart: number }
let open: Open | null = null;
let openId = 0;

function sentenceAround(text: string, at: number): { sentence: string; start: number } {
  const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
  for (const s of seg.segment(text)) {
    if (at >= s.index && at < s.index + s.segment.length) {
      const lead = s.segment.length - s.segment.trimStart().length;
      return { sentence: s.segment.trim(), start: s.index + lead };
    }
  }
  return { sentence: text.trim(), start: 0 };
}

function el(tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderStatusButtons(): void {
  const box = $('sheetStatus');
  box.replaceChildren(
    ...STATUSES.map((s) => {
      const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(open && statusOf(open.lemma) === s.value) }, s.label);
      b.classList.toggle('on', !!open && statusOf(open.lemma) === s.value);
      b.addEventListener('click', () => { if (open) setStatus(open.lemma, s.value).then(renderStatusButtons); });
      return b;
    }),
  );
}

function showCandidates(korean: KoreanCandidate[], english: LookupResult | null): void {
  const list = $('sheetDefs');
  list.replaceChildren();
  const rows: { text: string; lang: 'ko' | 'en'; checked: boolean }[] = [];
  korean.slice(0, 3).forEach((k, i) => rows.push({ text: k.ko, lang: 'ko', checked: i === 0 }));
  (english?.definitions ?? []).slice(0, 3).forEach((d, i) => rows.push({ text: `${POS_KO[d.pos] ?? d.pos}: ${d.text}`, lang: 'en', checked: i === 0 }));
  if (!rows.length) list.append(el('p', { class: 'muted' }, '사전에서 뜻을 찾지 못했어요.'));
  for (const r of rows) {
    const label = el('label', { class: `def-row ${r.lang}` });
    const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = r.checked;
    box.dataset.lang = r.lang;
    box.dataset.text = r.text;
    label.append(box, el('span', {}, r.text));
    list.append(label);
  }
  ($('saveCard') as HTMLButtonElement).disabled = false;
}

async function openWord(span: HTMLElement): Promise<void> {
  const p = paragraphs[Number(span.dataset.p)];
  const token = p.tokens[Number(span.dataset.t)];
  const { sentence, start } = sentenceAround(p.text, token.start);
  open = { lemma: token.lemma, token, sentence, targetStart: token.start - start };
  const id = ++openId;

  $('sheet').hidden = false;
  $('sheetLemma').textContent = token.lemma;
  $('sheetForm').textContent = token.surface.toLowerCase() !== token.lemma ? `${token.surface}의 기본형` : '';
  $('sheetGloss').textContent = '';
  $('sheetDefs').replaceChildren(el('p', { class: 'muted' }, '사전을 불러오는 중이에요…'));
  $('cardNote').textContent = '';
  ($('saveCard') as HTMLButtonElement).disabled = true;

  // Looking a word up marks it seen, but never overrides a status already chosen.
  if (statusOf(token.lemma) === 'unknown') setStatus(token.lemma, 'seen').then(renderStatusButtons);
  renderStatusButtons();

  const [korean, english] = await Promise.all([
    lookupKorean(token.lemma, sentence, token.pos).catch(() => [] as KoreanCandidate[]),
    lookupEnglish(token.lemma, sentence, token.pos).catch(() => null),
  ]);
  if (id !== openId) return; // moved on to another word
  $('sheetGloss').textContent = korean[0]?.ko ?? '';
  showCandidates(korean, english);
}

async function saveCard(): Promise<void> {
  if (!open) return;
  const defs = [...document.querySelectorAll<HTMLInputElement>('#sheetDefs input:checked')].map((b) => ({
    text: b.dataset.text!, lang: b.dataset.lang as 'ko' | 'en',
  }));
  const note = $('cardNote');
  const btn = $('saveCard') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const res = await apiFetch('/rest/v1/cards', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        lemma: open.lemma, surface: open.token.surface, sentence: open.sentence, target_start: open.targetStart,
        definitions: defs, url: `${location.origin}/read.html`, title: '붙여넣은 글',
      }),
    });
    if (!res.ok) throw new Error(String(res.status));
    note.textContent = '카드를 저장했어요. 복습 탭에서 볼 수 있어요.';
    // Saving a card implies you're learning the word (same rule as the extension).
    if (['unknown', 'seen'].includes(statusOf(open.lemma))) setStatus(open.lemma, 'learning').then(renderStatusButtons);
  } catch {
    note.textContent = '카드를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.';
    btn.disabled = false;
  }
}

function closeSheet(): void {
  $('sheet').hidden = true;
  open = null;
  openId++;
}

// ---- the page ------------------------------------------------------------------------

async function analyze(): Promise<void> {
  const area = $<HTMLTextAreaElement>('paste');
  let text = area.value.replace(/\r\n/g, '\n').trim();
  const note = $('analyzeNote');
  note.hidden = true;
  if (!text) { note.textContent = '분석할 영어 글을 먼저 붙여넣어 주세요.'; note.hidden = false; return; }
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    note.textContent = `글이 길어서 앞부분 ${MAX_CHARS.toLocaleString()}자만 분석했어요.`;
    note.hidden = false;
  }
  const btn = $<HTMLButtonElement>('analyzeBtn');
  btn.disabled = true;
  btn.textContent = '분석 중…';
  try {
    paragraphs = [];
    for (const raw of text.split(/\n+/)) {
      const t = raw.trim();
      if (t) paragraphs.push({ text: t, tokens: await tokenize(t) });
    }
    closeSheet();
    renderDoc();
    $('docHint').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '분석하기';
  }
}

async function main(): Promise<void> {
  renderNav('read');
  $('analyzeBtn').addEventListener('click', () => { analyze().catch(() => { $('analyzeNote').textContent = '분석하지 못했어요.'; $('analyzeNote').hidden = false; }); });
  $('clearBtn').addEventListener('click', () => {
    $<HTMLTextAreaElement>('paste').value = '';
    paragraphs = [];
    $('doc').replaceChildren();
    $('coverage').hidden = true;
    $('docHint').hidden = true;
    closeSheet();
  });
  $('doc').addEventListener('click', (e) => {
    const span = (e.target as HTMLElement).closest<HTMLElement>('.w');
    if (span) openWord(span);
  });
  $('sheetClose').addEventListener('click', closeSheet);
  $('saveCard').addEventListener('click', saveCard);
  $('speak').addEventListener('click', () => {
    if (!open) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(open.lemma);
    u.lang = 'en-US';
    speechSynthesis.speak(u);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  const vocab = await fetchVocab();
  words = vocab ?? {};
  if (!vocab) $('markNote').hidden = false; // no vocab tables yet: marks only last for this page
  if (vocab && !Object.keys(vocab).length) {
    $('vocabHint').hidden = false; // never synced from the extension: every word will look unknown
  }
}

if (requireSession()) main();
