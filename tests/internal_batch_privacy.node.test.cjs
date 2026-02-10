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

test('internal batch privacy: sanitizer removes path/exif/base64/bbox_px', async () => {
  const { sanitizeForPrivacyText, findPrivacyIssues } = await loadHelpers();

  const localPath = '/Users/tester/Desktop/internal-test-photos/person_001.jpg';
  const rawBase64 = `data:image/jpeg;base64,${'A'.repeat(220)}`;
  const raw = [
    `path=${localPath}`,
    'EXIF GPSLatitude=37.7749',
    'meta DateTimeOriginal=2026:02:10 10:00:00',
    `blob=${rawBase64}`,
    'geom={"bbox_px":{"x":120,"y":88,"w":340,"h":420}}',
  ].join(' | ');

  const sanitized = sanitizeForPrivacyText(raw, { extraPaths: [localPath] });

  assert.equal(sanitized.includes(localPath), false);
  assert.equal(/GPSLatitude|DateTimeOriginal/.test(sanitized), false);
  assert.equal(sanitized.includes('bbox_px'), false);
  assert.equal(sanitized.includes(rawBase64), false);

  const issues = findPrivacyIssues(sanitized, { extraPaths: [localPath] });
  assert.deepEqual(issues, []);
});

test('internal batch privacy: assertPrivacySafeText blocks unsafe text and accepts sanitized text', async () => {
  const {
    assertPrivacySafeText,
    sanitizeForPrivacyText,
  } = await loadHelpers();

  const localPath = '/Users/tester/Desktop/internal-test-photos/raw.jpg';
  const unsafe = `raw_path=${localPath} bbox_px={"x":1,"y":2,"w":3,"h":4}`;

  assert.throws(
    () => assertPrivacySafeText(unsafe, { extraPaths: [localPath] }),
    /privacy_violation/,
  );

  const safe = sanitizeForPrivacyText(unsafe, { extraPaths: [localPath] });
  assert.doesNotThrow(() => assertPrivacySafeText(safe, { extraPaths: [localPath] }));
});

