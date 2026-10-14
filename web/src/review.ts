import { fsrs, generatorParameters, Rating, type Card, type Grade, type State } from 'ts-fsrs';
import { definitionClass } from '../../extension/src/konglish';
import { splitSentence, type CardRow } from './cards-api';
import { mediaBlock } from './media';
import { renderNav, requireSession } from './nav';
import {
  capReached, CARD_CHOICES, dayKey, forgivingStreak, loadDaily, loadToday, MINUTE_CHOICES, saveDaily, saveToday,
} from './daily';
import { fetchCardTimes, fetchEncounters, fetchReviewTimes, logReview, seenAgainChip } from './stats-api';
import { apiFetch } from './supabase';

// The FSRS review queue. Card content (sentence/definitions) is mined in the
// extension; this page only schedules and reviews cards already synced to
// Supabase — it never creates or edits them.

if (!requireSession()) throw new Error('not-signed-in');
renderNav('review');

const scheduler = fsrs(generatorParameters());

const remainingEl = document.getElementById('remaining')!;
const cardEl = document.getElementById('card')!;
const emptyEl = document.getElementById('empty')!;
const sentenceEl = document.getElementById('sentence')!;
const defsEl = document.getElementById('defs')!;
const mediaEl = document.getElementById('media')!;
const revealBtn = document.getElementById('reveal') as HTMLButtonElement;
const ratingsEl = document.getElementById('ratings')!;
const doneEl = document.getElementById('done')!;
const dailyProgressEl = document.getElementById('dailyProgress')!;
const dailyOn = document.getElementById('dailyOn') as HTMLInputElement;
const dailyCards = document.getElementById('dailyCards') as HTMLSelectElement;
const dailyMinutes = document.getElementById('dailyMinutes') as HTMLSelectElement;
const moreBtn = document.getElementById('more') as HTMLButtonElement;

let queue: CardRow[] = [];
let loaded = false;
let encounters: Record<string, number> | null = null;

// ---- tiny daily mode + forgiving streak (daily.ts) ----------------------------
const daily = loadDaily();
let today = loadToday();
const activeDays = new Set<string>(); // filled once review_log/cards answer; today is added on the first rating

function minutesText(ms: number): string {
  return ms < 60_000 ? '1분 미만' : `${Math.round(ms / 60_000)}분`;
}

function renderDailyProgress(): void {
  dailyProgressEl.hidden = !daily.on;
  const met = today.cards >= daily.cards || today.ms >= daily.minutes * 60_000;
  dailyProgressEl.textContent = met
    ? `오늘 목표 달성 (${today.cards}장)`
    : `오늘 ${today.cards}/${daily.cards}장, ${Math.floor(today.ms / 60_000)}/${daily.minutes}분`;
  dailyCards.disabled = dailyMinutes.disabled = !daily.on;
}

function showDone(): void {
  cardEl.hidden = true;
  emptyEl.hidden = true;
  doneEl.hidden = false;
  const capped = capReached(daily, today);
  document.getElementById('doneTitle')!.textContent = capped ? '오늘은 여기까지 해도 충분해요' : '오늘 복습할 카드를 모두 끝냈어요';
  document.getElementById('doneSummary')!.textContent = `오늘 카드 ${today.cards}장, ${minutesText(today.ms)} 복습했어요.`;
  const run = forgivingStreak(activeDays).days;
  document.getElementById('doneStreak')!.textContent = run ? `${run}일째 이어가는 중` : '';
  document.getElementById('doneNote')!.textContent = run ? '하루 쉬어도 기록은 이어져요. 이틀 연속 쉬면 새로 시작해요.' : '';
  moreBtn.hidden = !(capped && queue.length);
  remainingEl.textContent = queue.length ? `${queue.length}개 남음` : '';
}

function initDailyControls(): void {
  dailyCards.append(...CARD_CHOICES.map((n) => new Option(String(n), String(n), false, n === daily.cards)));
  dailyMinutes.append(...MINUTE_CHOICES.map((n) => new Option(String(n), String(n), false, n === daily.minutes)));
  dailyOn.checked = daily.on;
  const onChange = () => {
    daily.on = dailyOn.checked;
    daily.cards = Number(dailyCards.value);
    daily.minutes = Number(dailyMinutes.value);
    saveDaily(daily);
    renderDailyProgress();
    if (loaded) renderCurrent();
  };
  dailyOn.addEventListener('change', onChange);
  dailyCards.addEventListener('change', onChange);
  dailyMinutes.addEventListener('change', onChange);
  moreBtn.addEventListener('click', () => {
    today.extra = true;
    saveToday(today);
    renderCurrent();
  });
  renderDailyProgress();

  // Time only counts while a card is actually on screen and the tab is visible.
  setInterval(() => {
    if (today.day !== dayKey(new Date())) today = loadToday(); // past midnight: a fresh day
    if (cardEl.hidden || document.visibilityState !== 'visible') return;
    today.ms += 1000;
    saveToday(today);
    renderDailyProgress();
  }, 1000);
}

