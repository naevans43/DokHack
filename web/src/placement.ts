import { FREQUENCY_BANDS } from '../../extension/src/wordlist';
import { renderNav } from './nav';

// Known-word seeding (extension roadmap item 1), moved here from the
// extension's options page: sample a few words from each frequency band, and
// if the reader knows most of a band, mark that whole band "known". Stops at
// the first band below the threshold, so the seeded set stays a contiguous
// "words this common or more common" range. Opt-in -- nothing runs until the
// reader clicks 테스트 시작.
//
// A web page can't write to extension storage, so the result goes to the
// extension through its content script over window.postMessage (see
// extension/src/content.ts's initSiteBridge): this page sends only how many
// bands to mark, and the extension expands that into words itself. The word
// list is imported straight from the extension's source so the two can't drift.
const SAMPLE_PER_BAND = 6;
const KNOWN_THRESHOLD = 0.5;

interface SampleWord {
  band: number;
  lemma: string;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sample(): SampleWord[] {
  const words: SampleWord[] = [];
  FREQUENCY_BANDS.forEach((band, i) => {
    for (const lemma of shuffle([...band]).slice(0, SAMPLE_PER_BAND)) words.push({ band: i, lemma });
  });
  return shuffle(words);
}

/** How many leading bands the reader knows (>= KNOWN_THRESHOLD of each band's sample). */
function cutoffFor(words: SampleWord[], picked: Set<string>): number {
  let cutoff = 0;
  for (let i = 0; i < FREQUENCY_BANDS.length; i++) {
    const inBand = words.filter((w) => w.band === i);
    const known = inBand.filter((w) => picked.has(w.lemma)).length;
    if (!inBand.length || known / inBand.length < KNOWN_THRESHOLD) break;
    cutoff = i + 1;
  }
  return cutoff;
}

// ---- the extension bridge ----

let nextId = 1;

/** Posts to the extension's content script and waits for its reply (null on timeout). */
function callExtension(
  type: string,
  extra: Record<string, unknown> = {},
  timeoutMs = 1500,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const id = nextId++;
    const done = (v: Record<string, unknown> | null) => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(v);
    };
    const onMessage = (e: MessageEvent) => {
      const m = e.data;
      if (e.source !== window || !m || m.source !== 'dokhack-ext' || m.id !== id) return;
      done(m);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'dokhack-site', type, id, ...extra }, location.origin);
  });
}

/** The content script may not have run yet when this page loads, so ping a few times. */
async function detectExtension(): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    if ((await callExtension('ping', {}, 700))?.type === 'pong') return true;
  }
  return false;
}

// ---- the page ----

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main(): Promise<void> {
  renderNav('start');
  const checking = $('checking');
  const missing = $('missing');
  const intro = $('intro');
  const area = $('testArea');
  const wordGrid = $('testWords');
  const result = $('result');
  const submit = $<HTMLButtonElement>('testSubmit');

  let words: SampleWord[] = [];
  const picked = new Set<string>();

  function start(): void {
    words = sample();
    picked.clear();
    wordGrid.replaceChildren(
      ...words.map(({ lemma }) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = lemma;
        chip.setAttribute('aria-pressed', 'false');
        chip.addEventListener('click', () => {
          const on = !picked.has(lemma);
          picked[on ? 'add' : 'delete'](lemma);
          chip.setAttribute('aria-pressed', String(on));
          chip.classList.toggle('on', on);
        });
        return chip;
      }),
    );
    intro.hidden = true;
    result.hidden = true;
    area.hidden = false;
  }

  function showResult(text: string): void {
    area.hidden = true;
    result.hidden = false;
    result.replaceChildren();
    const p = document.createElement('p');
    p.textContent = text;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn';
    retry.textContent = '다시 하기';
    retry.addEventListener('click', () => {
      result.hidden = true;
      intro.hidden = false;
    });
    result.append(p, retry);
  }

  $('startTest').addEventListener('click', start);

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const cutoff = cutoffFor(words, picked);
      if (cutoff === 0) {
        showResult('표시할 단어를 찾지 못했어요. 글을 읽으면서 직접 단어 상태를 표시해보세요.');
        return;
      }
      const res = await callExtension('seedBands', { cutoff }, 5000);
      if (res?.type !== 'seeded') {
        showResult('확장 프로그램에 결과를 전달하지 못했어요. 확장 프로그램을 새로고침한 뒤 이 페이지를 다시 열어 주세요.');
        return;
      }
      const added = Number(res.added) || 0;
      showResult(
        added
          ? `자주 쓰는 단어 ${added}개를 '아는 단어'로 표시했어요. 나머지는 글을 읽으면서 직접 표시하면 돼요.`
          : '이미 표시된 단어가 많아서 새로 추가된 단어는 없어요. 글을 읽으면서 직접 표시해보세요.',
      );
    } finally {
      submit.disabled = false;
    }
  });

  const found = await detectExtension();
  checking.hidden = true;
  if (found) intro.hidden = false;
  else missing.hidden = false;
}

main();
