'use strict';

// The index feed's canonical PREFERENCE and its connection-layer derivation.
//
// Why the election preference exists, measured against prod 2026-07-27 over the
// 4,467 content_keys this lane would serve to the ACP feed:
//     4,266 have a content_canonical_election row
//        83 where this lane's rank-1 sig ≠ the elected canonical_sig_id
//       201 with no election row at all
// Those 83 would advertise a PDP whose own rel=canonical points elsewhere. A
// shopping ingester reads that as a canonical conflict and drops or merges the
// item — and the attribution goes with it.
//
// ── WHAT THESE TESTS DO NOT PROVE, STATED PLAINLY ────────────────────────────
// They assert the SQL's SHAPE against a stub `query`. This repo has no Postgres
// test harness, so nothing here proves Postgres will PREPARE the statement, and
// a shape assertion is exactly what let two un-preparable statements ship in
// pivota-backend last week. The statement WAS executed against real Postgres 15
// during development, both flag states, PREPARE + EXECUTE + a behavioural check
// that the representative row flips. That check is manual and NOT gated by CI —
// re-run it by hand when this SQL changes:
//
//   node -e "process.env.INDEX_FEED_ELECTED_CANONICAL='1';
//     require('./src/services/productEntityIndexFeed').getProductEntityIndexFeed(
//       {limit:3,market:'US'},
//       {query:async(s)=>{require('fs').writeFileSync('/tmp/feed.sql',s);return{rows:[]};}})"
//   createdb feedlane   # then create the 8 tables the statement reads
//   { printf 'PREPARE p (text,int) AS '; cat /tmp/feed.sql; printf ";\nEXECUTE p('US',4);\n"; } \
//     | psql -v ON_ERROR_STOP=1 feedlane
//
// Observed on that harness with two sigs under one content_key, where the
// election crowns the NEWER sig and the legacy tie-break (minted_at ASC) prefers
// the older one:  flag OFF -> sig_old,  flag ON -> sig_new.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getProductEntityIndexFeed,
  buildProductEntityIndexFeedItem,
  connectionLayerForTrack,
  isMissingContentCanonicalElectionError,
} = require('../src/services/productEntityIndexFeed');

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

const captureSql = () => {
  const seen = [];
  return {
    seen,
    query: async (sql) => {
      seen.push(sql);
      return { rows: [] };
    },
  };
};

// ---- the flag ---------------------------------------------------------------

test('election preference is OFF by default — the SQL carries no join', async () => {
  const cap = captureSql();
  await withEnv({ INDEX_FEED_ELECTED_CANONICAL: undefined }, () =>
    getProductEntityIndexFeed({ limit: 2 }, { query: cap.query }));
  assert.equal(cap.seen.length, 1);
  assert.ok(!cap.seen[0].includes('content_canonical_election'), 'no join when the flag is off');
  assert.ok(cap.seen[0].includes('NULL::text AS elected_canonical_sig_id'), 'column shape is stable either way');
});

test('election preference ON adds the join and a LEADING rank term', async () => {
  const cap = captureSql();
  await withEnv({ INDEX_FEED_ELECTED_CANONICAL: '1' }, () =>
    getProductEntityIndexFeed({ limit: 2 }, { query: cap.query }));
  const sql = cap.seen[0];
  assert.ok(sql.includes('LEFT JOIN content_canonical_election cce'), 'LEFT, never INNER — a keyless row must not vanish');
  assert.ok(sql.includes('cce.canonical_sig_id AS elected_canonical_sig_id'));

  // The election term must come BEFORE is_primary, or it cannot win.
  const orderBy = sql.slice(sql.indexOf('ROW_NUMBER() OVER'));
  const electionAt = orderBy.indexOf('elected_canonical_sig_id');
  const isPrimaryAt = orderBy.indexOf('cr.is_primary = true');
  assert.ok(electionAt > -1 && isPrimaryAt > -1);
  assert.ok(electionAt < isPrimaryAt, 'the elected sig must outrank every pre-existing tie-break');
});

