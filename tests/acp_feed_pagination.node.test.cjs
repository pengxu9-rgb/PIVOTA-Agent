'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// The allow-list lives inside getCommerceAcpRestAdapter()'s scope in server.js
// and cannot be imported, so it is extracted and executed — the same technique
// the priced-lane catch test uses, and for the same reason: a source-text match
// cannot tell a reachable allow-list from an unreachable one.
const serverSrc = fs.readFileSync(require.resolve('../src/server'), 'utf8');
const start = serverSrc.indexOf('  const pickAcpFeedPagination = (q) => {');
const end = serverSrc.indexOf('  for (const [method, subPath, handlerName, isCharge] of routes) {');
assert.ok(start >= 0 && end > start, 'could not locate pickAcpFeedPagination');
const pick = new Function(`${serverSrc.slice(start, end)}; return pickAcpFeedPagination;`)();

test('forwards exactly limit / cursor / page', () => {
  assert.deepEqual(pick({ limit: '100' }), { limit: '100' });
  assert.deepEqual(pick({ page: '3' }), { page: '3' });
  assert.deepEqual(pick({ cursor: 'eyJvZmZzZXQiOjIwfQ==' }), { cursor: 'eyJvZmZzZXQiOjIwfQ==' });
  assert.deepEqual(pick({ limit: '50', page: '2', cursor: 'c' }), { limit: '50', page: '2', cursor: 'c' });
});

test('a free-text `query` key CANNOT reach a lane', () => {
  // The whole reason this was deferred: an unsigned public querystring reaching
  // `find_products` free-text search on the connected fallback lane. The
  // allow-list is what answers that, so if this ever passes `query` through,
  // the deferral rationale becomes true again and the feature must come out.
  assert.equal(pick({ query: 'serum' }), undefined);
  assert.deepEqual(pick({ limit: '100', query: 'serum', merchant_id: 'x', market: 'IN' }), { limit: '100' });
});

test('returns undefined when nothing is supplied, so the ?? chain is unchanged', () => {
  // Must be undefined, NOT {} — `{}` is a valid left-hand value for `??` and
  // would shadow `req.params`, silently changing the no-querystring request.
  assert.equal(pick({}), undefined);
  assert.equal(pick(undefined), undefined);
  assert.equal(pick(null), undefined);
  assert.equal(pick('?limit=100'), undefined);
});

test('array-valued params are DROPPED, not coerced into a silent default', () => {
  // `?limit=1&limit=2` parses to ['1','2']; Number(['1','2']) is NaN, which
  // clampLimit swallows into its 20 default — a caller asking for 100 and
  // getting 20 with no error. Dropping it at least behaves predictably.
  assert.equal(pick({ limit: ['1', '2'] }), undefined);
  assert.deepEqual(pick({ limit: ['1', '2'], page: '4' }), { page: '4' });
});

test('empty and whitespace-only values are dropped', () => {
  assert.equal(pick({ limit: '' }), undefined);
  assert.equal(pick({ limit: '   ' }), undefined);
  assert.deepEqual(pick({ limit: ' 100 ' }), { limit: '100' });
});

test('the adapter prefers a body query over the querystring, and never mixes them on the signed path', () => {
  const src = fs.readFileSync(require.resolve('../safety-kernel/src/protocol/acpRestAdapter'), 'utf8');
  assert.ok(
    /req\?\.body\?\.query \?\? req\?\.query \?\? req\?\.params \?\? \{\}/.test(src),
    'public feed must read body.query FIRST so existing GET-body callers are unaffected',
  );
  // The authenticated branch must stay signed-body only. If `req.query` ever
  // appears in it, an unsigned querystring contributes to a signed request.
  const authBranch = src.slice(src.indexOf(': (nonEmpty(req?.rawBody)'), src.indexOf('const products = await getProducts(query);'));
  assert.ok(!/req\?\.query/.test(authBranch), 'the AUTHENTICATED branch must never read the unsigned querystring');
});
