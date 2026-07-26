'use strict';

// ONE canonical URL per content_key — the gateway half.
//
// 474 content_keys in prod serve identical content (same title, same Product
// JSON-LD) under 2 to 7 sitemap-eligible sigs; the cohort grew when P3 (#1828)
// made Path-C minted canonicals renderable alongside the external_seed mirror
// row they were minted from. Every one of those pages emits a SELF-referential
// <link rel="canonical">, so two URLs each declare themselves canonical for the
// same content and Google may index the one the sitemap omits.
//
// pivota-agent-ui#280 fixed the sitemap (one URL per content_key, sticky on
// incumbency). It could not fix the pages: a PDP has no way to know which
// sibling the sitemap picked. pivota-backend migration 181 elects a winner and
// stores it; this resolver READS it and get_pdp_v2 hands it to the PDP as
// `canonical.data.content_canonical_route_id`.
//
// THE INVARIANT, and the reason every assertion below is about READING rather
// than computing:
//
//   the sig the sitemap advertises == the sig every sibling PDP canonicalises at
//
// If this module ever derived the winner instead of reading it, the two could
// disagree — and a sitemap that submits URL A while A's own page points at B is
// strictly worse than the duplicate, because it tells the crawler to drop the
// URL we just submitted.

const ORIGINAL_ENV = process.env;

const SIG_ADVERTISED = 'sig_c1ae6bae3c95e29035cf91b46a81b224';
const SIG_SIBLING = 'sig_2f057569e49bcc11a33e54dcac6d9dca';
const CONTENT_KEY = 'ck_7f02a883e39e2529c8299393cf8e9669';

// Shape of the one row resolveCatalogProductRefFromPivotaSignature's exact
// query returns. Only the fields this test reasons about are populated.
function signatureRow(overrides = {}) {
  return {
    merchant_id: 'merch_obs_acme',
    platform: 'external_seed',
    source_product_id: 'ext_acme_1',
    product_key: 'prod::merch_obs_acme::external_seed::ext_acme_1',
    source_system: 'external_product_seeds_mirror_v1',
    pivota_signature_id: SIG_SIBLING,
    content_key: CONTENT_KEY,
    catalog_title: 'Acme Glow Serum',
    ...overrides,
  };
}

