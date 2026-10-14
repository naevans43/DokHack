import { buildAnkiExport } from './anki-export';
import { getBlob } from './blobstore';
import { REVIEW_SITE_URL } from './config';
import { definitionClass } from './konglish';
import { ask } from './messaging';
import { stopSpeaking, ttsButtons } from './tts';
import { getAccount, getCards, getEncounters, getRewatch, getSettings, saveSettings } from './storage';
import type { EncounterMap, MinedCard } from './types';

// Saved-sentences page (also the extension's options page).

const list = document.getElementById('list')!;
const empty = document.getElementById('empty')!;
const count = document.getElementById('count')!;

let encounters: EncounterMap = {};

async function render(): Promise<void> {
  const [cards, enc] = await Promise.all([getCards(), getEncounters()]);
  encounters = enc;
  list.replaceChildren(...cards.map(item));
  empty.hidden = cards.length > 0;
  count.textContent = cards.length ? `${cards.length}개` : '';
  (document.getElementById('export') as HTMLButtonElement).disabled = !cards.length;
}

function item(card: MinedCard): HTMLElement {
  const li = document.createElement('li');
  li.className = 'item';

  const p = document.createElement('p');
  p.className = 'sentence serif';
  const { before, target, after } = split(card);
  const mark = document.createElement('mark');
  mark.textContent = target;
  p.append(before, mark, after);

  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.append(span('word', card.lemma));
  for (const d of card.definitions) meta.append(span(definitionClass(d), d.text));
  meta.append(span('', new Date(card.createdAt).toLocaleDateString('ko-KR')));
  const a = document.createElement('a');
  a.href = card.url;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = card.title || new URL(card.url).hostname;
  meta.append(a);
  if (card.audioBlobId) meta.append(span('clip', '오디오'));
  const seenAgain = encounters[card.lemma]?.n ?? 0;
  if (seenAgain) meta.append(span('again', `다시 만남 ${seenAgain}번`));

  const acts = document.createElement('div');
  acts.className = 'acts';
  const preview = button('btn sm', '미리보기', () => openModal(card.id, 'preview'));
  const edit = button('btn sm', '편집', () => openModal(card.id, 'edit'));
  const del = button('del', '삭제', async () => {
    await ask({ type: 'deleteCard', id: card.id });
    render();
  });
  del.setAttribute('aria-label', `“${card.sentence.slice(0, 40)}” 삭제`);
  acts.append(preview, edit, del);

  li.append(p, acts, meta);
  return li;
}

