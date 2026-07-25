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
  test('joins the election table on content_key and selects the aliased winner', async () => {
    const { app, seenSql } = loadServerWithRows([signatureRow()]);

    await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG_SIBLING, {
      hydrateIdentityListing: false,
      hydrateIdentityGroupMembers: false,
    });

    const sql = seenSql[0];
    expect(sql).toContain('LEFT JOIN content_canonical_election cce');
    expect(sql).toContain('cce.content_key = cp.content_key');
    expect(sql).toContain('cce.canonical_sig_id AS content_canonical_sig_id');
  });

  test('the join is LEFT, so an unelected content_key still resolves', async () => {
    // A LEFT join is the whole safety story: freshly-minted content_keys, and
    // every row while the election sweep has not yet run, must keep resolving.
    // An INNER join would 404 them — turning a missing canonical TAG into a
    // missing PAGE.
    const { app, seenSql } = loadServerWithRows([signatureRow()]);

    await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG_SIBLING, {
      hydrateIdentityListing: false,
      hydrateIdentityGroupMembers: false,
    });

    expect(seenSql[0]).not.toMatch(/\bINNER JOIN content_canonical_election\b/);
    expect(seenSql[0]).not.toMatch(/\n\s*JOIN content_canonical_election\b/);
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
