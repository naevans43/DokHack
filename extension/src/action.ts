import { comprehensionOf, TARGET_PCT } from './comprehension';
import { REVIEW_SITE_URL } from './config';
import { ask } from './messaging';
import { getCards, getSettings, getWords, saveSettings } from './storage';
import type { TabCommand, TabStatus } from './types';

// Toolbar popup: the page's 스캔 button (nothing is highlighted until it's
// pressed, unless autoScan is on), a per-site on/off switch, and a few counts.

async function tabStatus(tabId: number, command: TabCommand['dokhack']): Promise<TabStatus | null> {
  try {
    return ((await chrome.tabs.sendMessage(tabId, { dokhack: command } satisfies TabCommand)) as TabStatus | undefined) ?? null;
  } catch {
    return null; // no content script there (restricted page, or the tab predates the extension)
  }
}

async function main(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ? new URL(tab.url) : null;
  const host = url && /^https?:$/.test(url.protocol) ? url.hostname : null;

  const scanBtn = document.getElementById('scan') as HTMLButtonElement;
  const scanHint = document.getElementById('scanHint')!;
  const autoBox = document.getElementById('auto') as HTMLInputElement;
  const coverage = document.getElementById('coverage')!;
  const coverageBar = document.getElementById('coverageBar')!;
  const coverageText = document.getElementById('coverageText')!;
  const coverageSource = document.getElementById('coverageSource')!;
  const coveragePct = document.getElementById('coveragePct')!;
  const coverageBand = document.getElementById('coverageBand')!;
  const hostEl = document.getElementById('host')!;
  const toggle = document.getElementById('toggle') as HTMLInputElement;
  const [settings, words, cards] = await Promise.all([getSettings(), getWords(), getCards()]);

  autoBox.checked = settings.autoScan;
  autoBox.addEventListener('change', () => saveSettings({ autoScan: autoBox.checked }));

  let pollTimer: ReturnType<typeof setInterval> | 0 = 0;
  /**
   * Comprehension meter (comprehension.ts): "you know N% of this page" against
   * the 95% target band. On YouTube, once the transcript is built, the video's
   * own subtitles are measured instead of the whole page.
   */
  function showCoverage(status: TabStatus | null): void {
    const video = comprehensionOf(status?.active ? status.videoStats : undefined);
    const c = video ?? comprehensionOf(status?.active ? status.stats : undefined);
    coverage.hidden = !c;
    if (!c) return;
    coverageSource.textContent = video ? '이 영상 이해도' : '이 페이지 이해도';
    coveragePct.textContent = `${c.pct}%`;
    coverageBand.textContent = c.label;
    coverageBand.dataset.band = c.band;
    coverageBar.style.width = `${c.pct}%`;
    const toTarget = c.pct < TARGET_PCT
      ? `목표 ${TARGET_PCT}%까지 ${TARGET_PCT - c.pct}%p 남았어요.`
      : `목표 구간(${TARGET_PCT}% 이상)이에요.`;
    coverageText.textContent = `모르는 단어 ${c.unknownCount}개, 전체 ${c.counted}개. ${toTarget}`;
  }

  // Reflects what the page's content script says it's doing right now.
  const tabId = tab?.id;
  async function refresh(command: TabCommand['dokhack'] = 'status'): Promise<void> {
    const status = host && tabId !== undefined ? await tabStatus(tabId, command) : null;
    scanBtn.classList.toggle('primary', !status?.active);
    showCoverage(status);
    if (status?.active && !pollTimer) pollTimer = setInterval(() => refresh(), 1000); // the page's words keep arriving for a moment after a scan
    if (!status?.active && pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
    if (!host) {
      scanBtn.disabled = true;
      scanHint.textContent = '이 페이지에서는 스캔할 수 없어요.';
    } else if (!status) {
      scanBtn.disabled = true;
      scanHint.textContent = '페이지를 새로고침한 뒤 다시 열어 주세요.';
    } else if (!status.allowed) {
      scanBtn.disabled = true;
      scanHint.textContent = '이 사이트에서는 사용을 껐어요. 아래 스위치를 켜 주세요.';
    } else if (status.active) {
      scanBtn.disabled = false;
      scanBtn.textContent = '스캔 끄기';
      scanHint.textContent = '단어가 표시되고 있어요. 단어를 클릭해 뜻을 확인하세요.';
    } else {
      scanBtn.disabled = false;
      scanBtn.textContent = '이 페이지 스캔하기';
      scanHint.textContent = '모르는 단어를 이 페이지에서 찾아 표시해요.';
    }
    if (!status || !status.allowed) scanBtn.textContent = '이 페이지 스캔하기';
  }
  scanBtn.addEventListener('click', async () => {
    const status = tabId !== undefined ? await tabStatus(tabId, 'status') : null;
    await refresh(status?.active ? 'unscan' : 'scan');
  });
  // The site switch and the auto-scan box both flow through storage; the page
  // reacts to that a beat later, so look again shortly after any settings change.
  chrome.storage.onChanged.addListener((c) => c.settings && setTimeout(() => refresh(), 150));
  refresh();

  if (host) {
    hostEl.textContent = host;
    toggle.checked = !settings.disabledHosts.includes(host);
    toggle.addEventListener('change', async () => {
      const { disabledHosts } = await getSettings();
      const next = toggle.checked
        ? disabledHosts.filter((h) => h !== host)
        : [...new Set([...disabledHosts, host])];
      await saveSettings({ disabledHosts: next });
    });
  } else {
    hostEl.textContent = '이 페이지에서는 사용할 수 없습니다';
    toggle.disabled = true;
  }

  const values = Object.values(words);
  document.getElementById('seen')!.textContent = String(values.filter((s) => s === 'seen').length);
  document.getElementById('learning')!.textContent = String(values.filter((s) => s === 'learning').length);
  document.getElementById('known')!.textContent = String(values.filter((s) => s === 'known').length);
  document.getElementById('cards')!.textContent = String(cards.length);
  document.getElementById('open')!.addEventListener('click', () => chrome.runtime.openOptionsPage());
  (document.getElementById('review') as HTMLAnchorElement).href = REVIEW_SITE_URL;

  // Not awaited: the popup is already usable, and the badge just appears when
  // (and if) the website answers -- no account linked or offline = no badge.
  ask<number | null>({ type: 'dueCount' })
    .then((n) => {
      if (!n) return;
      const badge = document.getElementById('dueBadge')!;
      badge.textContent = String(n);
      badge.hidden = false;
      badge.title = `오늘 복습할 카드 ${n}개`;
    })
    .catch(() => {});
}

main();
