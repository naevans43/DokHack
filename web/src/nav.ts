import { fetchDueCount } from './cards-api';
import { getSession, logout } from './supabase';

// The shared site nav: a top bar on desktop, a bottom tab bar on phones (see
// site.css) -- review mostly happens on a phone, so the tabs have to be
// reachable with a thumb. Every signed-in page mounts it into #nav.

export type NavPage = 'home' | 'review' | 'cards' | 'read' | 'start' | 'sign-in';

const ICONS: Record<NavPage, string> = {
  home: '<path d="M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10" />',
  review: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.7M20 4v4.7h-4.7M20 12a8 8 0 0 1-13.7 5.6L4 15.3M4 20v-4.7h4.7" />',
  cards: '<path d="M6 3.5h8l4 4V20.5H6zM14 3.5v4h4M9 12h6M9 15.5h6" />',
  read: '<path d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5zM12 6.5v13" />',
  start: '<circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5M12 16.6v.1" />',
  'sign-in': '<circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />',
};

const TABS: { page: NavPage; href: string; label: string }[] = [
  { page: 'home', href: 'index.html', label: '홈' },
  { page: 'review', href: 'review.html', label: '복습' },
  { page: 'cards', href: 'cards.html', label: '카드' },
  { page: 'read', href: 'read.html', label: '읽기' },
  { page: 'start', href: 'start.html', label: '시작하기' },
];

// What a signed-out visitor (the start page is public) gets instead.
const GUEST_TABS: { page: NavPage; href: string; label: string }[] = [
  { page: 'start', href: 'start.html', label: '시작하기' },
  { page: 'sign-in', href: 'sign-in.html', label: '로그인' },
];

function svg(page: NavPage): string {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[page]}</svg>`;
}

/**
 * Mounts the nav into #nav. `dueCount`, when the page already has it (home,
 * cards), saves a request; otherwise it's fetched, and a failure just leaves
 * the badge off rather than breaking the page.
 */
export function renderNav(active: NavPage, dueCount?: number): void {
  const host = document.getElementById('nav');
  if (!host) return;
  const session = getSession();
  const tabs = session ? TABS : GUEST_TABS;

  host.className = 'nav';
  host.innerHTML = `
    <a class="nav-logo" href="${session ? 'index.html' : 'start.html'}">독해크</a>
    <nav class="nav-tabs" aria-label="주 메뉴">
      ${tabs.map((t) => `
        <a class="nav-tab${t.page === active ? ' on' : ''}" href="${t.href}"${t.page === active ? ' aria-current="page"' : ''}>
          ${svg(t.page)}<span class="nav-label">${t.label}</span>${t.page === 'review' ? '<span class="badge" hidden></span>' : ''}
        </a>`).join('')}
    </nav>
    <div class="nav-account"${session ? '' : ' hidden'}>
      <span class="muted nav-email"></span>
      <button class="btn nav-logout" type="button">로그아웃</button>
    </div>`;
  (host.querySelector('.nav-email') as HTMLElement).textContent = session?.email ?? '';
  host.querySelector('.nav-logout')!.addEventListener('click', () => {
    logout();
    location.href = 'sign-in.html';
  });

  const badge = host.querySelector('.badge') as HTMLElement | null;
  if (!badge) return; // signed out: no review tab, nothing to badge
  const showBadge = (n: number) => {
    badge.textContent = String(n);
    badge.hidden = n <= 0;
  };
  if (dueCount !== undefined) showBadge(dueCount);
  else fetchDueCount().then(showBadge).catch(() => {});
}

/** Pages other than sign-in all need a session; bounce to sign-in if there isn't one. */
export function requireSession(): boolean {
  if (getSession()) return true;
  location.href = 'sign-in.html';
  return false;
}