test('keys with NO election keep their existing tie-break ordering', async () => {
  // The three-way CASE is what makes this true: no election sorts at 1, ahead of
  // a non-elected sibling at 2, so the untouched chain below decides.
  const cap = captureSql();
  await withEnv({ INDEX_FEED_ELECTED_CANONICAL: 'true' }, () =>
    getProductEntityIndexFeed({ limit: 2 }, { query: cap.query }));
  const sql = cap.seen[0];
  assert.ok(sql.includes('WHEN cr.elected_canonical_sig_id IS NULL THEN 1'));
  assert.ok(sql.includes('IS NOT DISTINCT FROM'), 'NULL-safe comparison, or a NULL CASE scatters the ordering');
});

// ---- the missing-table degrade ---------------------------------------------

test('a missing election table degrades the lane instead of 500ing it', async () => {
  const calls = [];
  let first = true;
  const query = async (sql) => {
    calls.push(sql);
    if (first) {
      first = false;
      const err = new Error('relation "content_canonical_election" does not exist');
      err.code = '42P01';
      throw err;
    }
    return { rows: [] };
  };
  const out = await withEnv({ INDEX_FEED_ELECTED_CANONICAL: '1' }, () =>
    getProductEntityIndexFeed({ limit: 2 }, { query }));
  assert.equal(calls.length, 2, 'retried');
  assert.ok(calls[0].includes('content_canonical_election'));
  assert.ok(!calls[1].includes('content_canonical_election'), 'the retry drops the join');
  assert.equal(out.status, 'success');
});

test('an unrelated missing relation is NOT swallowed as an election problem', async () => {
  // The sibling latch in src/server.js was demonstrated to misdiagnose this:
  // latching on a bare 42P01 disabled the feature permanently and blamed
  // migration 181 whenever any OTHER table went missing.
  const err = new Error('relation "index_pipeline_state" does not exist');
  err.code = '42P01';
  assert.equal(isMissingContentCanonicalElectionError(err), false);

  await assert.rejects(
    withEnv({ INDEX_FEED_ELECTED_CANONICAL: '1' }, () =>
      getProductEntityIndexFeed({ limit: 2 }, { query: async () => { throw err; } })),
    /index_pipeline_state/,
  );
});

test('the relation name is required; a bare SQLSTATE is not enough', () => {
  assert.equal(isMissingContentCanonicalElectionError({ code: '42P01', message: 'boom' }), false);
  assert.equal(
    isMissingContentCanonicalElectionError({ message: 'relation "content_canonical_election" does not exist' }),
    true,
    'a wrapping proxy may carry only the text',
  );
  assert.equal(isMissingContentCanonicalElectionError(null), false);
});

test('with the flag OFF there is no retry and no latch — asserted on CALL COUNT', async () => {
  // Asserting only that it rejects is a test that CANNOT FAIL: delete the
  // `!electedCanonicalEnabled ||` guard and the mutant still rejects — it just
  // burns a second doomed query and latches spuriously on the way. The call
  // count is the only thing that distinguishes them.
  const err = new Error('relation "content_canonical_election" does not exist');
  err.code = '42P01';
  let calls = 0;
  const query = async () => { calls += 1; throw err; };
  await assert.rejects(
    withEnv({ INDEX_FEED_ELECTED_CANONICAL: undefined }, () =>
      getProductEntityIndexFeed({ limit: 2 }, { query })),
    /content_canonical_election/,
  );
  assert.equal(calls, 1, 'flag off ⇒ exactly one query, no retry, no spurious latch');
});

// ---- connection layer -------------------------------------------------------

test('connection layer is derived from catalog_track, floor on anything else', () => {
  assert.equal(connectionLayerForTrack('external_referral'), 1);
  assert.equal(connectionLayerForTrack('internal_merchant'), 2);
  assert.equal(connectionLayerForTrack('  INTERNAL_MERCHANT  '), 2, 'matches the Python twin .strip().lower()');
  for (const bad of [null, undefined, '', '   ', 'referral', 'unknown']) {
    assert.equal(connectionLayerForTrack(bad), 1, String(bad));
  }
});

test('this lane never claims layer 3 — it cannot see a PSP fact', () => {
  // Understating costs an agent nothing (it acts on execution_path);
  // overstating would advertise a settlement rail that may not exist.
  const layers = new Set(
    ['external_referral', 'internal_merchant', 'anything'].map(connectionLayerForTrack),
  );
  assert.ok(!layers.has(3));
});

