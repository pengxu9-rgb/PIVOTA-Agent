'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  isContentKey,
  makeContentKey,
} = require('../../scripts/lib/compute-content-key.cjs');

const fixturePath = path.join(__dirname, '..', 'fixtures', 'content_key_v1_cases.json');
const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

test('compute-content-key matches the Python content_key v1 fixture', () => {
  assert.ok(cases.length >= 20);
  assert.ok(cases.some((entry) => String(entry.name || '').startsWith('ordinary_niacinamide')));

  for (const entry of cases) {
    assert.equal(
      makeContentKey(entry.brand, entry.title, entry.gtin),
      entry.content_key,
      entry.name,
    );
    if (entry.content_key) assert.equal(isContentKey(entry.content_key), true, entry.name);
  }
});

test('catalog sync scripts call the centralized helper for new content_key values', () => {
  const scriptNames = [
    'sync-external-seeds-to-catalog.cjs',
    'sync-ulta-external-seeds-to-catalog.cjs',
  ];

  for (const scriptName of scriptNames) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', scriptName), 'utf8');
    assert.match(source, /compute-content-key\.cjs/, scriptName);
    assert.match(source, /makeContentKey\(/, scriptName);
    assert.doesNotMatch(source, /stableHash\('ck'/, scriptName);
  }
});
