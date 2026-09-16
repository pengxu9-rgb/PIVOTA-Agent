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

  const seedRow = async ({ id, brand, title, domain = 'shop.example', attached = true }) => {
    const key = attached ? `pk_${id}` : null;
    if (key) {
      await db.query(
        `INSERT INTO catalog_products(product_key, content_key, pivota_signature_id, pivota_canonical_url, canonical_url, title)
         VALUES ($1, $2, $3, $4, $4, $5) ON CONFLICT DO NOTHING`,
        [key, `ck_${id}`, `sig_${id}`, `https://agent.pivota.cc/products/sig_${id}`, title],
      );
      await db.query(
        `INSERT INTO catalog_row_trust(subject_type, subject_key, serving_decision) VALUES ('product', $1, 'public')`,
        [key],
      );
    }
    await db.query(
      `INSERT INTO external_product_seeds(id, external_product_id, market, tool, destination_url, canonical_url,
         domain, title, image_url, price_amount, price_currency, availability, seed_data, updated_at, created_at,
         status, attached_product_key)
       VALUES ($1, $1, 'US', 'creator_agents', $2, $2, $3, $4, 'https://img.example/x.jpg', 20, 'USD', 'in_stock',
         $5, now(), now(), 'active', $6)`,
      [id, `https://shop.example/${id}`, domain, title, JSON.stringify({ brand }), key],
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
    for (const brand of ['Fenty Beauty', 'Round Lab', 'AXIS-Y', 'mixsoon', 'Dr. Jart+', 'e.l.f.', 'Estee Lauder']) {
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

  test('the accented and hyphenated spellings are bound, not just the folded one', async () => {
    // normalizeBrandText keeps '-' and folds the acute to ASCII; the SQL class drops both. The
    // twin is bound ALONGSIDE, so each brand binds both spellings and neither side has to change.
    const axis = exactCall((await runFastpath('AXIS-Y')).calls);
    const axisKeys = axis.params.find((p) => Array.isArray(p) && p.every((v) => typeof v === 'string'));
    expect(axisKeys).toEqual(expect.arrayContaining(['axis-y', 'axisy']));

    const estee = exactCall((await runFastpath('Est\u00e9e Lauder')).calls);
    const esteeKeys = estee.params.find((p) => Array.isArray(p) && p.every((v) => typeof v === 'string'));
    // 'esteelauder' is what normalizeBrandText yields; 'estelauder' is what PostgreSQL stores.
    expect(esteeKeys).toEqual(expect.arrayContaining(['esteelauder', 'estelauder']));
  });

  test('a brand inside a longer query is NOT rescued, and that bound is deliberate', async () => {
    // The limit of a query-side fix, pinned so it is stated rather than discovered. The twin is
    // taken from the raw query text, so it only helps when the query IS the brand name — which is
    // what a brand page sends. Inside a sentence the brand reaches this function already folded by
    // detectBrandEntities, and no key built here can recover the original spelling.
    const inSentence = await runFastpath('AXIS-Y dark spot serum');
    expect(inSentence.ids).not.toContain('caps_axisy');
    // ...and the whole-sentence compaction is not bound as a brand key, which would be noise.
    const exact = exactCall(inSentence.calls);
    if (exact) {
      const keys = exact.params.find((p) => Array.isArray(p) && p.every((v) => typeof v === 'string')) || [];
      expect(keys).not.toContain('axisy');
    }
    // The bare brand page, the case this DOES fix, for contrast — so the assertion above reads as a
    // bound and not as the feature being absent.
    expect((await runFastpath('AXIS-Y')).ids).toEqual(['caps_axisy']);
  });

  test('a one-character twin key is never bound', async () => {
    // A brand in a non-Latin script reduces to almost nothing under '[^a-z0-9]'. A single
    // character is not an identity: bound, it would equal every unrelated row that reduces the
    // same way.
    const { calls: issued } = await runFastpath('\u30bb\u30eb\u30d5\u30e5\u30fc\u30b8\u30e7\u30f3C');
    const exact = exactCall(issued);
    if (exact) {
      const keys = exact.params.find((p) => Array.isArray(p) && p.every((v) => typeof v === 'string')) || [];
      expect(keys.filter((key) => key.length < 2)).toEqual([]);
    }
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

  test('an unrelated brand page is not widened by the correction', async () => {
    // Reachability was added, never crossed over: each brand still gets only its own rows.
    expect((await runFastpath('Tocobo')).ids).toEqual(['other_brand']);
    expect((await runFastpath('mixsoon')).ids).toEqual(['lower_mixsoon']);
    expect((await runFastpath('Fenty Beauty')).ids).not.toContain('other_brand');
  });
});
