const { Client } = require('pg');

// The external-seed brand fastpath's exact arm compares a key built in JS against a key built in
// SQL. The two were not the same function: the SQL spelling was
//
//   lower(regexp_replace(<brand>, '[^a-z0-9]+', '', 'g'))
//
// which runs the character class against the RAW mixed-case brand. 'A'-'Z' are not in '[a-z0-9]',
// so every capital letter was deleted before lower() ever ran: "Fenty Beauty" stored as
// 'entyeauty'. The JS side (normalizeBrandText) lowercases FIRST and binds 'fentybeauty', so the
// arm could only match a brand stored entirely in lower case, and everything else fell through to
// the broad fallback — which LIKEs over seed_data::text with no index.
//
// Measured on prod 2026-09-16: 10,283 of 11,817 attached active seeds carry a capital; replaying
// the 59 largest brand pages matched 1,311 rows under the old spelling and 7,916 under the new.
//
// This runs the REAL fastpath against real PostgreSQL, with the real brand lexicon supplying the
// bind, so it pins the membership of the statement production actually sends. Asserting the
// expression's text instead would pass for any spelling both sides happened to share — and both
// sides DID share the broken one, which is why nothing caught this.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('external seed brand fastpath on PostgreSQL', () => {
  let db;
  let schema;
  const calls = [];

  // Same as seedRow but the caller supplies the whole seed_data, so a row can be named by a
  // lower link of the brand chain (snapshot.brand) or by nothing at all (domain only).
  const seedRowRaw = async ({ id, seedData, title, domain = 'shop.example' }) => {
    const key = `pk_${id}`;
    await db.query(
      `INSERT INTO catalog_products(product_key, content_key, pivota_signature_id, pivota_canonical_url, canonical_url, title)
       VALUES ($1, $2, $3, $4, $4, $5) ON CONFLICT DO NOTHING`,
      [key, `ck_${id}`, `sig_${id}`, `https://agent.pivota.cc/products/sig_${id}`, title],
    );
    await db.query(
      `INSERT INTO catalog_row_trust(subject_type, subject_key, serving_decision) VALUES ('product', $1, 'public')`,
      [key],
    );
    await db.query(
      `INSERT INTO external_product_seeds(id, external_product_id, market, tool, destination_url, canonical_url,
         domain, title, image_url, price_amount, price_currency, availability, seed_data, updated_at, created_at,
         status, attached_product_key)
       VALUES ($1, $1, 'US', 'creator_agents', $2, $2, $3, $4, 'https://img.example/x.jpg', 20, 'USD', 'in_stock',
         $5, now(), now(), 'active', $6)`,
      [id, `https://shop.example/${id}`, domain, title, JSON.stringify(seedData), key],
    );
  };

  const seedRow = async ({
    id, brand, title, domain = 'shop.example', attached = true,
    status = 'active', servingDecision = 'public',
  }) => {
    const key = attached ? `pk_${id}` : null;
    if (key) {
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
       VALUES ($1, $1, 'US', 'creator_agents', $2, $2, $3, $4, 'https://img.example/x.jpg', 20, 'USD', 'in_stock',
         $5, now(), now(), $7, $6)`,
      [id, `https://shop.example/${id}`, domain, title, JSON.stringify({ brand }), key, status],
    );
  };

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `fastpath_caps_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`
      CREATE TABLE external_product_seeds(id text PRIMARY KEY, external_product_id text, market text, tool text,
        destination_url text, canonical_url text, domain text, title text, image_url text,
        price_amount numeric, price_currency text, availability text, seed_data jsonb,
        updated_at timestamptz, created_at timestamptz, status text, attached_product_key text);
      CREATE TABLE catalog_products(product_key text PRIMARY KEY, content_key text, pivota_signature_id text,
        pivota_canonical_url text, canonical_url text, title text);
      CREATE TABLE catalog_row_trust(subject_type text, subject_key text, serving_decision text);
    `);

    // The spread of capitalisations a real feed carries. 'mixsoon' is the ONLY one the broken
    // spelling could reach, which is what makes the control below meaningful.
    await seedRow({ id: 'caps_fenty', brand: 'Fenty Beauty', title: 'Gloss Bomb' });
    await seedRow({ id: 'caps_roundlab', brand: 'Round Lab', title: 'Dokdo Toner' });
    await seedRow({ id: 'caps_axisy', brand: 'AXIS-Y', title: 'Dark Spot Serum' });
    await seedRow({ id: 'lower_mixsoon', brand: 'mixsoon', title: 'Bean Essence' });
    await seedRow({ id: 'other_brand', brand: 'Tocobo', title: 'Vita Serum' });
    // The residue trap: a genuinely BB-branded row. A query written in hangul must not reach it
    // as an exact brand match just because 'BB' is the only Latin left in the query.
    await seedRow({ id: 'residue_bb', brand: 'BB', title: 'BB Labs Cushion' });
    // The two lower links of the match expression's coalesce chain. Without a row that is named
    // ONLY by each of them, either link can be deleted from the expression with the suite green.
    await seedRowRaw({ id: 'chain_snapshot', seedData: { snapshot: { brand: 'Snapbrand' } }, title: 'Snap Item' });
    await seedRowRaw({ id: 'chain_domain', seedData: {}, title: 'Domain Item', domain: 'domainbrand.com' });
    // Negative controls for the exact arm's row scope.
    await seedRow({ id: 'scope_suppressed', brand: 'Suppressed Brand', title: 'Hidden Item', servingDecision: 'suppressed' });
    await seedRow({ id: 'scope_inactive', brand: 'Inactive Brand', title: 'Retired Item', status: 'inactive' });
    await seedRow({ id: 'scope_unattached', brand: 'Unattached Brand', title: 'Loose Item', attached: false });
  }, 60000);

  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  // The real fastpath, with the real brand lexicon deciding the bound key. Only the two product
  // builders are stand-ins: they shape the returned row and cannot change which rows match.
  const runFastpath = async (queryText) => {
    calls.length = 0;
    const { runExternalSeedBrandMainlineFastpath } = require('../../src/findProductsExternalSeedBrandFastpath');
    const {
      detectBrandEntities,
      buildBrandQueryVariants,
      normalizeBrandText,
    } = require('../../src/findProductsMulti/brandLexicon');
    const beautyRelevanceGate = require('../../src/services/beautyRelevanceGate');
    const response = await runExternalSeedBrandMainlineFastpath({
      relevanceQueryText: queryText,
      market: 'US',
      tool: '*',
      includeAttached: true,
      safeLimit: 50,
      deps: {
        detectBrandEntities,
        normalizeSearchTextForMatch: (raw) => beautyRelevanceGate.normalizeSearchTextForMatch(raw),
        buildBrandQueryVariants,
        normalizeBrandText,
        buildExternalSeedBrandSearchProduct: (row) => ({ external_seed_id: row.id, brand: row.brand }),
        buildSearchProductKey: (product) => product.external_seed_id,
        query: async (sql, params) => {
          calls.push({ sql, params });
          return db.query(sql, params);
        },
        logger: { warn() {}, info() {}, error() {} },
      },
    });
    return {
      ids: (response?.products || []).map((product) => product.external_seed_id).sort(),
      strategy: response?.metadata?.source_breakdown?.strategy_applied || null,
      calls: [...calls],
    };
  };

  const exactCall = (issued) => issued.find((call) => call.sql.includes('total_rows')) || null;

  test('a brand stored with capitals is matched by the exact arm', async () => {
    const fenty = await runFastpath('Fenty Beauty');
    expect(fenty.ids).toEqual(['caps_fenty']);
    // The exact arm, not the broad fallback: the fallback would also be "a match", and would hide
    // the defect behind a fuzzier, far more expensive scan.
    expect(fenty.strategy).toBe('brand_search_external_seed_mainline_exact');

    const roundLab = await runFastpath('Round Lab');
    expect(roundLab.ids).toEqual(['caps_roundlab']);
    expect(roundLab.strategy).toBe('brand_search_external_seed_mainline_exact');
  });

  test('the key PostgreSQL stores is one of the keys the fastpath binds', async () => {
    // The real contract, and deliberately not "normalizeBrandText equals the SQL expression" —
    // it does not, and cannot without changing every other caller of it. What must hold is that
    // the value the server computes for a row is present in the array this query binds. Both
    // sides are read from the running code: the expression out of the statement the fastpath
    // issued, the keys out of its bound parameters.
    const missing = [];
    // Brands whose SQL key and bound key are the same function. AXIS-Y and "Estée Lauder" are
    // deliberately NOT here — see the stated gap below.
    for (const brand of ['Fenty Beauty', 'Round Lab', 'mixsoon', 'Dr. Jart+', 'e.l.f.', 'Estee Lauder']) {
      const { calls: issued } = await runFastpath(brand);
      const exact = exactCall(issued);
      const expression = exact.sql.match(/AND\s+(regexp_replace\([\s\S]*?'g'\s*\))\s*=\s*ANY/);
      expect(expression).not.toBeNull();
      const bound = exact.params.find((param) => Array.isArray(param) && param.every((v) => typeof v === 'string'));
      const res = await db.query(
        `SELECT ${expression[1]} AS stored
         FROM (SELECT $1::jsonb AS seed_data, ''::text AS domain) external_product_seeds`,
        [JSON.stringify({ brand })],
      );
      if (!bound.includes(res.rows[0].stored)) missing.push({ brand, stored: res.rows[0].stored, bound });
    }
    expect(missing).toEqual([]);
  });

  test('STATED GAP: a brand whose punctuation or accent the SQL fold drops is still unreached', async () => {
    // normalizeBrandText KEEPS '-', '&' and '®' and folds accents to ASCII; the SQL '[^a-z0-9]'
    // drops all of them. These brands were never reachable by the exact arm and still are not —
    // this change fixes the CAPITALS, not the character class. Pinned so the gap is stated rather
    // than rediscovered, and so the next attempt starts from a failing assertion.
    //
    // The fix is NOT a key folded from raw query text: that was tried and reverted because a
    // non-Latin query's Latin residue then binds as a brand identity (see the test above). It
    // needs a key derived from a DETECTED brand.
    const { normalizeBrandText } = require('../../src/findProductsMulti/brandLexicon');
    for (const [brand, storedKey] of [['AXIS-Y', 'axisy'], ['Est\u00e9e Lauder', 'estelauder']]) {
      const res = await db.query(
        `SELECT regexp_replace(lower(coalesce(seed_data->>'brand', '')), '[^a-z0-9]+', '', 'g') AS stored
         FROM (SELECT $1::jsonb AS seed_data) t`,
        [JSON.stringify({ brand })],
      );
      expect(res.rows[0].stored).toBe(storedKey);
      expect(normalizeBrandText(brand).replace(/\s+/g, '')).not.toBe(storedKey);
    }
    // And end to end: the AXIS-Y row is not returned by the exact arm.
    expect((await runFastpath('AXIS-Y')).strategy).not.toBe('brand_search_external_seed_mainline_exact');
  });

  test('the broken spelling is what the corrected one must not be', async () => {
    // The control, and the reason this test cannot pass by both sides going empty: the retired
    // expression is kept verbatim and must still delete the capitals. Without it, a change that
    // broke BOTH sides identically would look like a pass.
    const broken =
      "lower(regexp_replace(coalesce(seed_data->>'brand', ''), '[^a-z0-9]+', '', 'g'))";
    const res = await db.query(
      `SELECT ${broken} AS stored FROM (SELECT $1::jsonb AS seed_data) t`,
      [JSON.stringify({ brand: 'Fenty Beauty' })],
    );
    expect(res.rows[0].stored).toBe('entyeauty');
  });

  test('a non-Latin query is not hijacked by its Latin residue', async () => {
    // Found by adversarial review of the first cut of this change, which also bound the SQL fold
    // of the RAW query text as a brand key. For a query in a non-Latin script that fold leaves
    // only the Latin residue — a product-line token, not a brand — and the exact arm returns
    // BEFORE the broad fallback runs, so one junk match suppressed the rows the fallback used to
    // return. KR and JP are served markets.
    const hangul = '\uc124\ud654\uc218 \uc5d0\uc13c\uc15c BB';
    const { ids, strategy, calls: issued } = await runFastpath(hangul);
    const exact = exactCall(issued);
    if (exact) {
      const keys = exact.params.find((p) => Array.isArray(p) && p.every((v) => typeof v === 'string')) || [];
      // 'bb' is the residue. Binding it as a brand identity is what lost the correct rows.
      expect(keys).not.toContain('bb');
    }
    // The broad fallback may still surface that row by substring, exactly as it does on main —
    // what must not happen is the EXACT arm claiming it and returning early, which is what
    // suppressed the correct rows. Asserting on ids alone cannot tell those two apart.
    expect(strategy).not.toBe('brand_search_external_seed_mainline_exact');
    expect(Array.isArray(ids)).toBe(true);
  });

  test('the row scope of the exact arm is not widened by the expression change', async () => {
    // Negative controls. Every other fixture is active, attached, US and publicly servable, so
    // without these the exact arm's scope predicates are deletable with the suite green — the
    // serving-trust gate included.
    expect((await runFastpath('Suppressed Brand')).ids).toEqual([]);   // serving_decision <> 'public'
    expect((await runFastpath('Inactive Brand')).ids).toEqual([]);     // status <> 'active'
    expect((await runFastpath('Unattached Brand')).ids).toEqual([]);   // no attached_product_key
    // ...and a brand that IS servable still comes back, so the three above cannot pass by the
    // whole arm being broken.
    expect((await runFastpath('Fenty Beauty')).ids).toEqual(['caps_fenty']);
  });

  test('every link of the brand chain the expression reads is reachable', async () => {
    // The expression this change rewrites is a coalesce chain: seed_data.brand, then
    // snapshot.brand, then the domain label. Each lower link needs a row named ONLY by it, or the
    // link can be deleted from the expression and every test still passes.
    // Asserted on the EXACT arm, not on the ids: the broad fallback substring-matches
    // seed_data::text and the domain column, so it returns these rows whatever the brand
    // expression reads — which is exactly how a deleted chain link stays invisible.
    const snap = await runFastpath('Snapbrand');
    expect(snap.ids).toContain('chain_snapshot');
    expect(snap.strategy).toBe('brand_search_external_seed_mainline_exact');

    const dom = await runFastpath('Domainbrand');
    expect(dom.ids).toContain('chain_domain');
    expect(dom.strategy).toBe('brand_search_external_seed_mainline_exact');

    // ...and the chain's ORDER is unchanged: a row carrying seed_data.brand is named by that,
    // never by its domain.
    const toc = await runFastpath('Tocobo');
    expect(toc.ids).toContain('other_brand');
    expect(toc.strategy).toBe('brand_search_external_seed_mainline_exact');
  });

  test('an unrelated brand page is not widened by the correction', async () => {
    // Reachability was added, never crossed over: each brand still gets only its own rows.
    expect((await runFastpath('Tocobo')).ids).toEqual(['other_brand']);
    expect((await runFastpath('mixsoon')).ids).toEqual(['lower_mixsoon']);
    expect((await runFastpath('Fenty Beauty')).ids).not.toContain('other_brand');
  });
});
