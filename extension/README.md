# DokHack (독해크)

A sentence-mining browser extension for Korean speakers reading English: Kimchi Reader in reverse. It colors the words you don't know yet on any English page, with a hover cue showing they're clickable. Click a word to see its dictionary form, English definitions, and a best-guess Korean meaning (both from real, bundled dictionaries, not AI, not a network call), then make a card from the sentence for review.

## Run it

```bash
npm install
npm run build        # or: npm run watch
```

1. Open `chrome://extensions` (or `whale://extensions` in Naver Whale).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick the `dist/` folder.
4. Open any English article. Unknown words get a blue tint; words you're learning get yellow.

After changing code, run the build again and click the reload icon on the extension card. Then refresh the tab you're testing on.

### Using it

| Action | How |
| --- | --- |
| Highlight a page's words | Toolbar icon → **이 페이지 스캔하기** (and **스캔 끄기** to stop). Nothing is highlighted until you do — pages stay untouched and fast. To scan every page automatically, turn on **페이지를 열 때마다 자동으로 스캔** (same popup, or 설정 → 스캔 설정). |
| Look up a word | Click it. Inside links or buttons, use **Alt+click**. |
| Set status | `1` 모름, `2` 봤어요, `3` 학습 중, `4` 알아요, or click the buttons. Opening an unknown word marks it 봤어요 automatically (switch off in 설정 → 스캔 설정). |
| See how much of a page you know | After **이 페이지 스캔하기**, the popup shows "이 페이지 단어의 N%를 알아요" with a bar. |
| Pause after every subtitle line (YouTube) | Off by default. Turn on with the **줄마다 멈춤** chip on the transcript panel, or in 설정 → 스캔 설정. |
| Export to Anki with audio and screenshots | 설정 → **Anki용 내보내기 (미디어 포함)** — a zip with an Anki text file plus the clips/frames and a README on where to copy them. |
| Import words you already know | 설정 → **단어 목록 가져오기** — paste or upload a word list, an Anki notes-as-text export, or any English text. |
| Read pasted text (e.g. on a phone) | The website's **읽기** tab: paste English, tap words, mark them, make cards. |
| Make a card | `S` or **카드 만들기** — opens an editor to pick which meanings to keep (Korean and/or English, filterable) and edit/expand the sentence before saving (also marks the word 학습 중) |
| Close | `Esc` or click elsewhere |
| Turn off on a site | Toolbar icon, then the switch |
| See saved sentences | The review website's **카드** tab (the extension's own card list was removed; the toolbar button now opens **설정**) |
| Export to Anki / CSV | Toolbar icon → **설정** → **카드 내보내기** |
| Seed known words | Review website → **시작하기 → 아는 단어 테스트** (`/placement`) — an opt-in placement test that bulk-marks common words you already know; the result reaches the extension through its content script (the options page just links there) |
| Review with spaced repetition | 설정 → **복습 웹사이트** — link an account (email code, no password) and your cards sync to [the companion review site](../web) for FSRS-scheduled review on any device |
| Open the website (home, review, cards) | Toolbar icon → **웹사이트 열기** (a red badge shows how many cards are due today), or the **저장한 카드는 웹사이트에서 ↗** link on 설정 |
| Preview or edit a saved card | The review website's **카드** tab — it plays a captured YouTube clip and shows its frame once uploaded. Website edits come back to the extension on **모두 동기화** |
| Mine a YouTube video's captions | Opens automatically: a 독해크-styled transcript panel appears in the sidebar and a subtitle bar over the video, both plain-clickable (no Alt needed, unlike YouTube's own panel). Click the ▶ icon on any line to jump the video there. Falls back to Alt+click on YouTube's own **Show transcript** panel if the video has no captions to harvest, or the YouTube UI isn't in English. |

The plain CSV export has four fields: Sentence (target word in `<b>`), Word, Meaning, and Source. In Anki's import dialog, tick **Allow HTML in fields**.

## How it's put together

