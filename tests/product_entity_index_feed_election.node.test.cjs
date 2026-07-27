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

test('with the flag OFF, an election error is not caught — nothing to degrade to', async () => {
  const err = new Error('relation "content_canonical_election" does not exist');
  err.code = '42P01';
  await assert.rejects(
    withEnv({ INDEX_FEED_ELECTED_CANONICAL: undefined }, () =>
      getProductEntityIndexFeed({ limit: 2 }, { query: async () => { throw err; } })),
    /content_canonical_election/,
  );
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

test('the feed item carries the derived layer', () => {
  const item = buildProductEntityIndexFeedItem({
    product_entity_id: 'sig_alpha',
    source_product_id: 'ext_alpha',
    content_key: 'ck_alpha',
    catalog_track: 'external_referral',
    price_amount: '18.50',
    price_currency: 'USD',
    seed_data: { title: 'Alpha' },
  });
  assert.equal(item.connection_layer, 1);
  assert.equal(item.price, 18.5);
  assert.equal(item.currency, 'USD');
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
  // the env says. That is the intended production behaviour — a missing table
  // does not reappear mid-process — but it means any NEW test that needs the
  // join must be placed ABOVE the degrade test.
  const cap = captureSql();
  await withEnv({ INDEX_FEED_ELECTED_CANONICAL: '1' }, () =>
    getProductEntityIndexFeed({ limit: 2 }, { query: cap.query }));
  assert.ok(
    !cap.seen[0].includes('content_canonical_election'),
    'latched off — if this ever fails, the latch stopped being per-process',
  );
});