async function loadActivity(): Promise<void> {
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
  const [reviews, saved] = await Promise.all([fetchReviewTimes(since), fetchCardTimes(since)]);
  const todayKey = dayKey(new Date());
  let reviewedToday = 0;
  for (const iso of reviews ?? []) {
    const k = dayKey(new Date(iso));
    activeDays.add(k);
    if (k === todayKey) reviewedToday++;
  }
  for (const iso of saved ?? []) activeDays.add(dayKey(new Date(iso)));
  // Reviews made on another device today count toward today's cap too.
  if (reviewedToday > today.cards) { today.cards = reviewedToday; saveToday(today); }
  renderDailyProgress();
  if (loaded) renderCurrent();
}

function el(tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function toCard(row: CardRow): Card {
  return {
    due: new Date(row.due),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state as State,
    last_review: row.last_review ? new Date(row.last_review) : undefined,
  };
}

function fromCard(card: Card) {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? card.last_review.toISOString() : null,
  };
}

function renderCurrent(): void {
  const current = queue[0];
  // Done for today: the daily cap is reached, or the queue ran out after some reviewing.
  if (capReached(daily, today) || (!current && today.cards > 0)) return showDone();
  doneEl.hidden = true;
  emptyEl.hidden = !!current;
  cardEl.hidden = !current;
  remainingEl.textContent = queue.length ? `${queue.length}개 남음` : '';
  if (!current) return;

  const { before, target, after } = splitSentence(current);
  sentenceEl.replaceChildren(before, el('mark', {}, target), after);
  // A YouTube card's clip and frame sit with the sentence from the start, like
  // the audio on the front of an Anki card.
  const media = mediaBlock(current);
  const again = seenAgainChip(encounters, current.lemma);
  mediaEl.replaceChildren(...(again ? [again] : []), ...(media ? [media] : []));
  defsEl.replaceChildren(
    ...current.definitions.map((d) => el('li', { class: definitionClass(d) }, d.text)),
  );
  defsEl.hidden = true;
  revealBtn.hidden = false;
  ratingsEl.hidden = true;
}

async function loadQueue(): Promise<void> {
  const res = await apiFetch(
    `/rest/v1/cards?due=lte.${encodeURIComponent(new Date().toISOString())}&order=due.asc&limit=50`,
  );
  queue = (await res.json()) as CardRow[];
  loaded = true;
  renderCurrent();
}

// "Again" schedules a short learning-step interval (often minutes away),
// not a fresh due date days out — so unlike the other ratings, the card
// shouldn't leave this session's queue. It's requeued a few cards back
// instead of staying right in front, so you see other due cards first.
const AGAIN_REQUEUE_DELAY = 3;

async function rate(rating: Grade): Promise<void> {
  const current = queue[0];
  if (!current) return;
  const { card } = scheduler.next(toCard(current), new Date(), rating);
  const patch = fromCard(card);
  await apiFetch(`/rest/v1/cards?id=eq.${current.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  logReview(current.id, rating);
  today.cards++;
  saveToday(today);
  activeDays.add(today.day);
  renderDailyProgress();
  queue.shift();
  if (rating === Rating.Again) {
    queue.splice(Math.min(AGAIN_REQUEUE_DELAY, queue.length), 0, { ...current, ...patch });
  }
  renderCurrent();
}

revealBtn.addEventListener('click', () => {
  defsEl.hidden = false;
  revealBtn.hidden = true;
  ratingsEl.hidden = false;
});

const RATINGS: { value: Grade; label: string }[] = [
  { value: Rating.Again, label: '다시' },
  { value: Rating.Hard, label: '어려움' },
  { value: Rating.Good, label: '보통' },
  { value: Rating.Easy, label: '쉬움' },
];
for (const r of RATINGS) {
  const btn = el('button', { class: 'btn rating' }, r.label);
  btn.addEventListener('click', () => rate(r.value));
  ratingsEl.append(btn);
}

initDailyControls();
fetchEncounters().then((e) => { encounters = e; if (loaded && !cardEl.hidden && defsEl.hidden) renderCurrent(); }).catch(() => {});
loadActivity().catch(() => {});
loadQueue();