test('this lane emits NEITHER layer field — both together, or neither', () => {
  // ADR-018's rationale, as an executable rule. The lane can derive the layer
  // but CANNOT derive execution_path (that needs the warm-handoff brand
  // allowlist and the ACP door state, neither visible to this query). Emitting
  // `connection_layer: 1` beside `execution_path: undefined` ships the empty
  // half of the contract and reintroduces the very implication the two-field
  // design exists to prevent: that a layer number is an execution guarantee.
  const row = {
    product_entity_id: 'sig_q',
    source_product_id: 'ext_q',
    catalog_track: 'internal_merchant',
    seed_data: { title: 'Q' },
  };
  const before = process.env.CONNECTION_LAYER_FIELD_ENABLED;
  try {
    for (const flag of [undefined, '1']) {
      if (flag === undefined) delete process.env.CONNECTION_LAYER_FIELD_ENABLED;
      else process.env.CONNECTION_LAYER_FIELD_ENABLED = flag;
      const item = buildProductEntityIndexFeedItem(row);
      assert.equal('connection_layer' in item, false, `layer leaked with flag=${flag}`);
      assert.equal('execution_path' in item, false, `path leaked with flag=${flag}`);
    }
  } finally {
    if (before === undefined) delete process.env.CONNECTION_LAYER_FIELD_ENABLED;
    else process.env.CONNECTION_LAYER_FIELD_ENABLED = before;
  }
});

test('the derivation itself is kept — it is what a caller with an execution path uses', () => {
  assert.equal(connectionLayerForTrack('external_referral'), 1);
  assert.equal(connectionLayerForTrack('internal_merchant'), 2);
});

test('amount and currency still come from the SAME source — no cross-mixing', () => {
  // The INR-served-as-USD class. An offer row without a currency is not
  // price-quotable, and its amount must not borrow a currency from elsewhere.
  const item = buildProductEntityIndexFeedItem({
    product_entity_id: 'sig_b',
    source_product_id: 'ext_b',
    catalog_track: 'external_referral',
    price_amount: '25.00',
    price_currency: null,
    seed_data: { title: 'B' },
  });
  assert.equal(item.currency, null);
});

// ---- the latch is per PROCESS, and these tests share one ---------------------

test('the missing-table latch is sticky, so test ORDER in this file matters', async () => {
  // Made visible on purpose rather than left as a trap. The degrade test above
  // has already latched CONTENT_CANONICAL_ELECTION_TABLE_MISSING for this
  // process, so from here on the flag cannot re-enable the join no matter what
  // the env says.
  //
  // Be accurate about WHY that is acceptable: the table certainly CAN appear
  // mid-process — pivota-backend creates it at ITS boot (db/schema_guard.py),
  // a different process from this long-lived gateway. The latch is a deliberate
  // trade, not a claim about the world: re-probing would put a
  // guaranteed-failing query in front of every request, and the cost of being
  // wrong is only that a canonical PREFERENCE stays off until the next gateway
  // restart. It is NOT self-healing, and a deploy is what clears it.
  //
  // The consequence for this file is that any NEW test needing the join must
  // sit ABOVE the degrade test.
  const cap = captureSql();
  await withEnv({ INDEX_FEED_ELECTED_CANONICAL: '1' }, () =>
    getProductEntityIndexFeed({ limit: 2 }, { query: cap.query }));
  assert.ok(
    !cap.seen[0].includes('content_canonical_election'),
    'latched off — if this ever fails, the latch stopped being per-process',
  );
});

// ---- the SQL must CONTAIN the predicates, not merely be asked for them ------
//
// "A documented requirement is not a gate" — the phrase this PR coined, applied
// to itself. `acp_feed_source` asserts that `priced_only: true` is SENT; nothing
// asserted the SQL then carries the predicate, so deleting `pricedOnlyWhere`
// left every suite green. Same for the latch's anchored pattern.

test('priced_only puts the price predicate in the SQL, where LIMIT can see it', async () => {
  const on = captureSql();
  await withEnv({ INDEX_FEED_ELECTED_CANONICAL: undefined }, () =>
    getProductEntityIndexFeed({ limit: 2, priced_only: true }, { query: on.query }));
  assert.ok(
    on.seen[0].includes('best_offer.price_amount IS NOT NULL'),
    'without this predicate LIMIT counts rows that JS then drops — pages under-deliver ~24%',
  );
  assert.ok(on.seen[0].includes('best_offer.price_currency IS NOT NULL'));

  const off = captureSql();
  await withEnv({ INDEX_FEED_ELECTED_CANONICAL: undefined }, () =>
    getProductEntityIndexFeed({ limit: 2 }, { query: off.query }));
  assert.ok(
    !off.seen[0].includes('best_offer.price_amount IS NOT NULL'),
    'default OFF: the predicate must not appear unless asked for',
  );
});

