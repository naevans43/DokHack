import { ask } from './messaging';
import { statusOf, type WordMap } from './storage';
import type { Token, WordStatus } from './types';

// Uses the CSS Custom Highlight API instead of wrapping words in <span>s:
// the page DOM is never modified, so layouts and site scripts don't break,
// and long pages stay fast. Styles live in content.css (::highlight(...)).

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
  'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'MATH', 'CANVAS', 'IFRAME',
]);
// YouTube's transcript panel (roadmap item 7) puts a timestamp element
// ("0:03") directly beside each caption line's text with no guaranteed
// whitespace between them in the DOM -- concatenated into the block's flat
// text as-is, that risks fusing onto the line's first word ("0:03Peptides").
// Not real sentence content either way, so exclude it like SKIP_TAGS.
// dokhack-yt-ts is our own transcript panel's timestamp badge (youtube.ts) --
// same reasoning, own class since it's our markup, not YouTube's.
const SKIP_CLASSES = new Set(['segment-timestamp', 'dokhack-yt-ts']);
const HAS_LATIN = /[a-z]/i;

// A block's text is tokenized as one string (see Unit below) so POS/lemmas
// stay accurate across inline tags ("I <b>really</b> like it" reads as one
// sentence, not three fragments) -- but an unusually large block (a whole
// article stuffed in one <div>, or text sitting directly in <body>) would
// mean one huge, slow tokenize() call. Past this size, fall back to
// per-text-node units for that one block, same as before this change.
const MAX_UNIT_CHARS = 20_000;

// The unit of tokenization: normally a block-level element (see blockOf()),
// or a single Text node when that block was too large (see MAX_UNIT_CHARS).
type Unit = Element | Text;

interface Entry { range: Range; lemma: string; }

/** Nearest non-inline ancestor of `node` -- the "sentence container" a run of inline markup sits inside. */
export function blockOf(node: Node): Element {
  for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
    const d = getComputedStyle(el).display;
    if (!d.startsWith('inline') && d !== 'contents') return el;
  }
  return document.body;
}

/** True when `node`'s nearest block is `unit` itself rather than a block nested inside it (same answer as blockOf(node) === unit, without styling every ancestor above the unit). */
function ownedBy(node: Text, unit: Element): boolean {
  for (let el = node.parentElement; el && el !== unit; el = el.parentElement) {
    const d = getComputedStyle(el).display;
    if (!d.startsWith('inline') && d !== 'contents') return false;
  }
  return true;
}

export class Highlighter {
  private unitOf = new WeakMap<Text, Unit>();
  private nodeFlatStart = new WeakMap<Text, number>(); // this node's offset within its unit's flat text
  private unitNodes = new WeakMap<object, Text[]>(); // unit -> the text nodes it was last built from
  private unitTokens = new WeakMap<object, Token[]>(); // unit -> tokens, in unit-flat coordinates
  private entries = new WeakMap<object, Entry[]>(); // unit -> its highlight ranges
  private byLemma = new Map<string, Set<Range>>();
  private hl: Record<'unknown' | 'seen' | 'learning' | 'hover', Highlight>;
  private queue = new Set<Unit>();
  private pumping = false;
  private generation = 0; // bumps on stop() so in-flight batches are dropped
  private observer?: MutationObserver;

  constructor(private words: WordMap, private ignoreRoot: () => Element | null) {
    this.hl = { unknown: new Highlight(), seen: new Highlight(), learning: new Highlight(), hover: new Highlight() };
    this.hl.hover.priority = 1; // paints over the status color, not under it
  }

