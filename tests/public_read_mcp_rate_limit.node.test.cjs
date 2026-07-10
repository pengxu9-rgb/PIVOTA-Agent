'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTokenBucketLimiter } = require('../src/services/publicReadRateLimit');

test('allows a burst up to capacity, then blocks, then refills over time', () => {
  let t = 0;
  const limiter = createTokenBucketLimiter({ capacity: 3, refillPerSecond: 1, now: () => t });
  assert.ok(limiter.allow('a'));
  assert.ok(limiter.allow('a'));
  assert.ok(limiter.allow('a'));
  assert.equal(limiter.allow('a'), false);

  t += 1000; // one token refilled
  assert.ok(limiter.allow('a'));
  assert.equal(limiter.allow('a'), false);

  t += 60_000; // refill caps at capacity, never beyond
  assert.ok(limiter.allow('a'));
  assert.ok(limiter.allow('a'));
  assert.ok(limiter.allow('a'));
  assert.equal(limiter.allow('a'), false);
});

test('keys are limited independently; empty keys share one bounded bucket', () => {
  let t = 0;
  const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: () => t });
  assert.ok(limiter.allow('a'));
  assert.ok(limiter.allow('b'));
  assert.equal(limiter.allow('a'), false);
  assert.equal(limiter.allow('b'), false);

  assert.ok(limiter.allow(''));
  assert.equal(limiter.allow(undefined), false, 'empty/undefined keys share the "unknown" bucket');
});

test('bucket map stays bounded under a flood of distinct keys', () => {
  let t = 0;
  const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, maxKeys: 100, now: () => t });
  for (let i = 0; i < 100; i += 1) limiter.allow(`k${i}`);
  assert.equal(limiter.size(), 100);

  // All existing buckets idle past the prune window: the next new key prunes instead of growing.
  t += 10 * 60 * 1000;
  assert.ok(limiter.allow('fresh'));
  assert.equal(limiter.size(), 1);

  // Pathological same-instant flood: the map resets rather than exceeding maxKeys.
  for (let i = 0; i < 250; i += 1) limiter.allow(`flood${i}`);
  assert.ok(limiter.size() <= 100);
});
