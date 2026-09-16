const { Client } = require('pg');

// The brand-page seed scan (discoveryFeed's fetchBrandScopedExternalSeedCandidates) was the top
// statement in prod pg_stat_statements on 2026-09-15: 30,605 calls, 5.26s mean, 161,057s total. It
// matched brands with six OR'd JSONB expressions, four of them `LIKE ANY(array)` — unindexable — so
// every brand page scanned every attached seed. It now matches on the shared brand IDENTITY
// expression (src/services/brandSeedScanSql.js), which the new partial `text_pattern_ops` indexes
// can answer for both equality and prefix.
//
// This runs the REAL fetcher against real PostgreSQL. It pins three things:
//   1. MEMBERSHIP. The old predicate is kept below verbatim (origin/main src/services/discoveryFeed.js,
//      `brandMatchSql`, with its $3 normalized aliases / $4 prefix patterns / $6 compact aliases) and
//      is executed side by side with the statement the fetcher actually issues. Every row of the
//      fixture must land on the same side for both, EXCEPT the divergences enumerated in
//      KNOWN_DIVERGENCES, each of which is pinned individually. Together those two assertions are as
//      strong as plain set equality: any membership change in either predicate flips one of them.
//   2. INDEX USAGE. Both new indexes are built here from primaryBrandIndexDefinitions(), and EXPLAIN
//      of the fetcher's own statements must produce an `Index Cond` on each of them. An expression
//      index only yields an Index Cond when the query expression matches the index expression
//      CHARACTER FOR CHARACTER, so this is the drift alarm between query and index definition.
//      An index scan with the expression only in `Filter:` is a failure, not a pass.
//   3. The products the fetcher returns correspond to exactly those seeds.
//
// Each excluded fixture row is excluded by exactly ONE condition, so removing that condition from
// production changes the member set.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const IDENTITY_INDEX = 'idx_external_seeds_brand_identity_prefix_v1';
const TITLE_INDEX = 'idx_external_seeds_attached_title_prefix_v1';

// A substring unique to the brand-identity expression (SEED_OWN_BRAND_SQL's last JSONB path) as
// PostgreSQL renders it in a plan, and one unique to the seed-title expression.
const IDENTITY_PLAN_MARKER = "{derived,recall,brand_name}";
const TITLE_PLAN_MARKER = "-> 'snapshot'::text) ->> 'title'";

// ---------------------------------------------------------------------------
// The OLD predicate, verbatim from `git show origin/main:src/services/discoveryFeed.js`
// (fetchBrandScopedExternalSeedCandidates, ~line 8857-8872), with the ${...} interpolations of
// epsBrandFieldSql / normalizedBrandSql / compactBrandSql / indexedBrandSql expanded in place. It is
// a frozen literal on purpose: it must not follow any later edit to the shared SQL constants.
// ---------------------------------------------------------------------------
const OLD_EPS_BRAND_SQL =
  "lower(coalesce(eps.seed_data->'derived'->'recall'->>'brand', eps.seed_data->>'brand', eps.seed_data->>'brand_name', eps.seed_data->>'vendor', eps.seed_data->>'vendor_name', eps.seed_data->'snapshot'->>'brand', eps.seed_data->'snapshot'->>'brand_name', eps.seed_data->'snapshot'->>'vendor', eps.seed_data->'snapshot'->>'vendor_name', ''))";
const OLD_BRAND_MATCH_SQL = `(
        ${OLD_EPS_BRAND_SQL} = ANY($3::text[])
        OR ${OLD_EPS_BRAND_SQL} LIKE ANY($4::text[])
        OR trim(regexp_replace(${OLD_EPS_BRAND_SQL}, '[^a-z0-9]+', ' ', 'g')) = ANY($3::text[])
        OR trim(regexp_replace(${OLD_EPS_BRAND_SQL}, '[^a-z0-9]+', ' ', 'g')) LIKE ANY($4::text[])
        OR regexp_replace(${OLD_EPS_BRAND_SQL}, '[^a-z0-9]+', '', 'g') = ANY($6::text[])
        OR lower(regexp_replace(coalesce(eps.seed_data->>'brand', eps.seed_data->'snapshot'->>'brand', split_part(eps.domain, '.', 1), ''), '[^a-z0-9]+', '', 'g')) = ANY($6::text[])
      )`;
