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

test('the CALL SITE passes req.query THROUGH the allow-list — exactly once', () => {
  // Round 2 defeated the previous version of this test THREE ways, all of which
  // bypass the allow-list while keeping it green:
  //   Q1  add `query: req?.query,` AFTER the good line  -> last duplicate key
  //       wins, so raw req.query reaches the lane; the positive regex still
  //       matched and the negative one did not match `req?.query`.
  //   Q2  the same via `req['query']`.
  //   Q3  a spread: `...(cond ? { query: Object.assign({}, req.query) } : {})`.
  // And it was killed by two changes with ZERO behavioural effect (an extra
  // space, a reflow) — wrong in both directions, which is what a prettier run
  // or a lint autofix would have discovered the hard way.
  //
  // So: normalise whitespace (kills the formatting brittleness), then assert on
  // the COUNT of `query`-key assignments rather than the presence of one good
  // one (kills the duplicate-key and spread shapes).
  const start = serverSrc.indexOf('const out = await adapter[handlerName]({');
  const end = serverSrc.indexOf('for (const [k, v] of Object.entries(out.headers || {}))');
  assert.ok(start >= 0 && end > start, 'could not locate the adapter call site — markers drifted');
  const norm = serverSrc.slice(start, end).replace(/\s+/g, '');

  const assignments = norm.match(/query:/g) || [];
  assert.equal(
    assignments.length, 1,
    'exactly ONE query: key in the adapter call object — a second one silently wins and can be raw req.query',
  );
  assert.ok(
    norm.includes('query:pickAcpFeedPagination(req.query),'),
    'the single query: key must pass req.query THROUGH the allow-list',
  );
  assert.ok(
    !/\.\.\./.test(norm),
    'no spread in the call object — a spread can inject a query key the count above cannot attribute',
  );
});

