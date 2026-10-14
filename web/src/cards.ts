import { definitionClass, isFalseFriendNote } from '../../extension/src/konglish';
import { mediaBlock } from './media';
import {
  deleteCardRow, dueLabel, fetchAllCards, hostOf, isDue, isMastered, isNew, patchCard, splitSentence,
  type CardDefinition, type CardRow,
} from './cards-api';
import { renderNav, requireSession } from './nav';
import { fetchEncounters, seenAgainChip } from './stats-api';

type Filter = 'all' | 'due' | 'new' | 'mastered';
const FILTERS: { id: Filter; label: string; test: (c: CardRow) => boolean }[] = [
  { id: 'all', label: '전체', test: () => true },
  { id: 'due', label: '오늘 복습', test: (c) => isDue(c) },
  { id: 'new', label: '새 카드', test: isNew },
  { id: 'mastered', label: '익숙해짐', test: isMastered },
];

let cards: CardRow[] = [];
let filter: Filter = 'all';
let query = '';
let selectedId: string | null = null;
let encounters: Record<string, number> | null = null;
let mode: 'preview' | 'edit' = 'preview';
let face: 'front' | 'back' = 'front';

const listEl = document.getElementById('list')!;
const chipsEl = document.getElementById('chips')!;
const countEl = document.getElementById('count')!;
const emptyEl = document.getElementById('empty')!;
const detailEl = document.getElementById('detail')!;
const detailEmptyEl = document.getElementById('detailEmpty')!;
const pcardEl = document.getElementById('pcard')!;
const searchEl = document.getElementById('search') as HTMLInputElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function sentenceNode(c: Pick<CardRow, 'sentence' | 'target_start' | 'surface'>, className: string): HTMLElement {
  const p = el('p', { class: className });
  const { before, target, after } = splitSentence(c);
  p.append(before, el('mark', {}, target), after);
  return p;
}

function visible(): CardRow[] {
  const test = FILTERS.find((f) => f.id === filter)!.test;
  const q = query.trim().toLowerCase();
  return cards.filter((c) => {
    if (!test(c)) return false;
    if (!q) return true;
    return c.lemma.toLowerCase().includes(q)
      || c.sentence.toLowerCase().includes(q)
      || c.definitions.some((d) => d.text.toLowerCase().includes(q));
  });
}

// ---- list ---------------------------------------------------------------

function renderChips(): void {
  chipsEl.replaceChildren(...FILTERS.map((f) => {
    const n = cards.filter(f.test).length;
    const b = el('button', { type: 'button', class: `chip${f.id === filter ? ' on' : ''}`, 'aria-pressed': String(f.id === filter) }, `${f.label} ${n}`);
    b.addEventListener('click', () => { filter = f.id; renderList(); renderChips(); });
    return b;
  }));
}

function row(c: CardRow): HTMLElement {
  const li = el('li', { class: `crow${c.id === selectedId ? ' sel' : ''}` });
  const acts = el('div', { class: 'acts' });
  const preview = el('button', { type: 'button', class: 'btn sm' }, '미리보기');
  const edit = el('button', { type: 'button', class: 'btn sm' }, '편집');
  preview.addEventListener('click', (e) => { e.stopPropagation(); select(c.id, 'preview'); });
  edit.addEventListener('click', (e) => { e.stopPropagation(); select(c.id, 'edit'); });
  acts.append(preview, edit);

  const meta = el('div', { class: 'meta' });
  meta.append(el('b', {}, c.lemma));
  const gloss = c.definitions.find((d) => d.lang === 'ko' && !isFalseFriendNote(d.text));
  if (gloss) meta.append(el('span', { class: 'gloss' }, gloss.text));
  meta.append(el('span', {}, dueLabel(c)));

  li.append(sentenceNode(c, 'sentence'), acts, meta);
  li.addEventListener('click', () => select(c.id, 'preview'));
  return li;
}

function renderList(): void {
  const shown = visible();
  countEl.textContent = cards.length ? `${cards.length}개 중 ${shown.length}개` : '';
  listEl.replaceChildren(...shown.map(row));
  emptyEl.hidden = shown.length > 0 || !cards.length;
  emptyEl.textContent = '조건에 맞는 카드가 없어요.';
}