// The rest of the old primary statement, also verbatim — including its old row scope
// (`attached_product_key IS NOT NULL`), the JOIN and the serving/trust gate — so the two sides are
// compared over the same rows, and the scope change is itself one of the pinned divergences.
const OLD_PRIMARY_SQL = `
  SELECT eps.id
  FROM external_product_seeds eps
  JOIN catalog_products cp ON cp.product_key = eps.attached_product_key
  JOIN catalog_row_trust crt
    ON crt.subject_type = 'product'
   AND crt.subject_key = cp.product_key
   AND crt.serving_decision = 'public'
  WHERE eps.status = 'active'
    AND eps.attached_product_key IS NOT NULL
    AND eps.market = $1
    AND (eps.tool = '*' OR eps.tool = $2)
    AND ${OLD_BRAND_MATCH_SQL}
  ORDER BY eps.id
  LIMIT $5
`;

// Rows where the new predicate deliberately does NOT agree with the old one. Each is pinned by its
// own assertion below; nothing else in the fixture may move.
const KNOWN_DIVERGENCES = {
  // SEED_OWN_BRAND_SQL reads `derived.recall.brand_name`; the old coalesce chain never did.
  recall_brand_name_only: 'new',
  // The old chain put `derived.recall.brand` FIRST (it beat brand_name); SEED_OWN_BRAND_SQL puts it
  // LAST, so a row carrying both now resolves to brand_name.
  recall_brand_precedence: 'new',
  // identitySql folds Latin accents with translate(); the old regexp turned 'ô' into a separator, so
  // "Lancôme" normalized to 'lanc me' and no unaccented alias could ever reach it.
  accent_lancome: 'new',
  // Compact identity makes the prefix arm cross word boundaries: alias "round lab" -> 'roundlab%'
  // now reaches the brand "Roundlabus". The old prefix patterns kept the space ('round lab%').
  compact_prefix_roundlabus: 'new',
  // NOT divergent, and listed here so a later edit cannot make it so: the old `indexedBrandSql` fell
  // back to split_part(domain, '.', 1) when seed_data carried no brand at all, so
  // seedBrandIdentitySql keeps that leg as brand-of-last-resort. Drop the leg and this row turns
  // 'old' — a silent narrowing — which fails the divergence assertion below.
  // (No prod row needs it today: 0 of 11,817 attached active seeds have an empty own-brand identity.)
  // Row scope: the old `attached_product_key IS NOT NULL` admitted the empty string; the new
  // `coalesce(attached_product_key, '') <> ''` (which the partial indexes carry) does not.
  attached_empty_key: 'old',
};