function button(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

// ---- preview / edit modal ------------------------------------------------
// Preview shows the card as it'll look in review, plus the YouTube frame and
// audio clip if the card has them (those live in this extension's own
// IndexedDB and never reach the website, so only here can they be played).

const modal = document.getElementById('modal')!;
const modalCard = document.getElementById('modalCard')!;
let modalUrls: string[] = [];

function closeModal(): void {
  stopSpeaking();
  modal.hidden = true;
  modalCard.replaceChildren();
  modalUrls.forEach((u) => URL.revokeObjectURL(u));
  modalUrls = [];
}

modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function sentenceNode(card: Pick<MinedCard, 'sentence' | 'targetStart' | 'surface'>): HTMLElement {
  const p = node('p', 'sentence serif');
  const { before, target, after } = split(card as MinedCard);
  const mark = document.createElement('mark');
  mark.textContent = target;
  p.append(before, mark, after);
  return p;
}

/** Korean if mostly Hangul, else English -- by ratio, since English definitions carry a Korean "명사:" prefix. */
function langOf(text: string): 'ko' | 'en' {
  const hangul = (text.match(/[가-힣]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return hangul > 0 && hangul >= latin ? 'ko' : 'en';
}

async function openModal(id: string, mode: 'preview' | 'edit'): Promise<void> {
  const card = (await getCards()).find((c) => c.id === id);
  if (!card) return;
  modalUrls.forEach((u) => URL.revokeObjectURL(u));
  modalUrls = [];
  modalCard.replaceChildren(...(mode === 'edit' ? editView(card) : await previewView(card)));
  modal.hidden = false;
}

async function previewView(card: MinedCard): Promise<Node[]> {
  let face: 'front' | 'back' = 'front';
  const body = node('div');
  const tabs = node('div', 'tabs');
  const render = () => {
    body.replaceChildren(sentenceNode(card));
    if (face === 'back') {
      const back = node('div', 'back');
      if (!card.definitions.length) back.append(node('span', 'def', '저장한 뜻이 없어요.'));
      for (const d of card.definitions) back.append(node('span', definitionClass(d), d.text));
      body.append(back);
    }
    tabs.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('on', (i === 0) === (face === 'front')));
  };
  for (const f of ['front', 'back'] as const) {
    tabs.append(button('chip' + (f === 'front' ? ' on' : ''), f === 'front' ? '앞면' : '뒷면', () => { face = f; render(); }));
  }
  const close = button('btn sm', '닫기', closeModal);
  close.style.marginLeft = 'auto';
  tabs.append(close);
  render();

  const out: Node[] = [tabs, body];

  const frameBlob = card.frameBlobId ? await getBlob(card.frameBlobId).catch(() => null) : null;
  if (frameBlob) {
    const img = node('img', 'frame');
    img.alt = '캡처한 장면';
    img.src = URL.createObjectURL(frameBlob.blob);
    modalUrls.push(img.src);
    out.push(img);
  }
  const audioBlob = card.audioBlobId ? await getBlob(card.audioBlobId).catch(() => null) : null;
  if (audioBlob) {
    const audio = node('audio');
    audio.controls = true;
    audio.src = URL.createObjectURL(audioBlob.blob);
    modalUrls.push(audio.src);
    out.push(audio);
  } else {
    const tts = ttsButtons(card.sentence, card.lemma); // no captured clip: the browser's own voice
    if (tts) out.push(tts);
  }

  const facts = node('p', 'facts');
  facts.append(new Date(card.createdAt).toLocaleDateString('ko-KR'));
  const a = document.createElement('a');
  a.href = card.url;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = card.title || new URL(card.url).hostname;
  facts.append(' · 출처 ', a);
  out.push(facts);

  const actions = node('div', 'actions');
  actions.append(button('btn', '편집', () => openModal(card.id, 'edit')));
  out.push(actions);
  return out;
}

function editView(card: MinedCard): Node[] {
  const out: Node[] = [];
  const label = node('label', 'field-label', '문장');
  label.htmlFor = 'editSentence';
  label.append(` (강조되는 단어는 ${card.surface})`);
  const ta = node('textarea', 'ta');
  ta.id = 'editSentence';
  ta.value = card.sentence;
  out.push(label, ta, node('span', 'field-label', '뜻'));

  // A definition left untouched keeps the language it was saved with.
  const originalLang = new Map(card.definitions.map((d) => [d.text, d.lang] as const));
  const langFor = (text: string) => originalLang.get(text) ?? langOf(text);
  const defsBox = node('div');
  const addRow = (text: string, lang: 'ko' | 'en' | null) => {
    const row = node('div', 'def-edit');
    const input = node('input', lang === 'ko' ? 'ko' : '');
    input.type = 'text';
    input.placeholder = '뜻';
    input.setAttribute('aria-label', '뜻');
    input.value = text;
    input.addEventListener('input', () => input.classList.toggle('ko', langFor(input.value.trim()) === 'ko'));
    const rm = button('btn sm', '✕', () => row.remove());
    rm.setAttribute('aria-label', '이 뜻 삭제');
    row.append(input, rm);
    defsBox.append(row);
    return input;
  };
  card.definitions.forEach((d) => addRow(d.text, d.lang));
  const add = button('btn sm', '+ 뜻 추가', () => addRow('', null).focus());
  out.push(defsBox, add);

  const error = node('p', 'form-error');
  error.hidden = true;
  ta.addEventListener('input', () => { error.hidden = true; });
  const save = button('btn primary', '저장', async () => {
    const sentence = ta.value.replace(/\s+/g, ' ').trim();
    // The highlighted word is located by its surface form, same as the card
    // editor does when saving -- if an edit removes it there'd be nothing to
    // highlight, so say so rather than silently picking a spot.
    const at = sentence.indexOf(card.surface);
    if (!sentence) { error.textContent = '문장을 입력하세요.'; error.hidden = false; return; }
    if (at === -1) { error.textContent = `문장에 “${card.surface}” 단어가 그대로 들어 있어야 해요.`; error.hidden = false; return; }
    const definitions = [...defsBox.querySelectorAll('input')]
      .map((i) => i.value.trim()).filter(Boolean).map((text) => ({ text, lang: langFor(text) }));
    save.disabled = true;
    try {
      await ask({ type: 'updateCard', id: card.id, sentence, targetStart: at, definitions });
      await render();
      await openModal(card.id, 'preview');
    } catch {
      save.disabled = false;
      error.textContent = '저장하지 못했습니다. 다시 시도해 주세요.';
      error.hidden = false;
    }
  });
  const cancel = button('btn', '취소', () => openModal(card.id, 'preview'));
  const note = node('span', 'muted', card.synced ? '웹사이트의 카드도 함께 바뀌어요' : '');
  note.style.fontSize = '12.5px';
  const btns = node('span');
  btns.style.cssText = 'display:flex;gap:8px';
  btns.append(cancel, save);
  const foot = node('div', 'form-foot');
  foot.append(note, btns);
  out.push(error, foot);
  return out;
}

function split(card: MinedCard) {
  const s = card.sentence;
  const i = card.targetStart;
  const n = card.surface.length;
  return { before: s.slice(0, i), target: s.slice(i, i + n), after: s.slice(i + n) };
}

function span(cls: string, text: string): HTMLElement {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}

// ---- CSV export for Anki ----------------------------------------------
// Fields: Sentence (target in <b>), Word, Meaning, Source.
// In Anki: File → Import, tick "Allow HTML in fields".

function csvField(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

async function exportAnki(): Promise<void> {
  const btn = document.getElementById('exportAnki') as HTMLButtonElement;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '만드는 중…';
  try {
    const { blob, cards, mediaFiles } = await buildAnkiExport(await getCards(), { getBlob });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dokhack-anki-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    count.textContent = `카드 ${cards}장과 미디어 파일 ${mediaFiles}개를 내보냈어요. zip 안의 README.txt를 먼저 읽어 주세요.`;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function exportCsv(): Promise<void> {
  const cards = await getCards();
  const rows = cards.map((c) => {
    const { before, target, after } = split(c);
    const sentence = `${escapeHtml(before)}<b>${escapeHtml(target)}</b>${escapeHtml(after)}`;
    const meaning = c.definitions.map((d) => d.text).join('; ');
    return [sentence, c.lemma, meaning, c.url].map(csvField).join(',');
  });
  // BOM so Excel opens Korean text correctly.
  const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dokhack-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- review-website account ----------------------------------------------

async function initAccount(): Promise<void> {
  const signedOut = document.getElementById('accountSignedOut')!;
  const signedIn = document.getElementById('accountSignedIn')!;
  const emailInput = document.getElementById('accountEmail') as HTMLInputElement;
  const codeRow = document.getElementById('codeRow')!;
  const codeInput = document.getElementById('accountCode') as HTMLInputElement;
  const error = document.getElementById('accountError')!;
  const emailDisplay = document.getElementById('accountEmailDisplay')!;
  const syncStatus = document.getElementById('syncStatus')!;

  async function renderAccount(): Promise<void> {
    const account = await getAccount();
    signedOut.hidden = !!account;
    signedIn.hidden = !account;
    if (account) emailDisplay.textContent = account.email;
  }

  function showError(message: string): void {
    error.textContent = message;
    error.hidden = false;
  }

  document.getElementById('requestCode')!.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    if (!email) return;
    error.hidden = true;
    try {
      await ask({ type: 'requestLoginCode', email });
      codeRow.hidden = false;
      codeInput.focus();
    } catch {
      showError('코드를 보내지 못했습니다. 잠시 후 다시 시도하세요.');
    }
  });

  document.getElementById('verifyCode')!.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const code = codeInput.value.trim();
    if (!email || !code) return;
    error.hidden = true;
    try {
      await ask({ type: 'verifyLoginCode', email, code });
      await renderAccount();
    } catch {
      showError('코드가 올바르지 않습니다. 다시 확인해 주세요.');
    }
  });

  document.getElementById('logout')!.addEventListener('click', async () => {
    await ask({ type: 'logout' });
    await renderAccount();
  });

  document.getElementById('syncAll')!.addEventListener('click', async () => {
    syncStatus.textContent = '동기화 중…';
    try {
      // Independent directions (push unsynced cards up, pull learned-word
      // status down) -- safe to run together.
      const [pushed, promoted] = await Promise.all([
        ask<number>({ type: 'syncAllCards' }),
        ask<number>({ type: 'pullLearnedWords' }),
      ]);
      syncStatus.textContent = promoted ? `${pushed}개 동기화됨, ${promoted}개 단어 알아요로 전환됨` : `${pushed}개 동기화됨`;
    } catch {
      syncStatus.textContent = '동기화 실패';
    }
    setTimeout(() => (syncStatus.textContent = ''), 3000);
  });

  chrome.storage.onChanged.addListener((c) => { if (c.account) renderAccount(); });
  renderAccount();
}

(document.getElementById('reviewLink') as HTMLAnchorElement).href = REVIEW_SITE_URL;
(document.getElementById('siteLink') as HTMLAnchorElement).href = REVIEW_SITE_URL;
(document.getElementById('placementLink') as HTMLAnchorElement).href = `${REVIEW_SITE_URL}/placement`;
document.getElementById('export')!.addEventListener('click', exportCsv);
document.getElementById('exportAnki')!.addEventListener('click', () => { exportAnki().catch(() => { count.textContent = '내보내지 못했어요.'; }); });
chrome.storage.onChanged.addListener((c) => (c.cards || c.encounters) && render());
render();
initAccount();

const importText = document.getElementById('importText') as HTMLTextAreaElement;
const importResult = document.getElementById('importResult')!;
document.getElementById('importFile')!.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) importText.value = await file.text();
});
document.getElementById('importGo')!.addEventListener('click', async () => {
  const text = importText.value.trim();
  importResult.hidden = false;
  if (!text) { importResult.textContent = '가져올 단어를 먼저 붙여넣거나 파일을 골라 주세요.'; return; }
  const status = (document.getElementById('importStatus') as HTMLSelectElement).value as 'known' | 'seen' | 'learning';
  try {
    const { added, distinct } = await ask<{ added: number; distinct: number }>({ type: 'importWords', text, status });
    importResult.textContent = `글에서 단어 ${distinct}개를 찾아 ${added}개를 새로 표시했어요. (나머지는 이미 표시된 단어예요.)`;
  } catch {
    importResult.textContent = '가져오지 못했어요. 확장 프로그램을 새로고침한 뒤 다시 해 보세요.';
  }
});