test('the fallback lane query is built by VALUE, clamp wired in', () => {
  // Round 3: the previous version asserted on `clampLimit` (a pure, pre-existing
  // function the index lane already exercised) plus a source-text match. FOUR
  // wiring mutants survived — reverting the arg to `query ?? {}`, wrapping it in
  // parens, and two that ran the clamp then discarded it. The assertion died on
  // formatting and lived on semantics, backwards in both directions.
  //
  // `buildConnectedLaneQuery` is now the extracted seam, so these are value
  // assertions on the object that actually goes upstream.
  const { buildConnectedLaneQuery, clampLimit } = require('../src/services/acpFeedSource');

  assert.equal(buildConnectedLaneQuery({ limit: '999999999' }).limit, 100, 'clamps to the ceiling');
  assert.equal(buildConnectedLaneQuery({ limit: 1e21 }).limit, 100);
  assert.equal(buildConnectedLaneQuery({ limit: '0' }).limit, 1, 'floor is 1');
  assert.equal(buildConnectedLaneQuery({ limit: '-5' }).limit, 1);
  assert.equal(buildConnectedLaneQuery({ limit: 'abc' }).limit, 20, 'unparseable -> default, not a huge page');
  assert.equal(buildConnectedLaneQuery({ limit: '50' }).limit, 50);

  // A query with no limit must come back structurally unchanged — the clamp
  // must not invent one.
  assert.deepEqual(buildConnectedLaneQuery({}), {});
  assert.deepEqual(buildConnectedLaneQuery(undefined), {});
  assert.deepEqual(buildConnectedLaneQuery({ page: '3', cursor: 'c' }), { page: '3', cursor: 'c' });
  assert.ok(!('limit' in buildConnectedLaneQuery({ page: '3' })), 'no limit key may be added');

  // page/cursor pass through untranslated — this lane has no paging contract,
  // and pretending otherwise would silently re-serve page 1.
  const out = buildConnectedLaneQuery({ limit: '500', page: '2', cursor: 'abc', query: 'serum' });
  assert.deepEqual(out, { limit: 100, page: '2', cursor: 'abc', query: 'serum' });

  // It must be a COPY — mutating the caller's query object is its own bug.
  const src = { limit: '500' };
  assert.notEqual(buildConnectedLaneQuery(src), src);
  assert.equal(src.limit, '500', 'the input must not be mutated');

  // And it must use the same clamp as the index lane, not a private copy.
  assert.equal(buildConnectedLaneQuery({ limit: '777' }).limit, clampLimit('777'));

  // The call site must hand it the raw query — a source-text check, but now
  // only as a WIRING check on top of the value assertions above.
  const serverText = require('node:fs').readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(
    serverText.replace(/\s+/g, ''),
    /invokeCommerceKernelRawUpstream\('find_products',buildConnectedLaneQuery\(query\)\)/,
    'the upstream call must send the BUILT query',
  );
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
  const { decodeCursor } = require('../src/services/productEntityIndexFeed');
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const NUL = String.fromCharCode(0);
  const cur = (t) => decodeCursor(enc({ sort_updated_at: t, product_entity_id: 'sig_a', source_product_id: 'ext_b' }));

  // The two shapes that started this: both produced an unauthenticated 500.
  assert.equal(decodeCursor(enc({ sort_updated_at: 'not-a-date', product_entity_id: 'x', source_product_id: 'y' })), null);
  assert.equal(decodeCursor(enc({ offset: 1e21 })), null);
  assert.equal(decodeCursor(enc({ offset: -5 })), null);
  assert.equal(decodeCursor(enc({ offset: 1.5 })), null);

  // JSON cannot carry Infinity — it serialises to null, the guard skips a null
  // offset, and Number(null) is 0, i.e. page 1. Asserting a rejection here
  // would test my expectation rather than the hazard.
  assert.deepEqual(decodeCursor(enc({ offset: Infinity })), { offset: null });

  // (a) Date.parse is LOOSER than ::timestamptz. Every one of these was
  // ACCEPTED by the first version of the guard and every one throws in
  // Postgres (measured on a local PG 15 by review).
  const dateParseAcceptedButPgRejects = [
    '2026', '2026-07', 'Jan 2026', '2026 Jul', '0', '12', '5/5',
    '0000-01-01T00:00:00Z', '+275760-09-13T00:00:00.000Z', 'Jul 28 2026 GMT+9999',
  ];
  for (const t of dateParseAcceptedButPgRejects) {
    assert.equal(
      decodeCursor(enc({ sort_updated_at: t, product_entity_id: 'x', source_product_id: 'y' })),
      null,
      'Date.parse accepts ' + JSON.stringify(t) + ' but ::timestamptz rejects it',
    );
  }

  // (b) a NUL byte survives BOTH Date.parse and String.trim, and breaks the
  // connection-level UTF8 encode.
  assert.equal(decodeCursor(enc({ sort_updated_at: '2026-07-28T00:00:00Z' + NUL, product_entity_id: 'x', source_product_id: 'y' })), null);

  // (c) the three TEXT fields were validated by nothing. No cast can throw on a
  // text comparison — but 0x00 breaks the encode whatever the type, so "no
  // cast" was never "no hazard".
  for (const f of ['product_entity_id', 'source_product_id', 'source_listing_ref']) {
    assert.equal(decodeCursor(enc({ [f]: 'ok' + NUL + 'x' })), null, f + ' must reject a NUL byte');
  }

  // Non-scalars are refused outright — an object bound as a parameter is its
  // own class of upstream surprise.
  assert.equal(decodeCursor(enc({ offset: { a: 1 } })), null);
  assert.equal(decodeCursor(enc({ source_listing_ref: ['a'] })), null);

  // OVER-REJECTION MATTERS AS MUCH AS THE 500. A guard that refused legitimate
  // cursors would silently cap the feed at page 1 while looking like a fix.
  // This is the cursor the feed actually MINTS and it must survive untouched.
  const minted = { source_listing_ref: 'abc', market: 'US', tool: 'acp_public_feed', include_attached: true };
  assert.deepEqual(decodeCursor(enc(minted)), minted, 'the cursor this feed mints must decode');
  assert.deepEqual(decodeCursor(enc({ offset: 20 })), { offset: 20 });
  for (const t of ['2026-07-28T00:00:00Z', '2026-07-28T00:00:00.123456+09:00', '2026-07-28 00:00:00']) {
    const c = { sort_updated_at: t, product_entity_id: 'sig_a', source_product_id: 'ext_b' };
    assert.deepEqual(decodeCursor(enc(c)), c, 'a legitimate keyset timestamp must be accepted: ' + t);
  }
  // Shape-only: SQL-ish text is harmless (bound parameter) and must decode.
  const sqlish = { source_listing_ref: "' OR 1=1--" };
  assert.deepEqual(decodeCursor(enc(sqlish)), sqlish);

  // ---- round-3: CALENDAR-invalid dates, and three uncovered branches ----

  // Date.parse is NOT a calendar validator. V8 accepts day 01-31 for any month
  // and MakeDay ROLLS OVER (Feb 30 -> Mar 2), so it returns a number, the regex
  // passes `\d{2}`, and `$N::timestamptz` throws "date/time field value out of
  // range". All six of these were live 500s after the previous fix.
  for (const t of ['2026-02-30T00:00:00Z', '2026-04-31T00:00:00Z', '2026-06-31T00:00:00Z',
                   '2026-09-31T00:00:00Z', '2026-11-31T00:00:00Z', '2025-02-29T00:00:00Z']) {
    assert.equal(cur(t), null, 'calendar-invalid date must be rejected: ' + t);
  }
  for (const t of ['2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z',
                   '2026-07-00T00:00:00Z', '2026-07-32T00:00:00Z']) {
    assert.equal(cur(t), null, 'out-of-range field must be rejected: ' + t);
  }

  // The leap-year rule is NOT written in the guard — the round-trip gets it from
  // the platform. Both directions pinned so a hand-rolled rule cannot creep in.
  assert.notEqual(cur('2024-02-29T00:00:00Z'), null, 'a real leap day must be accepted');
  assert.equal(cur('2025-02-29T00:00:00Z'), null, 'a non-leap Feb 29 must be rejected');

  // KEEPS `Date.parse` LOAD-BEARING. Review found that deleting that line left
  // the suite green: every string it was credited with catching was already
  // killed by the regex or the year check. These are TIME-field violations —
  // the calendar round-trip only inspects Y/M/D, so Date.parse is the only
  // thing that sees them, and the regex's `\d{2}` admits both.
  assert.equal(cur('2026-07-28T25:00:00Z'), null, 'hour 25 — only Date.parse catches this');
  assert.equal(cur('2026-07-28T00:60:00Z'), null, 'minute 60 — only Date.parse catches this');

  // KEEPS THE NON-NUL HALF OF hasControlChars LOAD-BEARING. Narrowing it to
  // /[\u0000]/ previously survived: nothing exercised \u0001-\u001f or \u007f.
  for (const ch of ['\u0001', '\u001f', '\u007f']) {
    assert.equal(decodeCursor(enc({ source_listing_ref: 'a' + ch + 'b' })), null,
      'control character U+' + ch.charCodeAt(0).toString(16).padStart(4, '0') + ' must be rejected');
  }
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
