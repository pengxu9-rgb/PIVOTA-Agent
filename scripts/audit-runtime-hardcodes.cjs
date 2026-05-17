#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['src', 'docs', 'scripts'];
const SKIP_PARTS = new Set(['node_modules', '.git', 'reports', 'scripts/fixtures']);
const FORBIDDEN_STRINGS = [
  'merch_' + '208139f7600dbf42',
  'merch_' + '6b90dc9838d5fd9c',
  'merch_' + 'efbc46b4619cfbdf',
  'store_shopify_' + 'chydan' + 'test',
  'psp_stripe_' + 'chydan' + 'test',
  'chydan' + 'test',
];
const FORBIDDEN = FORBIDDEN_STRINGS.map((value) => new RegExp(value, 'gi'));

function shouldSkip(relPath) {
  const normalized = relPath.split(path.sep).join('/');
  if (normalized === 'scripts/audit-runtime-hardcodes.cjs') return true;
  if (SKIP_PARTS.has(normalized)) return true;
  return normalized
    .split('/')
    .some((part, idx, parts) => SKIP_PARTS.has(parts.slice(0, idx + 1).join('/')) || SKIP_PARTS.has(part));
}

function listFiles(dir, out = []) {
  const rel = path.relative(ROOT, dir);
  if (rel && shouldSkip(rel)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const entryRel = path.relative(ROOT, full);
    if (shouldSkip(entryRel)) continue;
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const violations = [];
for (const root of SCAN_ROOTS) {
  const abs = path.join(ROOT, root);
  if (!fs.existsSync(abs)) continue;
  for (const file of listFiles(abs)) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      for (const pattern of FORBIDDEN) {
        pattern.lastIndex = 0;
        if (pattern.test(lines[i])) violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
}

if (violations.length) {
  console.error('Runtime hardcode audit failed. Remove real merchant/test-store defaults:');
  for (const line of violations) console.error(`- ${line}`);
  process.exit(1);
}

console.log('Runtime hardcode audit passed.');
