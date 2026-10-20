#!/usr/bin/env node
// Copies the dependency-free domain code in lib/ into base44/shared/lib/, because Base44 backend
// functions can only import code inside the base44/ folder.
//
//   node scripts/sync-base44-shared.mjs          write the copy
//   node scripts/sync-base44-shared.mjs --check  fail if the copy is out of date (used in CI)
//
// Edit lib/, never base44/shared/lib/.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = ['lib/core', 'lib/dentally', 'lib/server'];
const TARGET = join(root, 'base44/shared/lib');
const check = process.argv.includes('--check');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const expected = new Map();
for (const src of SOURCES) {
  for (const file of walk(join(root, src))) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    // Demo data and barrel files never ship to the backend: functions import modules directly.
    if (file.endsWith('/mock.ts') || file.endsWith('/index.ts')) continue;
    const rel = relative(join(root, 'lib'), file);
    const header = `// GENERATED from lib/${rel} by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.\n`;
    expected.set(join(TARGET, rel), header + readFileSync(file, 'utf8'));
  }
}

const existing = existsSync(TARGET) ? walk(TARGET) : [];

if (check) {
  const problems = [];
  for (const [path, content] of expected) {
    if (!existsSync(path)) problems.push(`missing ${relative(root, path)}`);
    else if (readFileSync(path, 'utf8') !== content) problems.push(`stale ${relative(root, path)}`);
  }
  for (const path of existing) if (!expected.has(path)) problems.push(`unexpected ${relative(root, path)}`);
  if (problems.length) {
    console.error('base44/shared/lib is out of date. Run: npm run sync:shared\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`base44/shared/lib is up to date (${expected.size} files).`);
} else {
  rmSync(TARGET, { recursive: true, force: true });
  for (const [path, content] of expected) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  console.log(`Wrote ${expected.size} files to ${relative(root, TARGET)}.`);
}
