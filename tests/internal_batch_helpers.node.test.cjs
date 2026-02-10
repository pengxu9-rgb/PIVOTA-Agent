const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function helpersPath() {
  return path.join(__dirname, '..', 'scripts', 'internal_batch_helpers.mjs');
}

async function loadHelpers() {
  return import(pathToFileURL(helpersPath()).href);
}

test('internal batch helpers: runTimestampKey includes seconds and milliseconds', async () => {
  const { runTimestampKey } = await loadHelpers();

  const key = runTimestampKey(new Date(Date.UTC(2026, 1, 10, 3, 4, 5, 678)));
  assert.equal(key, '20260210_030405678');
  assert.match(key, /^\d{8}_\d{9}$/);
});

test('internal batch helpers: runTimestampKey changes across millisecond ticks', async () => {
  const { runTimestampKey } = await loadHelpers();

  const a = runTimestampKey(new Date(Date.UTC(2026, 1, 10, 3, 4, 5, 678)));
  const b = runTimestampKey(new Date(Date.UTC(2026, 1, 10, 3, 4, 5, 679)));
  assert.notEqual(a, b);
});