// ---- detail: preview / edit ---------------------------------------------

function select(id: string, next: 'preview' | 'edit'): void {
  selectedId = id;
  mode = next;
  face = 'front';
  renderList();
  renderDetail();
  detailEl.classList.add('open'); // only matters on narrow screens, where it's a sheet
}

function closeDetail(): void {
  selectedId = null;
  detailEl.classList.remove('open');
  renderList();
  renderDetail();
}

function renderDetail(): void {
  const c = cards.find((x) => x.id === selectedId);
  detailEmptyEl.hidden = !!c;
  pcardEl.hidden = !c;
  if (!c) return;
  pcardEl.replaceChildren(...(mode === 'edit' ? editView(c) : previewView(c)));
}

function previewView(c: CardRow): Node[] {
  const tabs = el('div', { class: 'tabs' });
  for (const f of ['front', 'back'] as const) {
    const t = el('button', { type: 'button', class: `chip${face === f ? ' on' : ''}` }, f === 'front' ? '앞면' : '뒷면');
    t.addEventListener('click', () => { face = f; renderDetail(); });
    tabs.append(t);
  }
  const close = el('button', { type: 'button', class: 'btn sm sheet-close', style: 'margin-left:auto' }, '닫기');
  close.addEventListener('click', closeDetail);
  tabs.append(close);

  const out: Node[] = [tabs, sentenceNode(c, 'sentence')];
  const again = seenAgainChip(encounters, c.lemma);
  if (again) out.push(again);
  const media = mediaBlock(c);
  if (media) out.push(media);
  if (face === 'back') {
    const back = el('div', { class: 'back' });
    if (!c.definitions.length) back.append(el('span', { class: 'def' }, '저장한 뜻이 없어요.'));
    for (const d of c.definitions) back.append(el('span', { class: definitionClass(d) }, d.text));
    out.push(back);
  }

  const facts = el('p', { class: 'facts' });
  facts.append(`복습 ${c.reps}회 · 틀린 횟수 ${c.lapses} · 다음 복습 ${dueLabel(c)}`);
  const host = hostOf(c.url);
  if (host) {
    facts.append(' · 출처 ');
    const a = el('a', { href: c.url, target: '_blank', rel: 'noreferrer' }, host);
    facts.append(a);
  }
  out.push(facts);

  const actions = el('div', { class: 'actions' });
  const edit = el('button', { type: 'button', class: 'btn' }, '편집');
  const del = el('button', { type: 'button', class: 'btn danger' }, '삭제');
  edit.addEventListener('click', () => { mode = 'edit'; renderDetail(); });
  del.addEventListener('click', () => removeCard(c));
  actions.append(edit, del);
  out.push(actions);
  return out;
}

/**
 * The language isn't asked for. Text that's mostly Hangul is Korean, anything
 * else English -- by ratio rather than "contains any Hangul", since the
 * extension's English definitions carry a Korean part-of-speech prefix
 * ("명사: the act of ...") and are still English.
 */