  start(): void {
    CSS.highlights.set('mine-unknown', this.hl.unknown);
    CSS.highlights.set('mine-seen', this.hl.seen);
    CSS.highlights.set('mine-learning', this.hl.learning);
    CSS.highlights.set('mine-hover', this.hl.hover);
    this.enqueueSubtree(document.body);
    this.observer = new MutationObserver((muts) => this.onMutations(muts));
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  stop(): void {
    this.observer?.disconnect();
    this.queue.clear();
    this.generation++;
    this.pumping = false;
    CSS.highlights.delete('mine-unknown');
    CSS.highlights.delete('mine-seen');
    CSS.highlights.delete('mine-learning');
    CSS.highlights.delete('mine-hover');
    this.hl.unknown.clear();
    this.hl.seen.clear();
    this.hl.learning.clear();
    this.hl.hover.clear();
    this.byLemma.clear();
    this.unitOf = new WeakMap();
    this.nodeFlatStart = new WeakMap();
    this.unitNodes = new WeakMap();
    this.unitTokens = new WeakMap();
    this.entries = new WeakMap();
  }

  /** Token under a given text offset, if any. */
  tokenAt(node: Text, offset: number): Token | undefined {
    const unit = this.unitOf.get(node);
    const start = this.nodeFlatStart.get(node);
    if (!unit || start === undefined) return;
    const toks = this.unitTokens.get(unit);
    if (!toks) return;
    const flat = start + offset;
    return toks.find((t) => flat >= t.start && flat < t.end) ?? toks.find((t) => flat === t.end);
  }

  /**
   * How many word occurrences on the scanned page fall in each status, for the
   * popup's "you know N% of this page" line. Counts occurrences (running
   * words), not distinct lemmas -- that's what reading actually feels like.
   */
  stats(): { total: number; known: number; seen: number; learning: number; unknown: number; ignored: number } {
    const s = { total: 0, known: 0, seen: 0, learning: 0, unknown: 0, ignored: 0 };
    for (const [lemma, ranges] of this.byLemma) {
      const n = ranges.size;
      s.total += n;
      s[statusOf(this.words, lemma)] += n;
    }
    return s;
  }

  /** Paints (or clears, with `null`) a hover cue over the word under the pointer. */
  setHover(range: Range | null): void {
    this.hl.hover.clear();
    if (range) this.hl.hover.add(range);
  }

  /** Called when a status changes (in this tab or any other). */
  updateWords(words: WordMap): void {
    const old = this.words;
    this.words = words;
    const changed = new Set([...Object.keys(old), ...Object.keys(words)]);
    for (const lemma of changed) {
      if (old[lemma] === words[lemma]) continue;
      const ranges = this.byLemma.get(lemma);
      if (!ranges) continue;
      for (const r of ranges) {
        this.hl.unknown.delete(r);
        this.hl.seen.delete(r);
        this.hl.learning.delete(r);
        this.paint(r, statusOf(words, lemma));
      }
    }
  }

  // ---- internals ------------------------------------------------------

  private paint(range: Range, status: WordStatus): void {
    if (status === 'unknown') this.hl.unknown.add(range);
    else if (status === 'seen') this.hl.seen.add(range);
    else if (status === 'learning') this.hl.learning.add(range);
    // known / ignored: no highlight
  }

  /** Structural exclusion only (skip tags, editable, our own UI) -- not a "worth tokenizing" check. */
  private excluded(node: Text): boolean {
    const ignore = this.ignoreRoot();
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (SKIP_TAGS.has(el.tagName) || el.isContentEditable || el === ignore) return true;
      for (const cls of SKIP_CLASSES) if (el.classList.contains(cls)) return true;
    }
    return false;
  }

  /** All non-excluded text nodes inside `unit`, in document order. */
  private textNodesOf(unit: Unit): Text[] {
    if (unit.nodeType === Node.TEXT_NODE) return this.excluded(unit as Text) ? [] : [unit as Text];
    const out: Text[] = [];
    const walker = document.createTreeWalker(unit, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      // A nested block is its own unit: without this, a container with any
      // direct text (even the whitespace between its child blocks) would
      // re-tokenize -- and double-highlight -- everything inside it.
      if (!this.excluded(n as Text) && ownedBy(n as Text, unit as Element)) out.push(n as Text);
    }
    return out;
  }

