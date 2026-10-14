import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');

mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });

const options = {
  entryPoints: {
    content: 'src/content.ts',
    background: 'src/background.ts',
    action: 'src/action.ts',
    library: 'src/library.ts',
  },
  outdir: 'dist',
  bundle: true,
  format: 'iife', // content scripts can't be ES modules
  target: 'chrome105',
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