// Scan/seen/pause settings (auto-scan and auto-pause are off by default); auto-scan also lives in the popup, both write the same setting.
const flags = (['autoScan', 'autoSeen', 'autoPauseLines', 'freqBadges'] as const).map((key) => ({
  key, box: document.getElementById(key) as HTMLInputElement,
}));
const showFlags = () => getSettings().then((s) => flags.forEach(({ key, box }) => { box.checked = s[key]; }));
flags.forEach(({ key, box }) => box.addEventListener('change', () => saveSettings({ [key]: box.checked })));
showFlags();
chrome.storage.onChanged.addListener((c) => { if (c.settings) showFlags(); });

// "Good to rewatch" (youtube.ts reports, background.ts stores; device-only).
async function renderRewatch(): Promise<void> {
  const videos = await getRewatch();
  const list = document.getElementById('rewatchList')!;
  list.replaceChildren(...videos.map((v) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = v.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = v.title || v.url;
    const forget = button('del', '삭제', () => { ask({ type: 'forgetVideo', url: v.url }).catch(() => {}); });
    forget.setAttribute('aria-label', `“${v.title}” 목록에서 삭제`);
    li.append(a, span('pct', `이해도 ${v.pct}%`), span('date', new Date(v.at).toLocaleDateString('ko-KR')), forget);
    return li;
  }));
  document.getElementById('rewatchEmpty')!.hidden = videos.length > 0;
  document.getElementById('rewatchClear')!.hidden = videos.length === 0;
}
document.getElementById('rewatchClear')!.addEventListener('click', () => { ask({ type: 'forgetVideo', url: null }).catch(() => {}); });
renderRewatch();
chrome.storage.onChanged.addListener((c) => { if (c.rewatch) renderRewatch(); });
