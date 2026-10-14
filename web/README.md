# DokHack (독해크) — review website

The companion site to the [DokHack extension](../extension) — an FSRS-scheduled
review queue for the sentences you've mined, reachable from any device (including
iPhone Safari, unlike the extension itself). Signing in here is independent from
signing in in the extension: both just authenticate the same Supabase account by
email, and a card synced from either side lands in the same row set. There's no
separate "linking" step.

## One-time setup (you do this — see CLAUDE.md's roadmap notes for why)

1. Create a free project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run [`schema.sql`](schema.sql) — creates the `cards`
   table with row-level security, so each signed-in user only ever sees their
   own rows.
3. **Auth → Emails → SMTP Settings**: Supabase's dashboard won't let you edit
   email templates at all until custom SMTP is configured (a newer
   restriction — its own built-in mailer still sends the *default* template
   either way). No domain needed: [Resend](https://resend.com)'s free tier
   works out of the box with its shared `onboarding@resend.dev` sender.
   Enter host `smtp.resend.com`, port `465`, username `resend` (the literal
   word, not your account email), password = your Resend API key, sender
   `onboarding@resend.dev`. Save.
4. **Auth → Emails → Templates**: edit **both "Confirm signup" and "Magic
   Link"** (the first fires for a brand-new email, the second for a
   returning sign-in — easy to only do one and then get a broken flow on
   whichever path you didn't test). By default each template only includes
   `{{ .ConfirmationURL }}` (a clickable link). Replace it with something
   that shows `{{ .Token }}` instead — DokHack's sign-in flow asks
   people to type a code, not click a link (this matters especially for the
   extension, where clicking an emailed link doesn't naturally get you back
   into the extension's settings page). Note the code's length isn't
   necessarily 6 digits — ours turned out to be 8; the input fields don't
   assume a fixed length. A minimal template body:
   `<p>Your DokHack code: <strong>{{ .Token }}</strong></p>`.
5. Copy your project's **URL** and **anon public key** (Settings → API) into:
   - `src/config.ts` here
   - `../extension/src/config.ts` (the extension)

   The anon key is safe in both places — row-level security is what actually
   protects each user's data, not secrecy of this key.
6. In `../extension/static/manifest.json`, tighten `host_permissions` from the
   wildcard `https://*.supabase.co/*` to your exact project URL if you'd like
   (optional; the wildcard works fine too).

## Run it

```bash
npm install
npm run build        # or: npm run watch
```

`npm run build` writes to `dist/`. Serve that directory with any static file
server to test locally (e.g. `npx serve dist`).

## Deploy

Cloudflare now steers new projects toward Workers' static-assets serving
rather than classic Pages (`wrangler pages deploy` currently fails to
auto-detect the `dist` directory and errors out) — `wrangler.toml` here
already points `[assets]` at `./dist`:

```bash
npx wrangler login    # first time only
npx wrangler deploy
```

Prints the live `*.workers.dev` URL — ours is `dokhack-review.dokhack.workers.dev`
(the second segment is the account's `workers.dev` subdomain, changed once
from Cloudflare's random default; dashboard → Workers & Pages → your
account → Workers.dev subdomain — account-wide, affects every worker on the
account). If deploy fails with error 10034, the Cloudflare account's email
isn't verified yet — check the account email inbox or the dashboard for a
verification prompt. The bare domain root is `static/index.html` — now the
home page itself (it sends you to `sign-in.html` if you're signed out), not a
redirect.

## How it's put together

```
src/
  config.ts     Supabase project URL + anon key
  supabase.ts   email-OTP session handling (fetch-based, no SDK) + apiFetch()
  sign-in.ts    email -> code -> session
  nav.ts        the shared nav (top bar on desktop, bottom tab bar on phones)
  cards-api.ts  the `cards` row shape + fetch/patch/delete helpers shared by pages
  home.ts       the home page: due count, stats, recent cards
  review.ts     the FSRS review queue (ts-fsrs)
  cards.ts      browse/search/filter all cards; preview, edit, delete
  start.ts      the public start page: nav + a sign-in/home button swap
  placement.ts  the known-word placement test (talks to the extension's content script)
static/         HTML + CSS. pages.css = the same 단어장 design tokens as the
                extension's pages.css (kept in sync by hand); site.css =
                website-only layout (nav, home, cards page)
schema.sql      the `cards` table + RLS policy
wrangler.toml   Workers static-assets config (points [assets] at ./dist)
```

Pages: `read.html` (읽기 — paste English, tap words, mark them, make cards; reuses the extension's tokenizer and dictionaries, whose ~23 MB of JSON `build.mjs` copies in from `../extension/static` and which load only on the first tapped word), `index.html` (홈, the root URL — redirects to `sign-in.html` when signed
out), `review.html` (복습), `cards.html` (카드), `sign-in.html`. Every signed-in
page mounts the same nav, whose 복습 tab carries a badge with today's due count.

`placement.html` (아는 단어 테스트, linked from 시작하기) is the known-word placement
test. It needs the DokHack extension in the *same browser*: the page pings the
extension's content script over `window.postMessage`, and on finishing sends it
how many frequency bands the reader knows; the extension marks those words
"known". Without the extension it shows a not-found message instead.
`src/placement.ts` imports its word list straight from
`../extension/src/wordlist.ts`, so the extension's source tree must sit beside
this folder when you build.

Card *content* (sentence, definitions) is created by the extension while
mining, but can be edited here too (`cards.html` → 편집 — only the sentence and
definitions; FSRS scheduling fields are never touched by an edit) or deleted.
The extension picks website-side edits up on its next 모두 동기화. Audio clips
and video frames captured in the extension live only in the extension's own
storage by default; run the media block in `schema.sql` once and the extension uploads them to a private Supabase Storage bucket, after which the preview and the review card show the video frame and play the clip.

## Second SQL block: vocabulary and activity

`schema.sql` ends with a block that adds four tables — `vocab`, `vocab_inbox`, `vocab_daily`, `review_log` — plus their row-level-security policies. Run it once, like the card-media block. It powers the home page's 학습 현황 (word counts, growth line, activity heatmap) and the 읽기 reader's word statuses; the extension fills them on every 모두 동기화. Without it those sections stay empty and the reader can't remember word marks, but nothing else breaks.

## Start page and the extension download

`start.html` (시작하기) is the public instructions page: what DokHack does, how
to install it, how to link an account. It's reachable signed out (the nav shows
시작하기 + 로그인) and `sign-in.html` links to it. Its download button serves
`static/dokhack-extension.zip`, a zip of `../extension/dist` that is **not**
rebuilt automatically — refresh it whenever the extension changes, then
redeploy:

```powershell
cd ../extension; npm run build
Compress-Archive -Path dist\* -DestinationPath ..\web\static\dokhack-extension.zip -Force
cd ../web; npm run build; npx wrangler deploy
```

(Workers static assets allow files up to 25 MB; the zip is ~7 MB.) This page
replaced `../landing`, which is left in place but no longer needed.

## Known gaps

- Email OTP only — no Google/Discord OAuth yet.
- No AI-generated Korean gloss (removed by design — see the extension's
  CLAUDE.md roadmap item 3).
- Deleting a card here removes it from the website only; the extension keeps
  its local copy. Deleting in the extension likewise leaves the website's row.
- Pages other than review fetch every card in one request (capped at 5000) —
  fine at personal scale, no pagination yet.

Confirmed working end-to-end against a real Supabase project
(`ulanrdugzsftblaluaed`) and Resend: sign-in with an emailed code, mining a
card from the extension, seeing it appear in the review queue, rating it,
and "다시" (Again) correctly requeuing the card within the same session
instead of dropping it (`rate()` in `review.ts` re-inserts it a few cards
back rather than just shifting it off — the previous behavior silently
dropped it until the next page load).
