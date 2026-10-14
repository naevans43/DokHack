import { buildAnkiExport } from './anki-export';
import { getBlob } from './blobstore';
import { REVIEW_SITE_URL } from './config';
import { ask } from './messaging';
import { getAccount, getCards, getRewatch, getSettings, saveSettings } from './storage';
import type { MinedCard } from './types';

// The extension's settings page (its options page, opened by the popup's 설정
// button). Saved cards are managed on the review website now -- this page used
// to also list them with preview/edit/delete, removed at the user's request;
// the cards themselves are still kept locally (for sync and export), and their
// YouTube clips/frames show on the website once uploaded (background.ts's
// syncMedia()). Export lives here because it reads the local copies, including
// clips that only exist in this extension's IndexedDB.

const exportStatus = document.getElementById('exportStatus')!;

/** "N cards on this device" next to the export buttons, which need at least one. */
async function renderExport(): Promise<void> {
  const n = (await getCards()).length;
  exportStatus.textContent = n ? `이 기기에 저장된 카드 ${n}장` : '이 기기에 저장된 카드가 없어요.';
  (document.getElementById('export') as HTMLButtonElement).disabled = !n;
  (document.getElementById('exportAnki') as HTMLButtonElement).disabled = !n;
}

function button(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
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
    exportStatus.textContent = `카드 ${cards}장과 미디어 파일 ${mediaFiles}개를 내보냈어요. zip 안의 README.txt를 먼저 읽어 주세요.`;
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
document.getElementById('exportAnki')!.addEventListener('click', () => { exportAnki().catch(() => { exportStatus.textContent = '내보내지 못했어요.'; }); });
chrome.storage.onChanged.addListener((c) => { if (c.cards) renderExport(); });
renderExport();
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