function loadServerWithRows(rows, envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
    RESOLVE_CATALOG_SIGNATURE_BUDGET_MS: '2000',
    ...envOverrides,
  };
  const seenSql = [];
  const query = jest.fn(async (sql) => {
    seenSql.push(String(sql));
    // Only the FIRST query (the exact signature lookup) returns the row; the
    // identity-listing and group-member follow-ups return nothing, which keeps
    // the resolver on its single-row path.
    return { rows: seenSql.length === 1 ? rows : [] };
  });
  jest.doMock('../src/db', () => ({
    query,
    queryWithStatementTimeout: query,
    withClient: jest.fn(),
    getPool: jest.fn(() => ({})),
    closePool: jest.fn(),
  }));
  return { app: require('../src/server'), seenSql, query };
}

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('content_canonical_election is READ by the signature resolver', () => {
  test('reads the election on content_key and selects the validated winner', async () => {
    const { app, seenSql } = loadServerWithRows([signatureRow()]);

    await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG_SIBLING, {
      hydrateIdentityListing: false,
      hydrateIdentityGroupMembers: false,
    });

    const sql = seenSql[0];
    expect(sql).toContain('FROM content_canonical_election cce');
    expect(sql).toContain('cce.content_key = cp.content_key');
    expect(sql).toContain('cce_valid.canonical_sig_id AS content_canonical_sig_id');
  });

  test('THE STALE-ELECTION GUARD: the elected sig must still be advertisable', async () => {
    // An election is a durable fact; electability is a live one. When the
    // elected sig stops rendering, the SITEMAP is structurally safe — its
    // renderable filter runs before the dedup, so the dead sig is not a
    // candidate and the live sibling gets advertised. This side has no such
    // structure: reading the election unvalidated would hand the sibling's PDP
    // the dead sig, so we would submit URL B while B's own page canonicalised
    // at a URL that 500s. That content_key then loses ALL index presence —
    // worse than the duplicate, and worse than a moved URL.
    //
    // P3 moved 2,051 rows on `renderable` in a single day; nothing prevents the
    // reverse direction, and (until scheduled) the sweep that would re-elect
    // runs by hand.
    const { app, seenSql } = loadServerWithRows([signatureRow()]);

    await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG_SIBLING, {
      hydrateIdentityListing: false,
      hydrateIdentityGroupMembers: false,
    });

    const sql = seenSql[0];
    // Re-asks the serving question of the ELECTED row, on its own alias...
    expect(sql).toContain('cp_elected.pivota_signature_id = cce.canonical_sig_id');
    expect(sql).toContain('cp_elected.suppressed_at IS NULL');
    expect(sql).toContain('ips_elected.serving_eligible IS TRUE');
    expect(sql).toContain("cm_elected.status IN ('active', 'observed')");
    // ...including BOTH halves of renderability: the lane dispatch and the
    // seed route. The seed route alone would pass a merchant-synced row whose
    // source_product_id collided with a seed id.
    expect(sql).toContain("cp_elected.merchant_id = 'external_seed'");
    expect(sql).toContain('_seed_route.external_product_id = cp_elected.source_product_id');
    // And it skips the whole probe when the election names THIS row.
    expect(sql).toContain('cce.canonical_sig_id IS DISTINCT FROM cp.pivota_signature_id');
  });

  test('the election read is a LEFT LATERAL, so an unelected content_key still resolves', async () => {
    // The whole safety story: freshly-minted content_keys, every row while the
    // sweep has not run, and every row whose election failed validation must
    // keep resolving. An inner join would 404 them — turning a missing
    // canonical TAG into a missing PAGE.
    const { app, seenSql } = loadServerWithRows([signatureRow()]);

    await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG_SIBLING, {
      hydrateIdentityListing: false,
      hydrateIdentityGroupMembers: false,
    });

    expect(seenSql[0]).toContain(') cce_valid ON true');
    expect(seenSql[0]).not.toMatch(/\bINNER JOIN content_canonical_election\b/);
    expect(seenSql[0]).not.toMatch(/\n\s*JOIN content_canonical_election\b/);
  });

  test('the seed-routed lane SQL uses left(), not a LIKE whose _ is a wildcard', async () => {
    // `LIKE 'ext_%'` matches `extX…` because `_` is a single-character wildcard
    // in SQL — strictly WIDER than the `slice(0, 4)` it mirrors, and wider is
    // the over-advertise direction for a canonical tag.
    const { seedRoutedLaneSql } = require('../src/services/pdpRenderability');
    const sql = seedRoutedLaneSql('cp_elected');
    expect(sql).toContain("left(lower(trim(coalesce(cp_elected.source_product_id, ''))), 4)");
    expect(sql).not.toContain("LIKE 'ext_");
  });

  test('surfaces the elected sig on the ref when the content_key has a winner', async () => {
    const { app } = loadServerWithRows([
      signatureRow({ content_canonical_sig_id: SIG_ADVERTISED }),
    ]);

    const ref = await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG_SIBLING, {
      hydrateIdentityListing: false,
      hydrateIdentityGroupMembers: false,
    });

    // The requested sig is NOT the elected one — this is precisely the case
    // that needs a cross-referential canonical tag.
    expect(ref.pivota_signature_id || ref.requested_pivota_signature_id).toBe(SIG_SIBLING);
    expect(ref.content_canonical_sig_id).toBe(SIG_ADVERTISED);
  });

  test('null when the content_key has not been elected', async () => {
    const { app } = loadServerWithRows([signatureRow({ content_canonical_sig_id: null })]);

    const ref = await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG_SIBLING, {
      hydrateIdentityListing: false,
      hydrateIdentityGroupMembers: false,
    });

    // Null, never the row's own sig. A self-referential value here would be
    // indistinguishable from a real election and would stop the consumer from
    // falling back — this field means "somebody elected a winner", not
    // "here is a URL".
    expect(ref.content_canonical_sig_id).toBeNull();
  });

  test('THE BLAST RADIUS: a missing table degrades the tag, it does not break the PDP', async () => {
    // pivota-backend migration 181 and this repo deploy independently, so the
    // gateway can be live against a database without the table — a merge-order
    // mistake, or just the gap between two deploys. The election is joined in
    // the PRIMARY signature query, so an unhandled undefined_table takes down
    // EVERY /products/{sig} PDP, not only the 474 duplicate groups. A canonical
    // tag is not worth that, so the query retries without the join.
    let sawElectionJoin = 0;
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
      RESOLVE_CATALOG_SIGNATURE_BUDGET_MS: '2000',
    };
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (text.includes('content_canonical_election')) {
        sawElectionJoin += 1;
        const err = new Error(
          'relation "content_canonical_election" does not exist',
        );
        err.code = '42P01';
        throw err;
      }
      return { rows: text.includes('FROM catalog_products') ? [signatureRow()] : [] };
    });
    jest.doMock('../src/db', () => ({
      query,
      queryWithStatementTimeout: query,
      withClient: jest.fn(),
      getPool: jest.fn(() => ({})),
      closePool: jest.fn(),
    }));
    const app = require('../src/server');

    const opts = { hydrateIdentityListing: false, hydrateIdentityGroupMembers: false };
    const ref = await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG_SIBLING, opts);

    // The PDP still resolves — just without an election.
    expect(ref).toBeTruthy();
    expect(ref.content_key).toBe(CONTENT_KEY);
    expect(ref.content_canonical_sig_id).toBeNull();

    // LATCHED: the second request must not re-run the failing join. Re-probing
    // would put a guaranteed-failing query in front of every PDP for as long as
    // the table is absent.
    await app._debug.resolveCatalogProductRefFromPivotaSignature(
      'sig_0000000000000000000000000000abcd',
      { ...opts, bypassCache: true },
    );
    expect(sawElectionJoin).toBe(1);
  });

  test('the latch does NOT fire on an unrelated missing relation', async () => {
    // The query also touches catalog_products, catalog_merchants,
    // index_pipeline_state and external_product_seeds. Latching on a bare
    // `code === '42P01'` disabled the election permanently whenever ANY of them
    // went missing — silently, for the whole process lifetime, with a warn line
    // blaming migration 181. Postgres always names the relation, so requiring
    // the name costs nothing.
    let electionSqlSeen = 0;
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
      RESOLVE_CATALOG_SIGNATURE_BUDGET_MS: '2000',
    };
    let failNext = true;
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (text.includes('content_canonical_election')) electionSqlSeen += 1;
      if (failNext) {
        failNext = false;
        const err = new Error('relation "index_pipeline_state" does not exist');
        err.code = '42P01';
        throw err;
      }
      return { rows: text.includes('FROM catalog_products') ? [signatureRow()] : [] };
    });
    jest.doMock('../src/db', () => ({
      query,
      queryWithStatementTimeout: query,
      withClient: jest.fn(),
      getPool: jest.fn(() => ({})),
      closePool: jest.fn(),
    }));
    const app = require('../src/server');
    const opts = { hydrateIdentityListing: false, hydrateIdentityGroupMembers: false };

    // The unrelated failure must propagate, not be swallowed into a latch.
    await expect(
      app._debug.resolveCatalogProductRefFromPivotaSignature(SIG_SIBLING, opts),
    ).resolves.toBeNull();

    const before = electionSqlSeen;
    await app._debug.resolveCatalogProductRefFromPivotaSignature(
      'sig_0000000000000000000000000000beef',
      { ...opts, bypassCache: true },
    );
    // THE REGRESSION: the next request still asks for the election.
    expect(electionSqlSeen).toBeGreaterThan(before);
  });

  test('survives buildCatalogIdentityFromSignatureProductRef', async () => {
    // get_pdp_v2 reads the election off catalogIdentity, which is a NEW object
    // built field-by-field from the resolver's ref — not a spread. A field that
    // is not explicitly named there is dropped, and a dropped election is
    // indistinguishable downstream from "nothing was elected": the duplicate
    // PDP quietly goes back to declaring itself canonical, the sitemap keeps
    // advertising the winner, and nothing anywhere errors. That silence is why
    // this has its own test.
    const { app } = loadServerWithRows([
      signatureRow({ content_canonical_sig_id: SIG_ADVERTISED }),
    ]);

    const identity = app._debug.buildCatalogIdentityFromSignatureProductRef(
      {
        merchant_id: 'merch_obs_acme',
        product_id: 'ext_acme_1',
        pivota_signature_id: SIG_SIBLING,
        content_key: CONTENT_KEY,
        content_canonical_sig_id: SIG_ADVERTISED,
      },
      { requestedSigId: SIG_SIBLING },
    );

    expect(identity.content_canonical_sig_id).toBe(SIG_ADVERTISED);
  });

  test('does NOT collide with canonical_sig_id, which is the sellable GROUP id', async () => {
    // Same word, different canonicalisation. `canonical_sig_id` on this ref is
    // the multi-merchant sellable item group; the content-key winner is a
    // strictly narrower thing and gets its own key. Conflating them would make
    // a grouped PDP canonicalise at its group and a duplicate PDP canonicalise
    // at nothing, or vice versa.
    const { app } = loadServerWithRows([
      signatureRow({ content_canonical_sig_id: SIG_ADVERTISED }),
    ]);

    const ref = await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG_SIBLING, {
      hydrateIdentityListing: false,
      hydrateIdentityGroupMembers: false,
    });

    expect(ref.content_canonical_sig_id).toBe(SIG_ADVERTISED);
    expect(ref.canonical_sig_id).not.toBe(SIG_ADVERTISED);
  });
});
