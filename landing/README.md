# DokHack (독해크) — landing page

Roadmap item 8: a small explainer page for the [extension](../extension) —
what it does, how the core loop works, and the two ways to start (the
placement test vs. just marking words while you read). Not a public
download funnel: this project isn't published anywhere yet (no git remote,
no Chrome Web Store listing), so the page's own "설치하기" section gives the
honest current path — build from source, load unpacked — rather than a
fake install button.

## Run it locally

No build step — it's plain HTML/CSS. Serve the `static/` folder with
anything:

```bash
npx serve static
```

## Deploy

Same pattern as [`../web`](../web) — Cloudflare Workers' static-assets
serving, `wrangler.toml` already points `[assets]` at `./static`:

```bash
npx wrangler login    # first time only
npx wrangler deploy
```

Prints the live `*.workers.dev` URL.

## How it's put together

```
static/
  index.html   the whole page — hero, how-it-works steps, what's-different
               grid, the two getting-started paths, install instructions
  pages.css    the same 단어장 design tokens as the extension's and the
               review site's pages.css (kept in sync by hand — see the
               comment at the top of the file)
```

One page, no JS. If this grows past a single page later, split it then —
no reason to add a build step or a framework for one static page.

Content is drawn from the extension's own README/CLAUDE.md rather than
invented — the "what's different" section states only things that are
actually true of the shipped extension (real dictionaries not AI, no DOM
rewriting, phrasal-verb/connector merging, YouTube subtitle mining).