  private enqueueSubtree(root: Node): void {
    if (root.nodeType === Node.TEXT_NODE) {
      if (!this.excluded(root as Text)) this.enqueue(this.unitFor(root as Text));
      return;
    }
    // block.textContent walks that block's whole subtree, so cache it per
    // block for this call -- otherwise every text node under the same
    // paragraph would independently re-concatenate the same text.
    const sizeCache = new Map<Element, number>();
    const seen = new Set<Unit>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text;
      if (this.excluded(text)) continue;
      const unit = this.unitFor(text, sizeCache);
      if (!seen.has(unit)) { seen.add(unit); this.enqueue(unit); }
    }
  }

  /** The block containing `node`, unless it's implausibly large -- then just `node` itself. */
  private unitFor(node: Text, sizeCache?: Map<Element, number>): Unit {
    const block = blockOf(node);
    let size = sizeCache?.get(block);
    if (size === undefined) {
      size = block.textContent?.length ?? 0;
      sizeCache?.set(block, size);
    }
    return size > 0 && size <= MAX_UNIT_CHARS ? block : node;
  }

  private enqueue(unit: Unit): void {
    this.queue.add(unit);
    if (!this.pumping) {
      this.pumping = true;
      this.pump();
    }
  }

  // Tokenizing happens in the background worker. Send text in batches,
  // then register ranges when idle so the page never stutters.
  private async pump(): Promise<void> {
    const gen = this.generation;
    while (this.queue.size && gen === this.generation) {
      const batch: { unit: Unit; text: string; nodes: Text[] }[] = [];
      let chars = 0;
      for (const unit of this.queue) {
        this.queue.delete(unit);
        if (!unit.isConnected) continue;
        const nodes = this.textNodesOf(unit);
        const text = nodes.map((n) => n.data).join('');
        if (text.length < 2 || !HAS_LATIN.test(text)) continue;
        batch.push({ unit, text, nodes });
        chars += text.length;
        if (batch.length >= 200 || chars >= 30_000) break;
      }
      if (!batch.length) continue;

      let results: Token[][];
      try {
        results = await ask<Token[][]>({ type: 'tokenize', texts: batch.map((b) => b.text) });
      } catch (err) {
        console.warn('[dokhack] tokenize failed', err);
        break; // e.g. extension reloaded; stop quietly
      }
      await idle();
      if (gen !== this.generation) return;
      batch.forEach(({ unit, text, nodes }, i) => {
        // Content may have changed while we waited; if so it's already re-queued.
        if (unit.isConnected && nodes.map((n) => n.data).join('') === text) {
          this.register(unit, nodes, results[i]);
        }
      });
    }
    if (gen === this.generation) this.pumping = false;
  }

  private register(unit: Unit, nodes: Text[], toks: Token[]): void {
    this.forget(unit);

    let flat = 0;
    const starts: number[] = [];
    for (const n of nodes) {
      starts.push(flat);
      flat += n.data.length;
      this.unitOf.set(n, unit);
      this.nodeFlatStart.set(n, starts[starts.length - 1]);
    }
    this.unitNodes.set(unit, nodes);

    /** The (node, localOffset) for a flat offset into this unit's concatenated text. */
    const locate = (flatOffset: number): { node: Text; offset: number } | null => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (starts[i] <= flatOffset) return { node: nodes[i], offset: flatOffset - starts[i] };
      }
      return null;
    };

    const entries: Entry[] = [];
    for (const t of toks) {
      const from = locate(t.start);
      const to = locate(t.end);
      if (!from || !to) continue; // shouldn't happen; defensive
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      entries.push({ range, lemma: t.lemma });
      let set = this.byLemma.get(t.lemma);
      if (!set) this.byLemma.set(t.lemma, (set = new Set()));
      set.add(range);
      this.paint(range, statusOf(this.words, t.lemma));
    }
    this.unitTokens.set(unit, toks);
    this.entries.set(unit, entries);
  }

  private forget(unit: Unit): void {
    const old = this.entries.get(unit);
    if (old) {
      for (const { range, lemma } of old) {
        this.hl.unknown.delete(range);
        this.hl.seen.delete(range);
        this.hl.learning.delete(range);
        this.byLemma.get(lemma)?.delete(range);
      }
    }
    const nodes = this.unitNodes.get(unit);
    if (nodes) for (const n of nodes) { this.unitOf.delete(n); this.nodeFlatStart.delete(n); }
    this.entries.delete(unit);
    this.unitNodes.delete(unit);
    this.unitTokens.delete(unit);
  }

  /** A node/subtree that just left the DOM -- forget whichever units its text nodes belonged to. */
  private forgetRemovedSubtree(root: Node): void {
    if (root.nodeType === Node.TEXT_NODE) {
      const unit = this.unitOf.get(root as Text);
      if (unit) this.forget(unit);
      return;
    }
    root.childNodes.forEach((n) => this.forgetRemovedSubtree(n));
  }

  private onMutations(muts: MutationRecord[]): void {
    const ignore = this.ignoreRoot();
    for (const m of muts) {
      if (ignore && ignore.contains(m.target)) continue;
      if (m.type === 'characterData') {
        this.enqueueSubtree(m.target as Text);
        continue;
      }
      m.removedNodes.forEach((n) => this.forgetRemovedSubtree(n));
      // The mutation's target (parent of the added/removed nodes) may still
      // hold other text that now needs re-tokenizing as part of the same
      // unit -- re-walk it, not just the added nodes themselves.
      this.enqueueSubtree(m.target);
      m.addedNodes.forEach((n) => this.enqueueSubtree(n));
    }
  }
}

function idle(): Promise<void> {
  return new Promise((resolve) => requestIdleCallback(() => resolve(), { timeout: 300 }));
}
