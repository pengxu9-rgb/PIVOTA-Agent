'use strict';

// search_catalog hands every row back with its Pivota signature as the top-level `product_id`, and
// get_product's schema REQUIRES a merchant_id. So the argument pair an agent forms straight from a
// search result is (merchant_id, sig_...) — and until this fix that pair could not be served for a
// REAL, connected merchant. Merchant-scoped detail goes to the Python per-merchant catalog, which is
// keyed by the PLATFORM product id; it misses, then hands the sig to Shopify Admin as a numeric
// product id, gets a non-404 back, and raises 502 SHOPIFY_PRODUCT_FETCH_FAILED. The gateway's error
// mapping has no arm for that code, so the agent is told
// "MERCHANT_UNAVAILABLE / The merchant is temporarily unreachable / retriable:true" — about a healthy
// merchant, for an id that would never resolve.
//
// Live repro 2026-08-31 on prod (gateway-00081-lay): get_product(merch_c5e24a8d3738d73b,
// sig_9e3039e79deaf1860585156c7fd1d3c1) -> MERCHANT_UNAVAILABLE three times running, and once more on
// a second product of the same merchant; get_product(merch_c5e24a8d3738d73b, 9854988910809) -> the
// full record with all three variants. That is the same defect
// services/commerceKernelErrorMapping.js was extracted for (#1829: "22% of public search results led
// to get_product returning 'the merchant is temporarily unreachable' for ids that would never
// resolve"), still live on the one lane that fix did not cover — the sibling carve-out in
// tests/sourcing_sentinel_merchant_scope.node.test.cjs even pins
// `reroutes('merch_abc123', 'sig_whatever') === false`, which is exactly this hole.
//
// The fix translates the id rather than teaching the Python catalog and Shopify about signatures.

const test = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
process.env.DATABASE_URL = ORIGINAL_DATABASE_URL || 'postgres://test/test';

const {
  resolveMerchantScopedSourceProductId,
} = require('../src/services/catalogEntityResolution');

const SIG = 'sig_9e3039e79deaf1860585156c7fd1d3c1';
const MERCHANT = 'merch_c5e24a8d3738d73b';
const PLATFORM_ID = '9854988910809';

function recordingQuery(rows) {
  const calls = [];
  const fn = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: Array.isArray(rows) ? rows : [] };
  };
  fn.calls = calls;
  return fn;
}

test('the live repro: a merchant-scoped signature resolves to that merchant OWN platform id', async () => {
  const queryFn = recordingQuery([{ source_product_id: PLATFORM_ID }]);
  const resolved = await resolveMerchantScopedSourceProductId({
    productId: SIG,
    merchantId: MERCHANT,
    queryFn,
  });
  assert.equal(resolved, PLATFORM_ID);
  assert.equal(queryFn.calls.length, 1);
  // BOTH halves of the identity must be BOUND PARAMETERS of the query, not a post-filter in JS: a
  // merchant-scoped answer is only correct if the database was asked a merchant-scoped question.
  const { sql, params } = queryFn.calls[0];
  assert.deepEqual(params, [SIG, MERCHANT]);
  // ...and both must actually CONSTRAIN the row set. Binding a parameter the WHERE clause does not
  // restrict on leaves the params assertion above green while the query answers for every merchant —
  // a surviving mutant until this pair was added.
  assert.match(sql, /cp\.pivota_signature_id = \$1/, 'the signature must constrain the row set');
  assert.match(sql, /AND cp\.merchant_id = \$2/, 'the merchant must constrain the row set, as an AND');
  assert.doesNotMatch(sql, /\bOR\s+cp\.merchant_id/, 'the merchant scope must never be an alternative');
});

test('merchant-exact: a sibling merchant listing of the same signature never answers', async () => {
  // The query is merchant-bound, so a sibling merchant's row simply is not in the result set. Pin the
  // consequence: an empty set is a REFUSAL, never a fallback to "some listing of this signature".
  const queryFn = recordingQuery([]);
  assert.equal(
    await resolveMerchantScopedSourceProductId({ productId: SIG, merchantId: MERCHANT, queryFn }),
    null,
  );
});

test('exactly one, or refuse: two distinct source ids under one merchant is a tie we cannot break', async () => {
  const queryFn = recordingQuery([
    { source_product_id: PLATFORM_ID },
    { source_product_id: '9854987501785' },
  ]);
  assert.equal(
    await resolveMerchantScopedSourceProductId({ productId: SIG, merchantId: MERCHANT, queryFn }),
    null,
    'guessing between two listings could open the wrong product under a checkout-capable id',
  );
});

test('duplicate rows carrying the SAME id are not an ambiguity', async () => {
  const queryFn = recordingQuery([
    { source_product_id: PLATFORM_ID },
    { source_product_id: PLATFORM_ID },
  ]);
  assert.equal(
    await resolveMerchantScopedSourceProductId({ productId: SIG, merchantId: MERCHANT, queryFn }),
    PLATFORM_ID,
  );
});

