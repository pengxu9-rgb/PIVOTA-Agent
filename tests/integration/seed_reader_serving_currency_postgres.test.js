const { Client } = require('pg');

// The seed readers that bring NEW products to a buyer outside the invoke search door, on real
// PostgreSQL: PDP/find_similar recommendations (RecommendationEngine), the Aurora BFF's local seed
// search, its photo-module deterministic seed candidates, and its ingredient recall. Peng 2026-09-26:
// a result priced in another currency than the buyer's must never reach the agent frontend; a
// market-less buyer is US (USD); a blank currency is refused; a market nothing is priced in gets
// nothing. Every fixture below has a USD control row, so an empty result can never pass for a
// refusal.

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('seed readers serve only the buyer currency, real PostgreSQL', () => {
  let db;
  let schema;
  let priorEnv;
  let statements;

  const insertSeed = async ({
    externalId,
    title,
    currency,
    attachedProductKey = null,
    seedData = {},
    tool = 'creator_agents',
    currencyInPayloadOnly = false,
  }) => {
    await db.query(
      `INSERT INTO external_product_seeds(id, external_product_id, market, tool, destination_url, canonical_url, domain,
         title, image_url, price_amount, price_currency, availability, seed_data, updated_at, created_at, status,
         attached_product_key)
       VALUES ($1, $1, 'US', $2, $3, $3, 'brand.example', $4, $5, 24, $6, 'in stock', $7, now(), now(), 'active', $8)`,
      [
        externalId,
        tool,
        `https://brand.example/products/${externalId}`,
        title,
        `https://cdn.example.com/${externalId}.jpg`,
        currencyInPayloadOnly ? null : currency,
        JSON.stringify({
          brand: 'Test Beauty',
          ...(currencyInPayloadOnly ? { price_currency: currency } : {}),
          ...seedData,
        }),
        attachedProductKey,
      ],
    );
  };

  const insertCatalogProduct = async ({ productKey, sourceSystem, sourceProductId, offerCurrencies = [] }) => {
    await db.query(
      `INSERT INTO catalog_products(product_key, content_key, merchant_id, platform, source_system, source_product_id,
         title, description, brand, product_type, category, category_path, canonical_url, image_url,
         pivota_signature_id, pivota_canonical_url, updated_at, sync_status, source_domain)
       VALUES ($1, $2, 'merch_obs_test', 'external_seed', $3, $4, $5, 'A serum.', 'Test Beauty', 'Serum', 'Serum',
         'beauty/skincare/serum', $6, $7, $8, NULL, now(), 'live', 'brand.example')`,
      [
        productKey,
        `ck_${productKey}`,
        sourceSystem,
        sourceProductId,
        `Test Beauty Serum ${productKey}`,
        `https://brand.example/products/${productKey}`,
        `https://cdn.example.com/${productKey}.jpg`,
        `sig_${productKey}`,
      ],
    );
    await db.query(`INSERT INTO index_pipeline_state(content_key, serving_eligible) VALUES ($1, TRUE)`, [`ck_${productKey}`]);
    for (const [index, currency] of offerCurrencies.entries()) {
      await db.query(
        `INSERT INTO catalog_offers(offer_id, product_key, sku_key, currency) VALUES ($1, $2, $3, $4)`,
        [`of_${productKey}_${index}`, productKey, `sku_${productKey}_${index}`, currency],
      );
    }
  };

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `seed_reader_currency_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`CREATE TABLE external_product_seeds(id text PRIMARY KEY, external_product_id text, market text,
      tool text, destination_url text, canonical_url text, domain text, title text, image_url text,
      price_amount numeric, price_currency text, availability text, seed_data jsonb, updated_at timestamptz,
      created_at timestamptz, status text, attached_product_key text, attached_variant_id text, search_text text)`);
    await db.query(`CREATE TABLE catalog_products(product_key text PRIMARY KEY, content_key text, merchant_id text,
      platform text, source_system text, source_product_id text, title text, description text, brand text,
      product_type text, category text, category_path text, canonical_url text, image_url text,
      pivota_signature_id text, pivota_canonical_url text, updated_at timestamptz, sync_status text, source_domain text)`);
    await db.query(`CREATE TABLE index_pipeline_state(content_key text PRIMARY KEY, serving_eligible boolean)`);
    await db.query(`CREATE TABLE catalog_offers(offer_id text PRIMARY KEY, product_key text, sku_key text, currency text)`);

    // --- similar recommendations (catalog_products lane) ---
    // Mirror rows priced by the seed they mirror (the eps_catalog join).
    await insertSeed({ externalId: 'ext_sim_usd', title: 'Similar USD', currency: 'USD' });
    await insertCatalogProduct({ productKey: 'mirror_usd', sourceSystem: 'external_product_seeds_mirror_v1', sourceProductId: 'ext_sim_usd', offerCurrencies: ['USD'] });
    await insertSeed({ externalId: 'ext_sim_jpy', title: 'Similar JPY', currency: 'JPY' });
    await insertCatalogProduct({ productKey: 'mirror_jpy', sourceSystem: 'external_product_seeds_mirror_v1', sourceProductId: 'ext_sim_jpy', offerCurrencies: ['JPY'] });
    await insertSeed({ externalId: 'ext_sim_blank', title: 'Similar blank', currency: ' ' });
    await insertCatalogProduct({ productKey: 'mirror_blank', sourceSystem: 'external_product_seeds_mirror_v1', sourceProductId: 'ext_sim_blank' });
    // A seed that says USD while the product's own offer is SGD (prod: 14 such rows) is ambiguous.
    await insertSeed({ externalId: 'ext_sim_conflict', title: 'Similar conflict', currency: 'USD' });
    await insertCatalogProduct({ productKey: 'mirror_conflict', sourceSystem: 'external_product_seeds_mirror_v1', sourceProductId: 'ext_sim_conflict', offerCurrencies: ['SGD'] });
    // Minted rows: no eps_catalog join at all; priced by the seed ATTACHED to them (prod: 614 SGD).
    await insertCatalogProduct({ productKey: 'minted_sgd', sourceSystem: 'catalog_enrichment_agent_v1', sourceProductId: 'cea_minted_sgd', offerCurrencies: ['SGD'] });
    await insertSeed({ externalId: 'ext_attached_sgd', title: 'Attached SGD', currency: 'SGD', attachedProductKey: 'minted_sgd', tool: '*' });
    // Priced ONLY by its attached seed: no offer row says anything.
    await insertCatalogProduct({ productKey: 'minted_sgd_seed_only', sourceSystem: 'catalog_enrichment_agent_v1', sourceProductId: 'cea_minted_sgd_seed_only' });
    await insertSeed({ externalId: 'ext_attached_sgd_only', title: 'Attached SGD only', currency: 'SGD', attachedProductKey: 'minted_sgd_seed_only', tool: '*' });
    await insertCatalogProduct({ productKey: 'minted_usd', sourceSystem: 'catalog_enrichment_agent_v1', sourceProductId: 'cea_minted_usd', offerCurrencies: ['USD'] });
    await insertSeed({ externalId: 'ext_attached_usd', title: 'Attached USD', currency: 'USD', attachedProductKey: 'minted_usd', tool: '*' });

    // --- Aurora local seed search + ingredient recall (creator_agents, unattached) ---
    for (const [suffix, currency] of [['usd', 'USD'], ['sgd', 'SGD'], ['null', null], ['blank', ' '], ['gbp', 'GBP']]) {
      await insertSeed({
        externalId: `ext_bha_${suffix}`,
        title: `Salicylic Acid Treatment Serum ${suffix}`,
        currency,
        seedData: {
          category: 'Serum',
          product_type: 'Treatment Serum',
          description: 'Salicylic acid treatment for clogged pores.',
          ingredient_ids: ['salicylic_acid'],
          reviewed_ingredient_ids: ['salicylic_acid'],
          derived: { recall: { ingredient_tokens: ['salicylic acid'], retrieval_title: `Salicylic Acid Treatment Serum ${suffix}`, category: 'Serum' } },
        },
      });
    }
    // Currency written only in the payload: the card builder reads it there, so the SQL must too.
    await insertSeed({
      externalId: 'ext_bha_payload_sgd',
      title: 'Salicylic Acid Treatment Serum payload sgd',
      currency: 'SGD',
      currencyInPayloadOnly: true,
      seedData: {
        category: 'Serum',
        ingredient_ids: ['salicylic_acid'],
        reviewed_ingredient_ids: ['salicylic_acid'],
        derived: { recall: { ingredient_tokens: ['salicylic acid'], retrieval_title: 'Salicylic Acid Treatment Serum payload sgd', category: 'Serum' } },
      },
    });
    // Prod materializes search_text (the trigram-gated superset the lean local search reads first).
    await db.query(`UPDATE external_product_seeds SET search_text = lower(coalesce(title, '') || ' ' || coalesce(seed_data::text, ''))`);
  }, 60000);

  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  beforeEach(() => {
    priorEnv = { ...process.env };
    statements = [];
    jest.resetModules();
    Object.assign(process.env, { DATABASE_URL: url, AURORA_BFF_USE_MOCK: 'true' });
    delete process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET;
    const run = async (sql, params) => {
      try {
        const result = await db.query(String(sql), params);
        statements.push({ sql: String(sql), rows: result.rows });
        return result;
      } catch (err) {
        // Recorded, not swallowed: ingredientSkuEvidence's runAppQuery turns an error into "no rows",
        // which would read here as a refusal.
        statements.push({ sql: String(sql), rows: [], error: err.message });
        throw err;
      }
    };
    jest.doMock('../../src/db', () => ({ query: run, queryWithStatementTimeout: run }));
  });

  afterEach(() => {
    process.env = priorEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
  });

  const seedRowsReturned = () =>
    [...new Set(statements.flatMap((s) => s.rows.map((r) => String(r.external_product_id || ''))).filter(Boolean))].sort();

  describe('similar recommendations: RecommendationEngine.fetchCatalogCandidates', () => {
    const fetchFor = async (servingCurrency) => {
      const { _internals } = require('../../src/services/RecommendationEngine');
      return _internals.fetchCatalogCandidates({
        categoryPathHint: 'beauty/skincare/serum',
        sourceMerchantHint: 'external_seed',
        limit: 20,
        ...(servingCurrency === 'omitted' ? {} : { servingCurrency }),
      });
    };
    // What the recall statement returned. A minted row has no eps_catalog price, so the card gate
    // drops it after SQL today; the statement must still refuse it, or it reaches the buyer the
    // day that row gains a price.
    const recalledKeys = () => statements.flatMap((s) => s.rows.map((r) => r.product_key)).sort();

    test('a US buyer (and a caller that names no currency) gets only products priced in USD', async () => {
      for (const servingCurrency of ['USD', 'omitted']) {
        statements = [];
        const products = await fetchFor(servingCurrency);
        // Priced by its mirrored seed, and minted priced by its attached seed -- the controls.
        expect(recalledKeys()).toEqual(['minted_usd', 'mirror_usd']);
        expect(products.map((p) => [p.product_key, p.currency])).toEqual([['mirror_usd', 'USD']]);
      }
    });

    test('an SG buyer gets the SGD product, which a US buyer never sees', async () => {
      await fetchFor('SGD');
      expect(recalledKeys()).toEqual(['minted_sgd', 'minted_sgd_seed_only']);
    });

    test('a market nothing is priced in gets nothing, without reading the database', async () => {
      const products = await fetchFor(null);
      expect(products).toEqual([]);
      expect(products.__catalogFetchStats.reason).toBe('no_serving_currency');
      expect(statements).toEqual([]);
    });
  });

  describe('similar recommendations, legacy seed lane: RecommendationEngine.fetchExternalCandidates', () => {
    // Off in prod (PDP_SIMILAR_CATALOG_ONLY defaults on); held to the same rule so turning it back
    // on cannot reopen the leak.
    test('every recall statement refuses another currency and a blank one', async () => {
      const { _internals } = require('../../src/services/RecommendationEngine');
      const fetchExternal = (servingCurrency) => _internals.fetchExternalCandidates({
        categoryHint: 'Serum',
        domainHints: ['brand.example'],
        limit: 40,
        ...(servingCurrency === 'omitted' ? {} : { servingCurrency }),
      });
      await fetchExternal('omitted');
      expect(statements.filter((s) => s.error)).toEqual([]);
      expect(statements.length).toBeGreaterThan(0);
      // Every unattached USD seed on the domain (the catalog-level conflict row is a USD SEED).
      expect(seedRowsReturned()).toEqual(['ext_bha_usd', 'ext_sim_conflict', 'ext_sim_usd']);
      statements = [];
      await fetchExternal('SGD');
      expect(seedRowsReturned()).toEqual(['ext_bha_payload_sgd', 'ext_bha_sgd']);
      statements = [];
      expect(await fetchExternal(null)).toEqual([]);
      expect(statements).toEqual([]);
    });
  });

  describe('Aurora local seed search: searchLocalExternalSeedProducts', () => {
    const ROLE = {
      role_id: 'acne_clogged_pore_treatment',
      rank: 1,
      preferred_step: 'treatment',
      query_terms: ['salicylic acid treatment'],
      fit_keywords: ['clogged', 'pore'],
      product_type_hypotheses: ['serum'],
    };
    const queryFn = (sql, params) => db.query(String(sql), params).then((result) => {
      statements.push({ sql: String(sql), rows: result.rows });
      return result;
    });
    const search = async (extra = {}) => {
      const { __internal } = require('../../src/auroraBff/routes');
      return __internal.searchLocalExternalSeedProducts({ query: 'salicylic acid treatment serum', limit: 12, queryFn, ...extra });
    };

    test('single-query shape: no buyer region is US, so only USD rows are read', async () => {
      await search();
      expect(statements.length).toBeGreaterThan(0);
      expect(seedRowsReturned()).toEqual(['ext_bha_usd']);
    });

    test('staged shape (a role): same rule, from the reco target context\'s buyer_region', async () => {
      await search({ role: ROLE, preferredStep: 'treatment', targetContext: { primary_role_id: ROLE.role_id } });
      expect(statements.length).toBeGreaterThan(0);
      expect(seedRowsReturned()).toEqual(['ext_bha_usd']);
      statements = [];
      await search({ role: ROLE, preferredStep: 'treatment', targetContext: { primary_role_id: ROLE.role_id, buyer_region: 'SG' } });
      expect(seedRowsReturned()).toEqual(['ext_bha_payload_sgd', 'ext_bha_sgd']);
    });

    test('query variants use the explicit buyer region; an unpriceable region reads nothing', async () => {
      const { __internal } = require('../../src/auroraBff/routes');
      await __internal.searchLocalExternalSeedProductsForQueryVariants({
        queries: ['salicylic acid treatment', 'salicylic acid serum'],
        limit: 12,
        role: ROLE,
        preferredStep: 'treatment',
        queryFn,
        buyerRegion: 'GB',
      });
      expect(seedRowsReturned()).toEqual(['ext_bha_gbp']);
      statements = [];
      const out = await search({ buyerRegion: 'ZZ' });
      expect(out).toEqual(expect.objectContaining({ ok: false, products: [], reason: 'buyer_region_unpriceable' }));
      expect(statements).toEqual([]);
    });
  });

  describe('Aurora photo modules: productRecV1 deterministic seed candidates', () => {
    test('both statements (structured ids, then text match) read only USD rows for a region-less buyer', async () => {
      const productRecV1 = require('../../src/auroraBff/productRecV1');
      await productRecV1.loadDeterministicExternalSeedCandidatesBatch({
        ingredientInputs: [{ ingredientId: 'salicylic_acid', ingredientName: 'Salicylic Acid' }],
        market: 'US',
      });
      expect(statements.length).toBeGreaterThan(0);
      expect(seedRowsReturned()).toEqual(['ext_bha_usd']);

      // No structured-id hit -> the text/wide statement runs, under the same rule.
      statements = [];
      await productRecV1.loadDeterministicExternalSeedCandidatesBatch({
        ingredientInputs: [{ ingredientId: 'no_such_ingredient_id', ingredientName: 'Salicylic Acid Treatment' }],
        market: 'SG', // the claims market reads SG as US; it never decides the currency
      });
      expect(statements.length).toBe(2);
      expect(seedRowsReturned()).toEqual(['ext_bha_usd']);
    });

    test('an SG buyer region gets SGD rows, from the payload currency too', async () => {
      const productRecV1 = require('../../src/auroraBff/productRecV1');
      await productRecV1.loadDeterministicExternalSeedCandidatesBatch({
        ingredientInputs: [{ ingredientId: 'salicylic_acid', ingredientName: 'Salicylic Acid' }],
        market: 'US',
        buyerRegion: 'SG',
      });
      expect(seedRowsReturned()).toEqual(['ext_bha_payload_sgd', 'ext_bha_sgd']);
    });
  });

  describe('Aurora ingredient recall: ingredientSkuEvidence seed statements', () => {
    test('pattern and identity statements refuse another currency and a blank one', async () => {
      const { _internals } = require('../../src/services/ingredientSkuEvidence');
      const byPattern = await _internals.fetchSeedRowsByPatterns({ patterns: ['%salicylic acid treatment serum%'], attachedState: 'unattached' });
      expect(byPattern.map((r) => r.external_product_id).sort()).toEqual(['ext_bha_usd']);

      const allIds = ['usd', 'sgd', 'null', 'blank', 'gbp'].map((s) => `ext_bha_${s}`);
      const urls = allIds.map((id) => `https://brand.example/products/${id}`);
      const byIdentity = await _internals.fetchSeedRowsByIdentity({ seedIds: allIds, urls });
      expect(byIdentity.map((r) => r.external_product_id).sort()).toEqual(['ext_bha_usd']);

      const sgd = await _internals.fetchSeedRowsByPatterns({
        patterns: ['%salicylic acid treatment serum%'],
        attachedState: 'unattached',
        servingCurrency: 'SGD',
      });
      expect(sgd.map((r) => r.external_product_id).sort()).toEqual(['ext_bha_payload_sgd', 'ext_bha_sgd']);
    });

    test('the brand-anchored unattached statement refuses another currency and a blank one', async () => {
      const { _internals } = require('../../src/services/ingredientSkuEvidence');
      const fetchBrand = (extra = {}) => _internals.fetchBrandAnchoredUnattachedSeedRowsByPatterns({
        queryText: 'Test Beauty salicylic acid treatment serum',
        patterns: ['%salicylic acid treatment serum%'],
        ...extra,
      });
      expect((await fetchBrand()).map((r) => r.external_product_id).sort()).toEqual(['ext_bha_usd']);
      expect((await fetchBrand({ servingCurrency: 'SGD' })).map((r) => r.external_product_id).sort())
        .toEqual(['ext_bha_payload_sgd', 'ext_bha_sgd']);
    });

    test('the profile recall threads the buyer region to every statement', async () => {
      jest.doMock('../../src/services/pciKbClient', () => ({ kbQuery: async () => ({ rows: [] }) }));
      const { recallIngredientProducts } = require('../../src/services/ingredientProductRecall');
      const recall = (buyerRegion) => recallIngredientProducts({
        ingredientId: 'salicylic_acid',
        query: 'salicylic acid treatment serum',
        buyerRegion,
      });
      const seedStatements = () => statements.filter((s) => /FROM external_product_seeds/.test(s.sql));
      // Control: with a priceable region the recall does read seeds -- and only the SGD ones for SG.
      await recall('SG');
      expect(seedStatements().length).toBeGreaterThan(0);
      expect(seedStatements().filter((s) => s.error)).toEqual([]);
      expect(seedRowsReturned().length).toBeGreaterThan(0);
      expect(seedRowsReturned().every((id) => ['ext_bha_sgd', 'ext_bha_payload_sgd'].includes(id))).toBe(true);
      statements = [];
      await recall('ZZ');
      expect(seedStatements()).toEqual([]);
    });
  });
});