```
src/
  content.ts        click hit-testing, hover cue, sentence/context extraction,
                     keyboard shortcuts
  highlighter.ts    finds block-level chunks of text, batches them to the worker,
                     maps tokens back onto their text node(s), paints highlights
                     (status colors + the hover cue)
  popup.ts          the small word card (closed shadow DOM, so page CSS can't touch it)
  editor.ts         the card editor — a centered modal (own shadow DOM) for picking
                     meanings (한국어/영어/둘 다) and editing/expanding the sentence
  krdict.ts         local English -> Korean gloss lookup (no network), ranks
                     candidates from static/krdict.json with a Lesk-style heuristic
  wordnet.ts        local English definition lookup (no network), same idea as
                     krdict.ts but from static/wordnet.json (Princeton WordNet)
  youtube.ts        custom transcript viewer + subtitle bar for YouTube watch
                     pages, synced to video playback (plain light-DOM elements
                     so the existing highlighter mines their text like any page)
  wordlist.ts        frequency-band word list backing the website's placement test
  background.ts     service worker: NLP, dictionary lookup, Korean gloss lookup,
                     account/sync, all storage writes
  nlp.ts             wink-nlp tokenizing + POS-aware lemmas ("mice" → "mouse"),
                     plus merging phrasal verbs and connectors ("give up",
                     "as a result") into one token
  storage.ts         chrome.storage.local helpers
  library.ts         saved sentences, CSV export, account linking
  action.ts          toolbar popup
  config.ts          Supabase project URL + anon key, review site URL (fill in
                     the Supabase values yourself, see ../web)
static/              manifest, HTML, CSS, krdict.json, wordnet.json, phrases.json
                     (copied to dist/)
scripts/             extract-krdict.mjs / extract-wordnet.mjs — regenerate the
                     dictionary + phrasal-verb JSON files; connectors.mjs — the
                     hand-curated discourse-connector list both scripts fold in;
                     none of these run at build time, only when re-syncing data
```

The companion review website lives in a sibling project, [`../web`](../web) —
FSRS-scheduled review, reachable from any device. See its own README. A
small explainer/landing page lives in [`../landing`](../landing).

A few decisions worth knowing about:

