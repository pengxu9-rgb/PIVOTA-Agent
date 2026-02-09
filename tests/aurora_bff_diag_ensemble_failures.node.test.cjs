const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyProviderFailureMeta,
  extractProviderStatusCode,
} = require('../src/auroraBff/diagEnsemble');

test('diag ensemble: extracts provider status from nested error fields', () => {
  const status = extractProviderStatusCode({
    error: { code: 403, status: 'PERMISSION_DENIED' },
  });
  assert.equal(status, 403);
});

test('diag ensemble: maps permission denied without numeric status to missing key', () => {
  const meta = classifyProviderFailureMeta({
    message: 'request blocked by policy',
    error: { status: 'PERMISSION_DENIED' },
  });
  assert.equal(meta.reason, 'VISION_MISSING_KEY');
});

test('diag ensemble: maps resource exhausted to quota/rate classes', () => {
  const meta = classifyProviderFailureMeta({
    message: 'resource exhausted: quota exceeded for current project',
    error: { status: 'RESOURCE_EXHAUSTED' },
  });
  assert.equal(meta.reason, 'VISION_QUOTA_EXCEEDED');
});

test('diag ensemble: maps deadline exceeded to timeout', () => {
  const meta = classifyProviderFailureMeta({
    message: 'deadline exceeded while waiting for provider',
    error: { status: 'DEADLINE_EXCEEDED' },
  });
  assert.equal(meta.reason, 'VISION_TIMEOUT');
  assert.equal(meta.statusClass, 'timeout');
});

test('diag ensemble: maps fetch failed to network error', () => {
  const meta = classifyProviderFailureMeta({
    name: 'TypeError',
    message: 'fetch failed',
  });
  assert.equal(meta.reason, 'VISION_NETWORK_ERROR');
});

test('diag ensemble: maps unavailable to upstream 5xx', () => {
  const meta = classifyProviderFailureMeta({
    message: 'upstream unavailable',
    error: { status: 'UNAVAILABLE' },
  });
  assert.equal(meta.reason, 'VISION_UPSTREAM_5XX');
});

test('diag ensemble: maps invalid argument image problems to image invalid', () => {
  const meta = classifyProviderFailureMeta({
    message: 'invalid argument: unsupported mime image/png',
    error: { status: 'INVALID_ARGUMENT' },
  });
  assert.equal(meta.reason, 'VISION_IMAGE_INVALID');
});
