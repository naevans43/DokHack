import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');

mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });
// The paste-text reader (src/read.ts) reuses the extension's tokenizer and
// dictionaries, which fetch these data files from the site root. They live in
// the extension's static/ (build artifacts there); copy, don't duplicate.
for (const f of ['krdict.json', 'wordnet.json', 'phrases.json', 'konglish.json', 'expressions.json', 'families.json', 'wiktionary.json', 'ko-fixes.json']) cpSync(`../extension/static/${f}`, `dist/${f}`);

const options = {
  entryPoints: {
    'sign-in': 'src/sign-in.ts',
    review: 'src/review.ts',
    home: 'src/home.ts',
    cards: 'src/cards.ts',
    start: 'src/start.ts',
    placement: 'src/placement.ts',
    read: 'src/read.ts',
  },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