test('an id that is not a signature costs ZERO database work', async () => {
  // The translation exists only for the shape upstream cannot serve. Every other detail lookup — the
  // overwhelmingly common one — must not pay a query for it.
  for (const pid of [PLATFORM_ID, 'ext_abc123', 'prod_1', 'sig_', 'sig_with_punct!', '', null]) {
    const queryFn = recordingQuery([{ source_product_id: PLATFORM_ID }]);
    assert.equal(
      await resolveMerchantScopedSourceProductId({ productId: pid, merchantId: MERCHANT, queryFn }),
      null,
      `${JSON.stringify(pid)} must not translate`,
    );
    assert.equal(queryFn.calls.length, 0, `${JSON.stringify(pid)} must not reach the database`);
  }
});

test('a missing merchant scope costs ZERO database work and never translates', async () => {
  for (const merchantId of ['', '   ', null, undefined]) {
    const queryFn = recordingQuery([{ source_product_id: PLATFORM_ID }]);
    assert.equal(
      await resolveMerchantScopedSourceProductId({ productId: SIG, merchantId, queryFn }),
      null,
    );
    assert.equal(queryFn.calls.length, 0);
  }
});

test('a row that carries another SIGNATURE or a product_key is not a platform id', async () => {
  // buildCatalogGroupMember-shaped data falls back to product_key, and a mis-backfilled row can carry
  // the signature itself. Sending either upstream reproduces the exact bug this fix removes.
  for (const bad of [SIG, 'sig_deadbeef', `prod::${MERCHANT}::shopify::${PLATFORM_ID}`]) {
    const queryFn = recordingQuery([{ source_product_id: bad }]);
    assert.equal(
      await resolveMerchantScopedSourceProductId({ productId: SIG, merchantId: MERCHANT, queryFn }),
      null,
      `${bad} must not be handed upstream as a platform id`,
    );
  }
});

test('fail-open on a database error — and the untranslated call is then the HONEST answer', async () => {
  // Falling through leaves MERCHANT_UNAVAILABLE / retriable:true, which is TRUE when the database this
  // gateway needs is the thing that is down. Throwing would turn a detail read into a 500.
  const queryFn = async () => {
    throw new Error('connection terminated unexpectedly');
  };
  assert.equal(
    await resolveMerchantScopedSourceProductId({ productId: SIG, merchantId: MERCHANT, queryFn }),
    null,
  );
});

test('the shared active-source gate is IN the query — a rig signature must not translate', async () => {
  // Every other catalog read in this module carries activeCatalogProductSourceWhere. A translation that
  // skipped it would be the one path by which a test/demo rig reaches a per-merchant detail read; see
  // the header of services/testMerchantPolicy.js for what that cost the public ACP feed on 2026-07-23.
  const queryFn = recordingQuery([{ source_product_id: PLATFORM_ID }]);
  await resolveMerchantScopedSourceProductId({ productId: SIG, merchantId: MERCHANT, queryFn });
  const { sql } = queryFn.calls[0];
  const {
    activeCatalogProductSourceWhere,
  } = require('../src/services/activeCatalogSourceSql');
  assert.ok(
    sql.includes(activeCatalogProductSourceWhere('cp', 'cm').trim()),
    'the query must embed the shared active-source gate verbatim, not a local twin of it',
  );
});

test('server.js CONSUMES the translation — the delivery line is pinned', () => {
  // The #1898 pattern the sibling suite names: the fix is only real on the line that builds the
  // outbound request. Every assertion above would stay green if the arm were deleted from server.js,
  // so pin the arm itself. invokeCommerceKernelRawUpstream is not exported, which is why this is a
  // source pin rather than a call.
  const fs = require('node:fs');
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(
    server,
    /resolveMerchantScopedSourceProductId,/,
    'server.js must import the canonical resolver — a local twin is how this class regressed before',
  );
  assert.match(
    server,
    /\} else if \(merchantScoped && pid\.startsWith\('sig_'\)\) \{/,
    'the arm must sit on the merchant-SCOPED branch: the unscoped branch already reroutes to get_pdp_v2',
  );
  assert.match(
    server,
    /const sourceProductId = await resolveMerchantScopedSourceProductId\(\{\s*\n\s*productId: pid,\s*\n\s*merchantId: rawDetailMerchant,\s*\n\s*\}\);/,
    'the resolver must be asked with the REQUESTED merchant, not a derived or defaulted one',
  );
  assert.match(
    server,
    /if \(sourceProductId\) \{\s*\n\s*requestBody = \{\s*\n\s*operation: op,\s*\n\s*payload: \{ \.\.\.payload, product: \{ \.\.\.prod, product_id: sourceProductId \} \},/,
    'the resolved id must be written into the OUTBOUND body — resolving it and not sending it is the no-op mutant',
  );
});

test.after(() => {
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});