suite('brand-page external seed scan on PostgreSQL', () => {
  let db;
  let schema;
  let priorEnv;
  let indexDefinitions;

  const seedRow = async ({
    id,
    seedData,
    title = 'Some Product',
    domain = 'shop.example',
    market = 'US',
    tool = 'creator_agents',
    status = 'active',
    attachedKey = undefined,
    servingDecision = 'public',
  }) => {
    const key = attachedKey === undefined ? `pk_${id}` : attachedKey;
    if (key !== null) {
      await db.query(
        `INSERT INTO catalog_products(product_key, content_key, pivota_signature_id, pivota_canonical_url, canonical_url, title)
         VALUES ($1, $2, $3, $4, $4, $5) ON CONFLICT DO NOTHING`,
        [key, `ck_${id}`, `sig_${id}`, `https://agent.pivota.cc/products/sig_${id}`, title],
      );
      await db.query(
        `INSERT INTO catalog_row_trust(subject_type, subject_key, serving_decision) VALUES ('product', $1, $2)`,
        [key, servingDecision],
      );
    }
    await db.query(
      `INSERT INTO external_product_seeds(id, external_product_id, market, tool, destination_url, canonical_url,
         domain, title, image_url, price_amount, price_currency, availability, seed_data, updated_at, created_at,
         status, attached_product_key)
       VALUES ($1, $1, $2, $3, $4, $4, $5, $6, 'https://img.example/x.jpg', 20, 'USD', 'in_stock', $7,
         now(), now(), $8, $9)`,
      [id, market, tool, `https://shop.example/${id}`, domain, title, JSON.stringify(seedData), status, key],
    );
  };

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `brand_seed_scan_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`
      CREATE TABLE external_product_seeds(id text, external_product_id text, market text, tool text,
        destination_url text, canonical_url text, domain text, title text, image_url text,
        price_amount numeric, price_currency text, availability text, seed_data jsonb,
        updated_at timestamptz, created_at timestamptz, status text, attached_product_key text);
      CREATE TABLE catalog_products(product_key text PRIMARY KEY, content_key text, pivota_signature_id text,
        pivota_canonical_url text, canonical_url text, title text);
      CREATE TABLE catalog_row_trust(subject_type text, subject_key text, serving_decision text);
      CREATE INDEX ON catalog_row_trust(subject_key);
    `);

    // ---- exact identity, one row per seed_data path SEED_OWN_BRAND_SQL reads ----
    await seedRow({ id: 'exact_brand_name', seedData: { brand_name: 'Mixsoon' }, title: 'Bean Essence 50ml' });
    await seedRow({ id: 'exact_snapshot_brand', seedData: { snapshot: { brand: 'Mixsoon' } }, title: 'Glow Serum' });
    await seedRow({ id: 'exact_vendor', seedData: { vendor: 'Mixsoon' }, title: 'Cleansing Bar' });
    await seedRow({ id: 'recall_brand_name_only', seedData: { derived: { recall: { brand_name: 'Mixsoon' } } }, title: 'Toner Pad' });
    // Both recall paths plus brand_name: old precedence picked derived.recall.brand ('Tocobo'),
    // SEED_OWN_BRAND_SQL picks brand_name ('Mixsoon').
    await seedRow({ id: 'recall_brand_precedence', seedData: { brand_name: 'Mixsoon', derived: { recall: { brand: 'Tocobo' } } }, title: 'Barrier Cream' });
    // tool '*' is served to every tool.
    await seedRow({ id: 'exact_tool_star', seedData: { brand_name: 'Mixsoon' }, title: 'Cotton Pads', tool: '*' });

    // ---- accents, punctuation, prefix, and the >= 4 prefix floor ----
    await seedRow({ id: 'accent_lancome', seedData: { brand_name: 'Lancôme' }, title: 'Teint Idole' });
    await seedRow({ id: 'punct_drjart', seedData: { brand_name: 'Dr. Jart+' }, title: 'Cicapair Cream' });
    // The real prod case the design had to keep: a "<brand> <market>" seed on a brand page.
    await seedRow({ id: 'prefix_roundlab_us', seedData: { brand_name: 'Round Lab US' }, title: 'Dokdo Toner' });
    await seedRow({ id: 'compact_prefix_roundlabus', seedData: { brand_name: 'Roundlabus' }, title: 'Birch Cleanser' });
    // Only an alias of length >= 4 may prefix-match: alias 'abc' must not reach this row.
    await seedRow({ id: 'short_alias_abcdef', seedData: { brand_name: 'Abcdef Labs' }, title: 'Mystery Thing' });
    // A 3-character brand can only be reached by the equality arm, never by a prefix.
    await seedRow({ id: 'exact_short_nyx', seedData: { brand_name: 'NYX' }, title: 'Butter Gloss' });
    // No brand anywhere in seed_data; only the retired domain fallback could ever name it.
    await seedRow({ id: 'domain_only_brand', seedData: { note: 'no brand fields' }, title: 'Unnamed Item', domain: 'mixsoon.com' });

    // ---- rows that must stay OUT, one condition each ----
    await seedRow({ id: 'out_wrong_market', seedData: { brand_name: 'Mixsoon' }, market: 'SG' });
    await seedRow({ id: 'out_wrong_tool', seedData: { brand_name: 'Mixsoon' }, tool: 'shopping_agents' });
    await seedRow({ id: 'out_status_paused', seedData: { brand_name: 'Mixsoon' }, status: 'paused' });
    await seedRow({ id: 'out_attached_null', seedData: { brand_name: 'Mixsoon' }, attachedKey: null });
    await seedRow({ id: 'attached_empty_key', seedData: { brand_name: 'Mixsoon' }, attachedKey: '' });
    await seedRow({ id: 'out_other_brand', seedData: { brand_name: 'Tocobo' }, title: 'Lip Balm' });
    await seedRow({ id: 'out_trust_not_public', seedData: { brand_name: 'Mixsoon' }, servingDecision: 'private' });

    // ---- backfill lane: brand does not match, title starts with "<alias> " ----
    // seedTitleSql's coalesce order is snapshot.title, then seed_data.title, then the column. Each
    // backfill row puts the matching text at a different position, and decoys at the others, so any
    // reordering of that coalesce drops one of them.
    await seedRow({
      id: 'title_backfill_snapshot',
      seedData: { brand_name: 'Unrelated Co', snapshot: { title: 'Mixsoon Bean Cream 100ml' }, title: 'Zz Bean Cream' },
      title: 'Qq Bean Cream',
    });
    await seedRow({
      id: 'title_backfill_seed_data',
      seedData: { brand_name: 'Unrelated Co', title: 'Mixsoon Glow Toner 150ml' },
      title: 'Ww Glow Toner',
    });

    // ---- a brand with enough primary matches to fill the limit, plus a title-only row ----
    for (let i = 0; i < 24; i += 1) {
      await seedRow({ id: `full_${String(i).padStart(2, '0')}`, seedData: { brand_name: 'Fullbrand' }, title: `Fullbrand Item ${i}` });
    }
    await seedRow({ id: 'full_title_only', seedData: { brand_name: 'Unrelated Co' }, title: 'Fullbrand Extra Item' });
    // The backfill lane orders by recency and takes only (limit - primary rows); make this row the
    // most recent so the assertion below is about the lane running, not about tie-breaking.
    await db.query(`UPDATE external_product_seeds SET updated_at = now() + interval '1 hour' WHERE id = 'full_title_only'`);

    // Filler so the planner has a real reason to prefer the expression indexes; without volume every
    // plan costs the same and an EXPLAIN assertion would be measuring noise.
    await db.query(`INSERT INTO catalog_products(product_key) SELECT 'pkf' || g FROM generate_series(1, 3000) g`);
    await db.query(`INSERT INTO catalog_row_trust SELECT 'product', 'pkf' || g, 'public' FROM generate_series(1, 3000) g`);
    await db.query(`
      INSERT INTO external_product_seeds(id, external_product_id, market, tool, destination_url, canonical_url,
        domain, title, image_url, price_amount, price_currency, availability, seed_data, updated_at, created_at,
        status, attached_product_key)
      SELECT 'f' || g, 'f' || g, 'US', 'creator_agents', 'https://shop.example/f' || g, 'https://shop.example/f' || g,
        'shop.example', 'Filler Item ' || g, 'https://img.example/x.jpg', 20, 'USD', 'in_stock',
        jsonb_build_object('brand_name', 'Filler Brand ' || (g % 500)), now(), now(), 'active', 'pkf' || g
      FROM generate_series(1, 3000) g`);

    // Build the two new indexes from their single source of truth. CONCURRENTLY cannot run inside a
    // transaction block, and is irrelevant to whether the planner can use the index.
    const { primaryBrandIndexDefinitions } = require('../../scripts/catalog/primary_brand_indexes');
    indexDefinitions = primaryBrandIndexDefinitions();
    for (const definition of indexDefinitions) {
      if (definition.table !== 'external_product_seeds') continue;
      await db.query(definition.sql.replace(' CONCURRENTLY', ''));
    }
    await db.query('ANALYZE external_product_seeds');
    await db.query('ANALYZE catalog_products');
    await db.query('ANALYZE catalog_row_trust');
  }, 120000);

  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  let calls;
  beforeEach(() => {
    priorEnv = { ...process.env };
    process.env.DATABASE_URL = url;
    delete process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET;
    calls = [];
    jest.resetModules();
    jest.doMock('../../src/db', () => ({
      query: async (sql, params) => {
        calls.push({ sql, params });
        return db.query(sql, params);
      },
      withClient: async (fn) => fn({ query: async (sql, params) => db.query(sql, params) }),
    }));
  });
  afterEach(() => {
    process.env = priorEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
  });

  // Runs the REAL fetcher. Returns the products it built plus the statements it issued.
  const runFetcher = async (brandAliases, options = {}) => {
    calls.length = 0;
    const discovery = require('../../src/services/discoveryFeed');
    const products = await discovery._internals.fetchBrandScopedExternalSeedCandidates({
      brandAliases,
      limit: 24,
      ...options,
    });
    return { products, calls: [...calls] };
  };

  // The ids the fetcher's OWN primary statement selects. The statement is re-executed verbatim as a
  // subquery so nothing about it is rewritten — the membership under test is the membership of the
  // exact text production sends.
  const newPrimaryIds = async (brandAliases, options = {}) => {
    const { calls: issued } = await runFetcher(brandAliases, { limit: 500, ...options });
    expect(issued.length).toBeGreaterThanOrEqual(1);
    const primary = issued[0];
    const res = await db.query(`SELECT t.id FROM (${primary.sql}) t ORDER BY t.id`, primary.params);
    return res.rows.map((row) => row.id);
  };

  const oldPrimaryIds = async (brandAliases) => {
    const { normalizeBrandText } = require('../../src/findProductsMulti/brandLexicon');
    const normalizedAliases = [...new Set(brandAliases.map((alias) => normalizeBrandText(alias)).filter(Boolean))];
    const prefixPatterns = normalizedAliases.filter((alias) => alias.length >= 4).map((alias) => `${alias}%`);
    const compactAliases = [...new Set(normalizedAliases.map((alias) => alias.replace(/\s+/g, '')).filter(Boolean))];
    const res = await db.query(OLD_PRIMARY_SQL, ['US', 'creator_agents', normalizedAliases, prefixPatterns, 500, compactAliases]);
    return res.rows.map((row) => row.id);
  };

  // [label, aliases, the seeds BOTH predicates must select]. The third element is spelled out rather
  // than derived, so an assertion cannot pass by both sides going empty together.
  const ALIAS_SETS = [
    // domain_only_brand carries no brand anywhere in seed_data and is reached only through the
    // identity's domain leg — the same brand-of-last-resort the old indexedBrandSql had.
    ['a long alias over several seed_data paths', ['Mixsoon'],
      ['domain_only_brand', 'exact_brand_name', 'exact_snapshot_brand', 'exact_tool_star', 'exact_vendor']],
    ['an unaccented alias for an accented brand', ['Lancome'], []],
    ['an accented alias', ['Lancôme'], []],
    ['a punctuated alias', ['Dr. Jart+'], ['punct_drjart']],
    ['a two-word alias that must prefix-match', ['Round Lab'], ['prefix_roundlab_us']],
    ['a 3-character alias (below the prefix floor)', ['Abc'], []],
    ['a 3-character alias that is an exact brand', ['NYX'], ['exact_short_nyx']],
    ['several aliases at once', ['Mixsoon', 'Round Lab', 'Lancome', 'NYX', 'Dr Jart'],
      ['domain_only_brand', 'exact_brand_name', 'exact_short_nyx', 'exact_snapshot_brand', 'exact_tool_star',
        'exact_vendor', 'prefix_roundlab_us', 'punct_drjart']],
    ['an alias that matches nothing', ['Nosuchbrand'], []],
  ];

  // ---------------------------------------------------------------------------
  // 1. Equivalence
  // ---------------------------------------------------------------------------
  describe.each(ALIAS_SETS)('membership: %s', (_label, aliases, shared) => {
    test('the new predicate selects the same seeds as the old one', async () => {
      const oldIds = await oldPrimaryIds(aliases);
      const newIds = await newPrimaryIds(aliases);
      const drop = (ids) => ids.filter((id) => !(id in KNOWN_DIVERGENCES));
      expect(drop(newIds)).toEqual(drop(oldIds));
      // ...and both are the set this fixture says they must be, so neither can pass by selecting
      // nothing at all.
      expect(drop(newIds)).toEqual(shared);
    });
  });

  test('the only rows the two predicates disagree on are the enumerated divergences', async () => {
    const seen = {};
    for (const [, aliases] of ALIAS_SETS) {
      const oldIds = await oldPrimaryIds(aliases);
      const newIds = await newPrimaryIds(aliases);
      for (const id of newIds) if (!oldIds.includes(id)) seen[id] = 'new';
      for (const id of oldIds) if (!newIds.includes(id)) seen[id] = 'old';
    }
    expect(seen).toEqual(KNOWN_DIVERGENCES);
  });

  test('a 3-character alias never prefix-matches', async () => {
    expect(await newPrimaryIds(['Abc'])).toEqual([]);
    // Control: the row is reachable at all — a 6-character alias does find it.
    expect(await newPrimaryIds(['Abcdef'])).toEqual(['short_alias_abcdef']);
  });

  test('"Round Lab US" is returned for the alias "round lab"', async () => {
    expect(await newPrimaryIds(['round lab'])).toEqual(['compact_prefix_roundlabus', 'prefix_roundlab_us']);
  });

  test('a 3-character brand is still reached by the equality arm', async () => {
    expect(await newPrimaryIds(['NYX'])).toEqual(['exact_short_nyx']);
  });

  test('an accented brand is reached by both the accented and the unaccented alias', async () => {
    expect(await newPrimaryIds(['Lancome'])).toEqual(['accent_lancome']);
    expect(await newPrimaryIds(['Lancôme'])).toEqual(['accent_lancome']);
  });

  test('a punctuated brand is reached by a plain alias', async () => {
    expect(await newPrimaryIds(['Dr Jart'])).toEqual(['punct_drjart']);
  });

  test('the rows excluded by market, tool, status, attachment and the serving gate stay out', async () => {
    const ids = await newPrimaryIds(['Mixsoon']);
    for (const excluded of [
      'out_wrong_market',
      'out_wrong_tool',
      'out_status_paused',
      'out_attached_null',
      'attached_empty_key',
      'out_other_brand',
      'out_trust_not_public',
    ]) {
      expect(ids).not.toContain(excluded);
    }
    // Control: the same brand on an otherwise identical row IS returned, so the exclusions above are
    // each doing work rather than the whole brand being unreachable.
    expect(ids).toContain('exact_brand_name');
    expect(ids).toContain('exact_tool_star');
  });

  // ---------------------------------------------------------------------------
  // 1b. The divergences, pinned one by one
  // ---------------------------------------------------------------------------
  test('new only: derived.recall.brand_name is a brand path the old chain never read', async () => {
    expect(await newPrimaryIds(['Mixsoon'])).toContain('recall_brand_name_only');
    expect(await oldPrimaryIds(['Mixsoon'])).not.toContain('recall_brand_name_only');
  });

  test('new only: derived.recall.brand no longer outranks brand_name', async () => {
    expect(await newPrimaryIds(['Mixsoon'])).toContain('recall_brand_precedence');
    expect(await oldPrimaryIds(['Mixsoon'])).not.toContain('recall_brand_precedence');
    // ...and the row is no longer reachable under the brand the old chain resolved it to.
    expect(await newPrimaryIds(['Tocobo'])).not.toContain('recall_brand_precedence');
    expect(await oldPrimaryIds(['Tocobo'])).toContain('recall_brand_precedence');
  });

  test('new only: accent folding makes "Lancome" reach "Lancôme"', async () => {
    expect(await newPrimaryIds(['Lancome'])).toContain('accent_lancome');
    expect(await oldPrimaryIds(['Lancome'])).toEqual([]);
  });

  test('new only: the compact prefix crosses word boundaries', async () => {
    expect(await newPrimaryIds(['Round Lab'])).toContain('compact_prefix_roundlabus');
    expect(await oldPrimaryIds(['Round Lab'])).not.toContain('compact_prefix_roundlabus');
  });

  test('a seed with no brand in seed_data is still named by its domain, as it was before', async () => {
    // The retired `indexedBrandSql` fell back to split_part(domain, '.', 1); seedBrandIdentitySql
    // keeps that leg, so this row stays on the brand page. Removing the leg makes only the SECOND
    // assertion fail, which is the point of asserting both sides separately.
    expect(await oldPrimaryIds(['Mixsoon'])).toContain('domain_only_brand');
    expect(await newPrimaryIds(['Mixsoon'])).toContain('domain_only_brand');
    // ...and the leg cannot widen anything: it is reached only when every brand path is empty, so a
    // seed whose brand disagrees with its domain is still named by its brand.
    expect(await newPrimaryIds(['Otherdomain'])).not.toContain('exact_brand_name');
  });

  test('OLD only: an empty attached_product_key is no longer in scope', async () => {
    expect(await oldPrimaryIds(['Mixsoon'])).toContain('attached_empty_key');
    expect(await newPrimaryIds(['Mixsoon'])).not.toContain('attached_empty_key');
    // The new row scope is the one the partial indexes carry, so they remain usable.
    const { BRAND_SEED_SCAN_PREDICATE } = require('../../src/services/brandSeedScanSql');
    expect(BRAND_SEED_SCAN_PREDICATE).toBe("status = 'active' AND coalesce(attached_product_key, '') <> ''");
    for (const definition of indexDefinitions.filter((d) => [IDENTITY_INDEX, TITLE_INDEX].includes(d.name))) {
      expect(definition.predicate).toBe(BRAND_SEED_SCAN_PREDICATE);
    }
    const { calls: issued } = await runFetcher(['Mixsoon']);
    for (const call of issued) expect(call.sql).toContain("coalesce(eps.attached_product_key, '') <> ''");
  });

  // ---------------------------------------------------------------------------
  // 2. Index usage
  // ---------------------------------------------------------------------------
  const indexConditions = (plan) => {
    const lines = plan.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      const scan = lines[i].match(/(?:Bitmap Index Scan on|Index Scan using|Index Only Scan using) (\w+)/);
      if (!scan) continue;
      const next = String(lines[i + 1] || '').trim();
      out.push({ index: scan[1], cond: next.startsWith('Index Cond:') ? next : '' });
    }
    return out;
  };
  const explain = async ({ sql, params }) => {
    await db.query('BEGIN');
    try {
      // Without this the planner may pick a sequential scan purely on size and tell us nothing about
      // whether the expression is indexable at all.
      await db.query('SET LOCAL enable_seqscan = off');
      const res = await db.query(`EXPLAIN (COSTS OFF) ${sql}`, params);
      return indexConditions(res.rows.map((row) => row['QUERY PLAN']).join('\n'));
    } finally {
      await db.query('ROLLBACK');
    }
  };

  test('both brand arms are answered by idx_external_seeds_brand_identity_prefix_v1', async () => {
    const { calls: issued } = await runFetcher(['Mixsoon']);
    const conds = await explain(issued[0]);
    const onIdentity = conds.filter((entry) => entry.index === IDENTITY_INDEX && entry.cond);
    // The equality arm: `= ANY(...)` against the indexed identity expression.
    expect(
      onIdentity.some((entry) => entry.cond.includes('= ANY (') && entry.cond.includes(IDENTITY_PLAN_MARKER)),
    ).toBe(true);
    // The prefix arm: text_pattern_ops turns LIKE 'x%' into a ~>=~ / ~<~ range on the same expression.
    expect(
      onIdentity.some((entry) => entry.cond.includes('~>=~') && entry.cond.includes(IDENTITY_PLAN_MARKER)),
    ).toBe(true);
    // Negative control: the expression must not be reduced to a post-scan Filter on this index.
    expect(onIdentity.length).toBeGreaterThanOrEqual(2);
  });

  test('the backfill title arm is answered by idx_external_seeds_attached_title_prefix_v1', async () => {
    const { calls: issued } = await runFetcher(['Mixsoon']);
    expect(issued.length).toBe(2);
    const conds = await explain(issued[1]);
    expect(
      conds.some(
        (entry) => entry.index === TITLE_INDEX && entry.cond.includes('~>=~') && entry.cond.includes(TITLE_PLAN_MARKER),
      ),
    ).toBe(true);
  });

  test('the two index definitions exist, are text_pattern_ops, and trail the recency columns', () => {
    const byName = Object.fromEntries(indexDefinitions.map((definition) => [definition.name, definition]));
    for (const name of [IDENTITY_INDEX, TITLE_INDEX]) {
      expect(byName[name]).toBeTruthy();
      expect(byName[name].sql).toContain('text_pattern_ops');
      expect(byName[name].sql).toContain('updated_at DESC NULLS LAST, created_at DESC NULLS LAST');
      expect(byName[name].sql).toContain("WHERE status = 'active' AND coalesce(attached_product_key, '') <> ''");
    }
    // The query and the index must read their expression from the same module, or an edit to one
    // silently un-indexes the other.
    const { seedBrandIdentitySql, seedTitleSql } = require('../../src/services/brandSeedScanSql');
    expect(byName[IDENTITY_INDEX].expression).toBe(seedBrandIdentitySql());
    expect(byName[TITLE_INDEX].expression).toBe(seedTitleSql());
  });

  test('no `LIKE ANY(` survives in either statement — that is the shape no index can drive', async () => {
    const { calls: issued } = await runFetcher(['Mixsoon']);
    for (const call of issued) expect(call.sql).not.toMatch(/LIKE ANY\(/);
    expect(issued[1].sql).not.toContain('FROM unnest(');
  });

  // ---------------------------------------------------------------------------
  // 3. The products the fetcher returns
  // ---------------------------------------------------------------------------
  const seedIdsOf = (products) => products.map((product) => product.external_seed_id).sort();

  test('the fetcher returns products for exactly the matching seeds, plus the backfill', async () => {
    const { products } = await runFetcher(['Mixsoon']);
    expect(seedIdsOf(products)).toEqual([
      'domain_only_brand',
      'exact_brand_name',
      'exact_snapshot_brand',
      'exact_tool_star',
      'exact_vendor',
      'recall_brand_name_only',
      'recall_brand_precedence',
      'title_backfill_seed_data',
      'title_backfill_snapshot',
    ]);
    // Products, not rows: each one carries the serving-gated catalog signature it was joined to.
    for (const product of products) {
      expect(product.source).toBe('external_seed');
      expect(product.pivota_signature_id).toBe(`sig_${product.external_seed_id}`);
      expect(product.product_id).toBe(`sig_${product.external_seed_id}`);
    }
  });

  test('the backfill lane runs only when the primary lane underfills', async () => {
    const full = await runFetcher(['Fullbrand']);
    expect(full.calls).toHaveLength(1);
    expect(seedIdsOf(full.products)).toHaveLength(24);
    expect(seedIdsOf(full.products)).not.toContain('full_title_only');
    // One fewer primary row and the backfill runs, and finds it.
    const partial = await runFetcher(['Fullbrand'], { limit: 40 });
    expect(partial.calls).toHaveLength(2);
    expect(seedIdsOf(partial.products)).toContain('full_title_only');
  });

  test('the backfill matches the title through each arm of seedTitleSql\'s coalesce', async () => {
    const { products } = await runFetcher(['Mixsoon']);
    expect(seedIdsOf(products)).toEqual(expect.arrayContaining(['title_backfill_snapshot', 'title_backfill_seed_data']));
  });

  test('an alias that matches nothing returns no products and still issues both statements', async () => {
    const { products, calls: issued } = await runFetcher(['Nosuchbrand']);
    expect(products).toEqual([]);
    expect(issued).toHaveLength(2);
  });
});