function langOf(text: string): CardDefinition['lang'] {
  const hangul = (text.match(/[가-힣]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return hangul > 0 && hangul >= latin ? 'ko' : 'en';
}

function editView(c: CardRow): Node[] {
  const out: Node[] = [];
  const hint = el('span', {}, ` (강조되는 단어는 ${c.surface})`);
  const sentenceLabel = el('label', { class: 'field-label', for: 'editSentence' }, '문장');
  sentenceLabel.append(hint);
  const ta = el('textarea', { class: 'ta', id: 'editSentence' });
  ta.value = c.sentence;
  out.push(sentenceLabel, ta);

  out.push(el('span', { class: 'field-label' }, '뜻'));
  // A definition left untouched keeps the language it was saved with.
  const originalLang = new Map(c.definitions.map((d) => [d.text, d.lang] as const));
  const langFor = (text: string) => originalLang.get(text) ?? langOf(text);
  const defsBox = el('div');
  const addDefRow = (d: CardDefinition | null) => {
    const r = el('div', { class: 'def-edit' });
    const input = el('input', { type: 'text', class: d && d.lang === 'ko' ? 'ko' : '', 'aria-label': '뜻', placeholder: '뜻' });
    input.value = d?.text ?? '';
    input.addEventListener('input', () => input.classList.toggle('ko', langFor(input.value.trim()) === 'ko'));
    const rm = el('button', { type: 'button', class: 'btn sm', 'aria-label': '이 뜻 삭제' }, '✕');
    rm.addEventListener('click', () => r.remove());
    r.append(input, rm);
    defsBox.append(r);
    return input;
  };
  c.definitions.forEach((d) => addDefRow(d));
  const add = el('button', { type: 'button', class: 'btn sm' }, '+ 뜻 추가');
  add.addEventListener('click', () => addDefRow(null).focus());
  out.push(defsBox, add);

  const error = el('p', { class: 'form-error', role: 'alert' });
  error.hidden = true;
  const note = el('span', { class: 'muted', style: 'font-size:12.5px' }, '복습 일정은 그대로 유지돼요');
  const cancel = el('button', { type: 'button', class: 'btn' }, '취소');
  const save = el('button', { type: 'button', class: 'btn primary' }, '저장');
  cancel.addEventListener('click', () => { mode = 'preview'; renderDetail(); });
  ta.addEventListener('input', () => { error.hidden = true; });
  save.addEventListener('click', async () => {
    const sentence = ta.value.replace(/\s+/g, ' ').trim();
    // The highlighted word is located by its surface form (same as the
    // extension's editor does when saving); if an edit removes it, there'd be
    // nothing to highlight, so say so instead of silently picking a spot.
    const at = sentence.indexOf(c.surface);
    if (!sentence) { error.textContent = '문장을 입력하세요.'; error.hidden = false; return; }
    if (at === -1) { error.textContent = `문장에 “${c.surface}” 단어가 그대로 들어 있어야 해요.`; error.hidden = false; return; }
    const definitions: CardDefinition[] = [...defsBox.querySelectorAll('input')]
      .map((i) => i.value.trim()).filter(Boolean).map((text) => ({ text, lang: langFor(text) }));
    save.disabled = true;
    try {
      await patchCard(c.id, { sentence, target_start: at, definitions });
      Object.assign(c, { sentence, target_start: at, definitions });
      mode = 'preview';
      renderList();
      renderDetail();
    } catch {
      save.disabled = false;
      error.textContent = '저장하지 못했습니다. 다시 시도해 주세요.';
      error.hidden = false;
    }
  });

  const foot = el('div', { class: 'form-foot' });
  const btns = el('span', { style: 'display:flex;gap:8px' });
  btns.append(cancel, save);
  foot.append(note, btns);
  out.push(error, foot);
  return out;
}

async function removeCard(c: CardRow): Promise<void> {
  if (!confirm(`“${c.lemma}” 카드를 삭제할까요? 복습 기록도 함께 사라져요.`)) return;
  try {
    await deleteCardRow(c);
    cards = cards.filter((x) => x.id !== c.id);
    closeDetail();
    renderChips();
  } catch {
    alert('삭제하지 못했습니다. 다시 시도해 주세요.');
  }
}

async function main(): Promise<void> {
  renderNav('cards');
  searchEl.addEventListener('input', () => { query = searchEl.value; renderList(); });
  fetchEncounters().then((e) => { encounters = e; if (selectedId) renderDetail(); }).catch(() => {});
  try {
    cards = await fetchAllCards();
  } catch {
    document.getElementById('loadError')!.hidden = false;
    return;
  }
  renderNav('cards', cards.filter((c) => isDue(c)).length);
  renderChips();
  renderList();
  if (!cards.length) {
    emptyEl.hidden = false;
    emptyEl.textContent = '아직 저장한 카드가 없어요. 확장 프로그램으로 문장을 저장해 보세요.';
  }
  const wanted = new URLSearchParams(location.search).get('id');
  if (wanted && cards.some((c) => c.id === wanted)) select(wanted, 'preview');
}

if (requireSession()) main();
