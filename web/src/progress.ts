import type { CardRow } from './cards-api';
import { dayKey, forgivingStreak } from './daily';
import { fetchReviewTimes, fetchVocabDaily, type VocabDay } from './stats-api';

// The home page's 학습 현황: word counts, a growth line, and an activity
// heatmap. Word data comes from the extension's synced vocabulary; activity
// from review ratings plus cards created. Missing tables/data just leave a
// section out (see stats-api.ts).

const WEEKS = 18;
const DAY_MS = 86_400_000;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Heat level 0-4 for a day's activity count. */
export function level(n: number): number {
  return n <= 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 10 ? 3 : 4;
}


function vocabSection(days: VocabDay[]): HTMLElement {
  const box = el('section', 'progress-block');
  box.append(el('h2', '', '내 단어'));
  const last = days[days.length - 1];
  const grid = el('div', 'stats');
  for (const [label, n] of [['알아요', last.known], ['학습 중', last.learning], ['봤어요', last.seen]] as const) {
    const s = el('div', 'stat');
    s.append(el('span', 'muted', label), el('span', 'n', n.toLocaleString()));
    grid.append(s);
  }
  box.append(grid);

  if (days.length >= 2) {
    const first = days[0];
    const gain = last.known - first.known;
    const span = Math.max(1, Math.round((Date.parse(last.day) - Date.parse(first.day)) / DAY_MS));
    box.append(el('p', 'muted small', `${span}일 동안 알아요 단어가 ${gain >= 0 ? '+' : ''}${gain}개 변했어요.`));

    const W = 300, H = 60, P = 4;
    const max = Math.max(...days.map((d) => d.known), 1);
    const min = Math.min(...days.map((d) => d.known));
    const range = Math.max(max - min, 1);
    const pts = days.map((d, i) => {
      const x = P + (i / (days.length - 1)) * (W - 2 * P);
      const y = H - P - ((d.known - min) / range) * (H - 2 * P);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'growth');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '알아요 단어 수의 변화');
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', pts);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '2');
    svg.append(line);
    box.append(svg);
  }
  return box;
}

function heatmapSection(activity: Map<string, number>): HTMLElement {
  const box = el('section', 'progress-block');
  box.append(el('h2', '', '활동'));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today.getTime() - (WEEKS * 7 - 1) * DAY_MS);
  start.setDate(start.getDate() - start.getDay()); // back to that week's Sunday

  const heat = el('div', 'heat');
  heat.setAttribute('role', 'img');
  const active = new Set<string>();
  let activeDays = 0;
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const key = dayKey(d);
    const n = activity.get(key) ?? 0;
    if (n > 0) { active.add(key); activeDays++; }
    const cell = el('span', `cell lv${level(n)}`);
    cell.title = `${key}: ${n}회`;
    heat.append(cell);
  }
  heat.setAttribute('aria-label', `최근 ${WEEKS}주의 활동`);
  box.append(heat);
  const run = forgivingStreak(active).days;
  box.append(el('p', 'muted small', `최근 ${WEEKS}주 중 ${activeDays}일 활동했어요.${run ? ` 지금 ${run}일째 이어가는 중이에요 (하루 쉬어도 이어져요).` : ''}`));
  return box;
}

export async function renderProgress(host: HTMLElement, cards: CardRow[]): Promise<void> {
  const since = new Date(Date.now() - WEEKS * 7 * DAY_MS).toISOString();
  const [vocab, reviews] = await Promise.all([fetchVocabDaily(), fetchReviewTimes(since)]);

  const activity = new Map<string, number>();
  const bump = (iso: string) => {
    const k = dayKey(new Date(iso));
    activity.set(k, (activity.get(k) ?? 0) + 1);
  };
  for (const t of reviews ?? []) bump(t);
  for (const c of cards) if (c.created_at >= since) bump(c.created_at); // saving a card counts as activity too

  const parts: HTMLElement[] = [];
  if (vocab?.length) parts.push(vocabSection(vocab));
  else parts.push(el('p', 'muted small', '확장 프로그램에서 ‘모두 동기화’를 누르면 아는 단어 수와 변화가 여기에 나타나요.'));
  if (activity.size) parts.push(heatmapSection(activity));
  host.replaceChildren(...parts);
  host.hidden = false;
}