test('the latch pattern is ANCHORED, so an embedded query string cannot trip it', () => {
  // The loose two-substring form latches when an unrelated 42P01's message
  // embeds the failing SQL (proxies/ORMs append `QUERY: ...`), and this
  // statement names the table.
  const embedded = {
    code: '42P01',
    message:
      'relation "index_pipeline_state" does not exist\n'
      + 'QUERY: SELECT ... LEFT JOIN content_canonical_election cce ON ...',
  };
  assert.equal(
    isMissingContentCanonicalElectionError(embedded),
    false,
    'an unrelated missing relation whose message merely MENTIONS the election table must not latch',
  );
  assert.equal(
    isMissingContentCanonicalElectionError({
      code: '42P01',
      message: 'relation "content_canonical_election" does not exist',
    }),
    true,
  );
});

test('#1852: a URL-poisoned title candidate is skipped so cp.title is reached', () => {
  // The chain is `firstUsableTitle(product.title, product.name, row.product_name, …)`.
  // `buildExternalSeedProduct` ends its own fallback with `|| canonicalUrl`, so
  // for a seed with no authored title `product.title` arrives ALREADY holding
  // the PDP URL — non-empty, so it won at position 1 and `row.product_name`
  // (cp.title) was never consulted. The data was there the whole time: 6 of 6
  // probed rows render a real name on their own PDP.
  //
  // Fixing the builder instead would NOT fix this — the chain would take
  // `externalProductId` next and still never reach cp.title.
  const { firstUsableTitle } = require('../src/services/productEntityIndexFeed');
  const URL = 'https://agent.pivota.cc/products/sig_2fb79a1a97d616e538602261cb62d00f';
  assert.equal(firstUsableTitle(URL, '', 'Complexion Essentials'), 'Complexion Essentials');
  assert.equal(firstUsableTitle('//agent.pivota.cc/p/1', 'Rice 72 Serum'), 'Rice 72 Serum');
  assert.equal(firstUsableTitle('Hyalu-Cica First Ampoule', URL), 'Hyalu-Cica First Ampoule');
  assert.equal(firstUsableTitle(URL), '', 'a URL alone yields no title, never the URL');
  assert.equal(firstUsableTitle('', null, undefined), '');
  // Anchored, not a substring match.
  assert.equal(firstUsableTitle('Serum (see https://x.com)'), 'Serum (see https://x.com)');
});

test('#1852 BEHAVIOURAL: the lane BUILDER reaches cp.title past a URL-poisoned candidate', () => {
  // The unit test above exercises `firstUsableTitle` in isolation, and a mutant
  // that reverts the CALL SITE back to `nonEmptyString` survived it — nothing
  // asserted the builder actually uses the new helper. Same shape as the #1848
  // call-site gap: a helper nothing calls is a success signal that means
  // nothing.
  //
  // So drive the real `buildProductEntityIndexFeedItem` with the exact shape
  // that produced the live defect: no authored title anywhere, a canonical_url
  // that `buildExternalSeedProduct` falls back to, and the real name sitting in
  // `product_name` (cp.title) further down the chain.
  const { buildProductEntityIndexFeedItem } = require('../src/services/productEntityIndexFeed');
  const item = buildProductEntityIndexFeedItem({
    product_entity_id: 'sig_abc123',
    source_product_id: 'ext_x1',
    canonical_url: 'https://agent.pivota.cc/products/sig_abc123',
    product_name: 'Complexion Essentials',
    price_amount: 118,
    price_currency: 'USD',
    merchant_id: 'external_seed',
  });
  assert.ok(item, 'the row must still build');
  assert.equal(item.title, 'Complexion Essentials',
    'the builder must skip the URL candidate and reach cp.title — this is the 90% defect');
  assert.notEqual(item.title, item.canonical_url);
  assert.ok(!String(item.title).startsWith('http'), 'no feed item may carry a URL as its name');
});
