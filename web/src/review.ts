import { fsrs, generatorParameters, Rating, type Card, type Grade, type State } from 'ts-fsrs';
import { splitSentence, type CardRow } from './cards-api';
import { mediaBlock } from './media';
import { renderNav, requireSession } from './nav';
import { logReview } from './stats-api';
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

let queue: CardRow[] = [];

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
  emptyEl.hidden = !!current;
  cardEl.hidden = !current;
  remainingEl.textContent = queue.length ? `${queue.length}개 남음` : '';
  if (!current) return;

  const { before, target, after } = splitSentence(current);
  sentenceEl.replaceChildren(before, el('mark', {}, target), after);
  // A YouTube card's clip and frame sit with the sentence from the start, like
  // the audio on the front of an Anki card.
  const media = mediaBlock(current);
  mediaEl.replaceChildren(...(media ? [media] : []));
  defsEl.replaceChildren(
    ...current.definitions.map((d) => el('li', { class: d.lang === 'ko' ? 'gloss' : 'def' }, d.text)),
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

loadQueue();
