import { fetchAllCards, isDue, isMastered, splitSentence, type CardRow } from './cards-api';
import { renderNav, requireSession } from './nav';
import { renderProgress } from './progress';

// Rough pace for the "예상 시간" line -- review is quick flip-and-rate, so ~20s a
// card is an honest ballpark, not a measurement.
const SECONDS_PER_CARD = 20;

function recentRow(c: CardRow): HTMLElement {
  const li = document.createElement('li');
  li.className = 'crow';
  const p = document.createElement('p');
  p.className = 'sentence';
  const { before, target, after } = splitSentence(c);
  const mark = document.createElement('mark');
  mark.textContent = target;
  p.append(before, mark, after);
  const acts = document.createElement('div');
  acts.className = 'acts';
  const a = document.createElement('a');
  a.className = 'btn sm';
  a.href = `cards.html?id=${c.id}`;
  a.textContent = '미리보기';
  acts.append(a);
  li.append(p, acts);
  li.addEventListener('click', (e) => { if (e.target !== a) location.href = a.href; });
  return li;
}

async function main(): Promise<void> {
  renderNav('home');
  const lead = document.getElementById('lead')!;
  try {
    const cards = await fetchAllCards();
    const due = cards.filter((c) => isDue(c)).length;
    renderNav('home', due);

    document.getElementById('statTotal')!.textContent = String(cards.length);
    document.getElementById('statDue')!.textContent = String(due);
    document.getElementById('statMastered')!.textContent = String(cards.filter(isMastered).length);

    const big = document.getElementById('dueBig')!;
    const sub = document.getElementById('dueSub')!;
    const start = document.getElementById('startReview') as HTMLAnchorElement;
    if (!cards.length) {
      lead.textContent = '';
      big.textContent = '저장한 카드가 아직 없어요';
      sub.textContent = '확장 프로그램에서 문장을 저장하면 여기서 복습할 수 있어요.';
      document.getElementById('empty')!.hidden = false;
      return;
    }
    if (due > 0) {
      lead.textContent = `오늘 복습할 카드가 ${due}개 있어요.`;
      big.textContent = `오늘 복습할 카드 ${due}개`;
      sub.textContent = `예상 시간 약 ${Math.max(1, Math.round((due * SECONDS_PER_CARD) / 60))}분`;
      start.hidden = false;
    } else {
      lead.textContent = '오늘 복습은 모두 끝났어요.';
      big.textContent = '오늘은 복습할 카드가 없어요';
      sub.textContent = '새 문장을 저장하면 다음 복습에 추가돼요.';
    }
    document.getElementById('recent')!.replaceChildren(...cards.slice(0, 3).map(recentRow));
    renderProgress(document.getElementById('progress')!, cards).catch(() => {});
  } catch {
    document.getElementById('loadError')!.hidden = false;
  }
}

if (requireSession()) main();