- **No DOM rewriting.** Words are painted with the CSS Custom Highlight API (`::highlight()`), not wrapped in `<span>`s. Site layouts and scripts keep working, and long pages stay fast. Clicks are resolved with `caretPositionFromPoint`.
- **The NLP model lives in the service worker.** It's about 3 MB, so it loads once there instead of in every tab. The content script sends text to the worker in batches (it's grown past its original ~15 KB target since the card editor UI has to ship there too — see CLAUDE.md).
- **Word status is keyed by lemma.** Marking "run" known also covers "ran", "running", and "runs". Capitalized proper nouns (Seoul, Netflix) are skipped.
- **One writer.** Content scripts only read storage. Every write goes through the service worker, so two tabs can't overwrite each other.
- **Sentences cross inline tags.** Sentence extraction works on the whole block element, using `Intl.Segmenter`. A sentence with a link in the middle is saved in one piece. Highlighting works the same way now: it tokenizes a whole block at once (not each text node separately), so a sentence split by `<a>`/`<b>` — or even a single word split mid-word by markup — gets correct part of speech and lemma instead of being tagged in disconnected fragments.
- **Accounts are opt-in and local-first.** With nothing linked, the extension makes zero account-related network calls and behaves exactly as if the feature didn't exist. Linking (email code via Supabase Auth) only adds a fire-and-forget sync of newly-saved cards; nothing about mining or highlighting depends on it.
- **No AI calls, anywhere — and no network calls for word meanings at all.** Considered letting people connect an AI service they already pay for (Claude Pro, ChatGPT Plus), but those subscriptions don't grant API access — the API is a separate, metered product on both platforms, billed per token regardless of what you already pay for as a consumer. Bring-your-own-API-key was also considered and declined. Both Korean and English meanings instead come from real dictionaries bundled with the extension — `static/krdict.json` (KRDICT/국립국어원) and `static/wordnet.json` (Princeton WordNet) — looked up locally with no network call. English definitions used to come from the free dictionaryapi.dev, but that turned out unreliable (requests routinely taking ~20s or failing outright); WordNet replaced it entirely rather than just adding a timeout. One side effect: there's no bundled pronunciation audio or IPA anymore, only the browser's built-in text-to-speech.
- **Word meanings are a best guess, not a guarantee, on both sides.** A word like "run" has dozens of possible meanings across senses, in Korean and in English alike. `krdict.ts` and `wordnet.ts` each rank their candidates by how much the clicked word's sentence overlaps with each candidate's stored definition (both sides lemmatized so "felt"/"feels"/"feeling" match, and the headword itself excluded from the comparison so a definition that happens to mention it doesn't win by default), plus a part-of-speech bonus — good enough to usually surface a sensible answer first, not true disambiguation. Pick a different checkbox in the editor if the top pick is wrong for that sentence.
- **Card sync degrades honestly instead of hanging.** Every network call the extension makes to Supabase has a timeout, so a slow or dead connection shows as a failure within a few seconds rather than "복습하러 가기" or "모두 동기화" spinning forever. A dead login session clears itself (you'll see "signed out," not a account that looks linked but silently never syncs), and re-running "모두 동기화" only pushes cards that haven't made it up yet, so it's safe to press more than once.
- **Phrasal verbs and discourse connectors highlight as one word, when they're written together — and now even when something's in between.** "Give" and "up" in "gave up" merge into a single clickable, trackable unit ("give up"), the same way "ran" already collapses to the lemma "run" — built from WordNet's own list of multi-word verb entries (`static/phrases.json`). Fixed phrases that function as one adverbial unit ("as usual," "in a nutshell") merge the same way, topped up with a short hand-curated list (`scripts/connectors.mjs`) for common connectors WordNet doesn't have at all, like "as a result" and "due to". This also works across markup ("give <em>up</em>") now that tokenizing happens per block. A *split* phrasal verb ("turn the lights off") now merges too, via a bounded heuristic: it scans a short, plausible object noun phrase (determiner/adjective/noun/pronoun words only, no punctuation) between the verb and a matching particle, up to 4 words — real dependency parsing would place the object properly, which the bundled NLP model doesn't have, so this is the cheaper approximation. One merge quality issue remains, narrow and not specific to the split case: a merge that's technically adjacent (or now, nearby) but semantically wrong for that sentence ("ran up the stairs" merges to the idiomatic "run up" even though it's meant literally here) — matching by word-adjacency/proximity alone can't tell those apart.
- **YouTube subtitle mining needed almost no new code.** Nothing about highlighting is page-specific — it already tokenizes any text on any page — so once you open YouTube's own transcript panel, its caption lines just become mineable text like any paragraph. The only real additions: a caption line's on-screen timestamp is excluded from tokenizing (it sits right next to the caption text in the DOM with no guaranteed space between them, which would otherwise fuse into the line's first word), and each caption line's *sibling lines* stand in for "neighboring sentences" so the editor's "+ 앞/뒤 문장" buttons have something to pull in — auto-generated captions have no punctuation to split a shared paragraph into sentences the normal way, because there is no shared paragraph; each line is its own element.
- **The transcript viewer and subtitle bar reuse that same pipeline, on purpose.** `youtube.ts` harvests the line list from YouTube's own transcript panel once (opening then closing it programmatically, so you never see or mine the same lines twice), then renders its own copy — plain elements, not a shadow root, so the very same click/highlight code above just works on them with no changes. The one addition is `transcriptContextFor()`, letting `content.ts` treat a word's *other* rendered lines as its neighboring sentences, same idea as the sibling-lines trick above. Clicking a word in the subtitle bar also pauses the video by default, so the line doesn't move on while you're reading the lookup; the transcript panel doesn't, since it's meant for browsing independently of playback. If harvesting fails (no captions, or a non-English YouTube UI, since the button/tab lookups are by English label), nothing extra shows up — the original Alt+click-on-native-panel workflow still works unchanged. Getting the harvesting and closing right took a live pass to find: YouTube's actual trigger, duplicate-panel, and layout behavior all differed from what the reference markup (captured mid-load) suggested — see CLAUDE.md for the specifics.

## Known gaps / next steps

Roughly in the order I'd tackle them:

1. ~~**Known-word seeding.**~~ Done, and since moved to the review website (`../web`'s `/placement`, which sends the result back through the extension's content script — see CLAUDE.md roadmap item 14): an opt-in placement test — pick the words you know from a short sample and it bulk-marks similar, equally-common words as known. It's off by default; marking words one at a time by reading is still how the extension behaves out of the box. The frequency list (`src/wordlist.ts`) is a hand-built ~600-word heuristic, not real corpus data yet — see gap 5.
2. ~~**Review screen.**~~ Done, but on the [companion website](../web) rather than in-extension, so review works on devices the extension can't run on (iPhone Safari). Confirmed working live, including "다시" (Again) correctly requeuing a card within the same session.
3. ~~**Contextual Korean gloss (AI).**~~ Removed, not kept as an option — see the "No AI calls, anywhere" note above.
4. ~~**Phrasal verbs.**~~ Done — contiguous ones ("giving up"), fixed discourse connectors ("as a result," "due to," "in terms of"), and now split ones too ("turn the lights off") via a bounded noun-phrase-scanning heuristic — see the note above.
5. ~~**Better lemmas across inline tags.**~~ Done — tokenizing now happens per block element (`highlighter.ts`), not per text node, with offsets mapped back onto the actual text node(s) afterward (a highlighted word can legitimately span more than one). Verified against jsdom + wink-nlp for a sentence split by `<b>`, a word split *mid-word* by markup, and a link in the middle of a sentence.
- **Word frequency data:** `static/frequency.json` (the common/rare badge) is generated by `scripts/extract-frequency.mjs` from the OpenSubtitles 2018 frequency list in [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords) (`content/2018/en/en_50k.txt`, CC BY-SA 4.0). The downloaded list isn't committed; run `node scripts/extract-frequency.mjs <path to en_50k.txt>` to rebuild.

6. ~~**Dictionary data.**~~ Done — this is what replaced the AI gloss: real English→Korean (KRDICT/국립국어원, CC BY-SA, `static/krdict.json`) and English (Princeton WordNet, `static/wordnet.json`) dictionaries, both bundled and looked up fully offline. WordNet replaced `dictionaryapi.dev`, which turned out unreliable — no more IPA/audio, since WordNet doesn't have those; pronunciation is browser TTS only now.
7. ~~**YouTube subtitles.**~~ Done, in two layers now — Alt+click on YouTube's own panel, plus a custom transcript viewer + subtitle bar modeled on Kimchi Reader's equivalent pair (see the notes above). Confirmed working live on a real video (see CLAUDE.md's Testing section) — several harvesting/closing bugs turned up and got fixed in the process, since the original design was based on markup captured before YouTube's transcript UI had finished loading. A card mined from either surface can now also carry a real audio clip (the video's own soundtrack, not the mic) and a video-frame screenshot, auto-bounded by the transcript lines' timestamps and re-recordable/adjustable in the editor — see gap 11, below, split out as its own item since it ended up substantial enough to track separately. Mobile *mining* is still open (mobile *review* already works via the website); mobile Chrome/Whale don't support extensions at all, so this needs a different mechanism entirely, not "the extension" running on a phone.
8. ~~**Sync.**~~ Done — email-code accounts via Supabase, opt-in, extension writes / website reads+reschedules, and now website reviews also feed back: a word gets auto-marked 알아요 once it's been reviewed enough times without a single lapse, so a well-learned word doesn't just sit in 학습 중 forever waiting to be noticed by hand. Confirmed working live originally; later found silently getting stuck (no timeouts, a dead refresh token retried forever, duplicate-prone re-syncing) and fixed — see the "Card sync degrades honestly" note above. Not yet: Google/Discord OAuth.
9. ~~**Landing page.**~~ Done — [`../landing`](../landing), a small static explainer page (no build step): the core loop, what's actually different (not aspirational), and the two starting paths (placement test vs. just marking words as you read). No public download link — this project isn't published anywhere yet, so its install section is honest about that (build from source, load unpacked).
10. **Better Korean ranking for polysemous words.** "Run" (~35 candidates) tends to surface the generic verb 하다 ("to do") over more specific matches like 운영하다 ("to run a business"). One direction is done: a candidate that was the *first*-listed synonym in KRDICT's own translation field now gets a small ranking bonus over a buried alternate translation — the Korean-side equivalent of a signal `wordnet.ts` already got for free from WordNet's frequency-ordered sense lists. Not yet live in the shipped dictionary data, though — it needs `scripts/extract-krdict.mjs` re-run against a fresh KRDICT dump. Biasing against generic Korean words specifically (하다's actual problem) is still open; see CLAUDE.md's roadmap item 10.
11. **YouTube audio-clip + frame capture for a mined card.** A card mined from the custom transcript panel/subtitle bar (see gap 7) can carry a real audio clip of that moment's own video soundtrack and a screenshot of the frame, auto-bounded by the transcript timestamps, with a re-record button, ±0.5s manual nudges, and a frame retake button in the editor. Captured blobs live in the extension's own IndexedDB (not inline in the card data), referenced by id. Built, typechecked, and partly verified live (see CLAUDE.md's Testing section for exactly what's confirmed vs. still pending an end-to-end pass in the loaded extension).
12. ~~**Website navigation and card preview/edit.**~~ Done (see CLAUDE.md roadmap item 12) — the website now has a shared nav (홈 · 복습 · 카드), a real home page, and a cards page; saved cards can be previewed and edited in both the website and this extension's library page, with edits syncing both ways. Not yet run against the real Supabase project or deployed, and deleting a card is still one-sided. More visual polish of the extension and website is still open.
