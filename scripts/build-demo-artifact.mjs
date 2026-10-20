#!/usr/bin/env node
// Builds the demo-mode web app as ONE self-contained HTML page (scripts, styles and fonts inlined),
// for sharing a clickable demo. Fictional data only: the page runs the demo backend in the browser
// and makes no network requests.
//
//   node scripts/build-demo-artifact.mjs   ->  dist-artifact/auranotetaker-demo.html

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = join(root, 'dist-artifact/.build');
const out = join(root, 'dist-artifact/auranotetaker-demo.html');

rmSync(join(root, 'dist-artifact'), { recursive: true, force: true });

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  plugins: [react()],
  define: { 'import.meta.env.VITE_APP_MODE': JSON.stringify('demo') },
  build: {
    outDir: tmp,
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000, // fonts become data: URIs inside the CSS
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: false,
  },
});

const assets = join(tmp, 'assets');
const files = readdirSync(assets);
const js = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(assets, f), 'utf8'));
const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(assets, f), 'utf8'));
if (js.length !== 1 || css.length !== 1) throw new Error(`Expected one JS and one CSS file, got ${js.length} and ${css.length}`);

const safeJs = js[0].replace(/<\/script/gi, '<\\/script');
const safeCss = css[0].replace(/<\/style/gi, '<\\/style');

const page = `<title>AuraNoteTaker Pro</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="robots" content="noindex, nofollow">
<style>${safeCss}</style>
<div id="root"></div>
<script type="module">${safeJs}</script>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote ${out} (${Math.round(page.length / 1024)} KB)`);
