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

test('the CALL SITE passes req.query THROUGH the allow-list', () => {
  // The three mutants this closes all left the previous suite 6/6 GREEN, because
  // it tested `pickAcpFeedPagination` in a vacuum and never asserted anyone
  // calls it:
  //   * delete the `query:` line entirely      -> PR is a total no-op, still 20
  //   * pickAcpFeedPagination(req.params)      -> always {} for /feed, no-op
  //   * `query: req.query`                     -> ALLOW-LIST BYPASSED, the exact
  //                                               hole this PR exists to prevent
  // A helper nothing calls is the purest form of a success signal that means
  // nothing, and the comment at the top of this file claimed to have avoided it.
  assert.match(
    serverSrc,
    /query: pickAcpFeedPagination\(req\.query\),/,
    'the adapter call must pass req.query THROUGH pickAcpFeedPagination — not raw, not req.params, not omitted',
  );
  // And raw forwarding must not appear anywhere in the adapter call object.
  const callSite = serverSrc.slice(serverSrc.indexOf('const out = await adapter[handlerName]({'), serverSrc.indexOf('for (const [k, v] of Object.entries(out.headers || {}))'));
  assert.ok(callSite.length > 0, 'could not locate the adapter call site');
  assert.ok(!/query: req\.query/.test(callSite), 'req.query must never be forwarded raw');
});

test('the adapter prefers a body query over the querystring, and never mixes them on the signed path', () => {
  const src = fs.readFileSync(require.resolve('../safety-kernel/src/protocol/acpRestAdapter'), 'utf8');
  assert.ok(
    /req\?\.body\?\.query \?\? req\?\.query \?\? req\?\.params \?\? \{\}/.test(src),
    'public feed must read body.query FIRST so existing GET-body callers are unaffected',
  );
  // The authenticated branch must stay signed-body only. If `req.query` ever
  // appears in it, an unsigned querystring contributes to a signed request.
  // GUARDED. Unguarded, a missing marker gives indexOf === -1, and
  // String.slice(-1, N) returns '' — so the !test('') below passes VACUOUSLY.
  // Demonstrated: renaming `nonEmpty` to `hasBody` while ALSO leaking
  // req?.query into the signed branch left this test green. The one invariant
  // it exists to protect, defeated by renaming an unrelated helper.
  const aStart = src.indexOf(': (nonEmpty(req?.rawBody)');
  const aEnd = src.indexOf('const products = await getProducts(query);');
  assert.ok(aStart >= 0 && aEnd > aStart, 'could not locate the authenticated branch — markers drifted');
  const authBranch = src.slice(aStart, aEnd);
  assert.ok(!/req\?\.query/.test(authBranch), 'the AUTHENTICATED branch must never read the unsigned querystring');
});

test('a malformed cursor degrades to absent, never a 500', () => {
  // Finding 3. Both shapes below reached Postgres and crashed it, confirmed live
  // and unauthenticated. Reachable today only via the obscure GET-JSON-body
  // path; forwarding the query string puts them one plain URL away on a public
  // crawler-facing feed.
  const { decodeCursor } = require('../src/services/productEntityIndexFeed');
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

  assert.equal(decodeCursor(enc({ sort_updated_at: 'not-a-date', product_entity_id: 'x', source_product_id: 'y' })), null);
  assert.equal(decodeCursor(enc({ offset: 1e21 })), null);
  // NOT rejected, and correctly so: JSON cannot carry Infinity, so
  // `JSON.stringify({offset: Infinity})` is literally `{"offset":null}`. The
  // guard skips a null offset, and downstream `Number(null)` is 0 -> page 1.
  // Asserting a rejection here would have been testing my expectation rather
  // than the hazard, and the hazard is the timestamptz cast and the overflow.
  assert.deepEqual(decodeCursor(enc({ offset: Infinity })), { offset: null });
  assert.equal(decodeCursor(enc({ offset: -5 })), null);
  assert.equal(decodeCursor(enc({ offset: 1.5 })), null);

  // Valid cursors must still work — a guard that rejects everything would cap
  // the feed at page 1 while looking like a fix.
  assert.deepEqual(decodeCursor(enc({ offset: 20 })), { offset: 20 });
  assert.deepEqual(
    decodeCursor(enc({ sort_updated_at: '2026-07-28T00:00:00Z', product_entity_id: 'sig_a', source_product_id: 'ext_b' })),
    { sort_updated_at: '2026-07-28T00:00:00Z', product_entity_id: 'sig_a', source_product_id: 'ext_b' },
  );
  // Shape-only: a well-formed cursor for a row that no longer exists is still a
  // valid cursor and must decode.
  assert.deepEqual(decodeCursor(enc({ source_listing_ref: "' OR 1=1--" })), { source_listing_ref: "' OR 1=1--" });
});

test('the connected fallback lane clamps limit before going upstream', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/server'), 'utf8');
  const i = src.indexOf('const upstreamQuery = { ...(query || {}) };');
  const j = src.indexOf("invokeCommerceKernelRawUpstream('find_products'");
  assert.ok(i >= 0 && j > i, 'the clamp must sit before the upstream call');
  assert.ok(!/find_products', query \|\| \{\}\)/.test(src), 'the raw query must not reach find_products unclamped');
});

test('a polluted Object.prototype cannot inject pagination', () => {
  // Finding 5. Without `Object.hasOwn`, `q[k]` reads inherited properties, so a
  // pollution primitive ANYWHERE else in the process would make every request
  // carry `limit` off the prototype. Mutation-checked: with the guard removed
  // this test is the only thing that goes red.
  //
  // The pollution is set and removed in a try/finally — leaking it would poison
  // every later test in the file, which is its own hazard.
  try {
    Object.prototype.limit = '9999';           // eslint-disable-line no-extend-native
    assert.equal(pick({}), undefined, 'an inherited limit must not be forwarded');
    assert.deepEqual(pick({ page: '2' }), { page: '2' }, 'and must not ride along with a real key');
  } finally {
    delete Object.prototype.limit;
  }
  assert.equal(Object.prototype.limit, undefined, 'pollution must not leak out of this test');
});
