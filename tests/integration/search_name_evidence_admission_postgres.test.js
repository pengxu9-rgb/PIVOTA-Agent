const { Client } = require('pg');
const request = require('supertest');
const nock = require('nock');
const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../../src/findProductsMulti/queryUnderstanding');

// NAME-EVIDENCE ADMISSION, end to end through HTTP and a real PostgreSQL, through the beauty
// mainline route at the default page size (12). That route asks the canonical lane for 200 rows,
// so the candidate LIMIT is the CANDIDATE_LIMIT_MAX cap of 200 (row LIMIT 500) -- the fixture holds
// more in-category rows than that, so the LIMIT genuinely binds.
//
// The SQL is the only authority on admission (src/services/searchNameEvidence.js): it counts the
// catalog rows whose own name carries every query token, admits them only when there are at most
// MAX_CARRIERS, marks them, and raises its candidate LIMIT so they never evict a row the category
// recalls. Only real SQL execution can show that, so every property is measured here.

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const FLAG = 'SEARCH_NAME_EVIDENCE_ADMISSION';

suite('name-evidence admission with real PostgreSQL', () => {
  let db, schema, priorEnv, app, sqlCalls;
  beforeAll(async () => {
    db = new Client({ connectionString: url }); await db.connect();
    schema = `name_evidence_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    let sql;
    // Materialise exactly the columns the production statement references, with the flag ON so
    // the name-evidence arm's columns are included.
    process.env[FLAG] = 'on';
    await fetchCanonicalChainRows({ query: 'Silver Serum Gloss', categoryPathPrefix: 'beauty/skincare/treat/', categoryMode: 'category_browse',
      includeSkuOffers: true, marketId: 'US', searchQualityContract: buildSearchQualityContract({ rawQuery: 'Silver Serum Gloss' }),
      deps: { query: async (text) => { sql = text; return { rows: [] }; } } });
    delete process.env[FLAG];
    const tables = {};
    for (const match of sql.matchAll(/(?:FROM|JOIN)\s+(catalog_\w+|index_pipeline_state|external_product_seeds|merchant_stores)\s+(\w+)/g)) {
      const [, table, alias] = match; tables[table] ||= new Set();
      for (const ref of sql.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))) tables[table].add(ref[1]);
    }
    tables.index_pipeline_state.add('serving_eligible');
    for (const [table, cols] of Object.entries(tables)) {
      const definitions = [...cols].map((col) => {
        const type = /^(serving_eligible|index_eligible)$/.test(col) ? 'boolean'
          : /(_payload|_json|^seed_data$|^visible_attributes$|^visible_option_labels$|^ingredient_ids$)/.test(col) ? 'jsonb'
            : /^(list_price|merchant_effective_price|estimated_best_price|inventory_quantity|.*confidence)$/.test(col) ? 'numeric'
              : /(_at)$/.test(col) ? 'timestamptz' : 'text';
        return `${col} ${type}`;
      });
      await db.query(`CREATE TABLE ${table} (${definitions.join(',')})`);
    }
    await db.query("INSERT INTO catalog_merchants(merchant_id,merchant_name,status,primary_platform) VALUES ('retailer','Retailer','active','shopify')");
    const items = [
      // The reported shape: a lip gloss labelled only beauty/makeup, whose name says "Serum".
      ['jsm_gloss', 'LIP-PRESSION Silver Serum Gloss', 'JUNGSAEMMOOL', 'beauty/makeup', 'makeup'],
      // Accent- and middle-dot-folded spellings carry the same identity tokens.
      ['folded_accent', 'MÉTAL SERUM GLOSS Sheer', 'Other', 'beauty/makeup', 'makeup'],
      ['folded_dots', 'M·E·T·A·L Serum Gloss', 'Other', 'beauty/makeup', 'makeup'],
      // WHOLE WORDS: carries "metal" only as a substring of "metallic" -- passes the LIKE prefilter,
      // must fail the regex. Review of #2230: an any-token regex survived every test.
      ['metallic', 'Metallic Serum Gloss', 'Other', 'beauty/makeup', 'makeup'],
      // Shares every query word only in its DESCRIPTION -- never own-name evidence.
      ['eyeliner', 'Precision Eyeliner', 'Other', 'beauty/makeup', 'Eyeliner'],
      // THE THRESHOLD. 10 rows carry "violet cloud serum" (a name); 11 carry "velvet cloud serum"
      // (too common to be a name). None is in the serum category.
      ...Array.from({ length: 10 }, (_, i) => [`violet_${i}`, `Violet Cloud Serum Tint ${i}`, 'Other', 'beauty/makeup', 'makeup']),
      ...Array.from({ length: 11 }, (_, i) => [`velvet_${i}`, `Velvet Cloud Serum Tint ${i}`, 'Other', 'beauty/makeup', 'makeup']),
      // DISPLACEMENT: a name ("glacier silk serum") carried by two out-of-category rows, while the
      // query's guessed category (serum) holds far more rows than the candidate LIMIT.
      ['glacier_a', 'Glacier Silk Serum Lip Gloss A', 'Other', 'beauty/makeup', 'makeup'],
      ['glacier_b', 'Glacier Silk Serum Lip Gloss B', 'Other', 'beauty/makeup', 'makeup'],
      // A multi-product SET carrying the same name: never admitted unless the query asks for a set.
      ['glacier_set', 'Glacier Silk Serum Lip Duo', 'Other', 'beauty/makeup', 'makeup'],
      // MORE OF THE SAME PRODUCT is not the product either. Review of #2230 v3 served a twin pack at
      // #2: the set words alone missed these three spellings.
      ['glacier_twin', 'Glacier Silk Serum Twin Pack', 'Other', 'beauty/makeup', 'makeup'],
      ['glacier_combo', 'Glacier Silk Serum Combo', 'Other', 'beauty/makeup', 'makeup'],
      ['glacier_x2', 'Glacier Silk Serum x2', 'Other', 'beauty/makeup', 'makeup'],
      // ...and two rows whose names merely CONTAIN those letters, one on each side: dropping the
      // pattern's leading boundary makes "Sunset" a set, dropping its trailing boundary makes
      // "Setting" one. Both survived every test.
      ['glacier_sunset', 'Sunset Glacier Silk Serum', 'Other', 'beauty/makeup', 'makeup'],
      ['glacier_setting', 'Glacier Silk Serum Setting Mist', 'Other', 'beauty/makeup', 'makeup'],
      // A SECOND name family, for the exclusion words the glacier family does not spell and for
      // the beauty/sets tree. Kept separate so the glacier carrier count stays under MAX_CARRIERS.
      // Review of #2236: each of these survived as a mutant -- the words were asserted only in a
      // comment, and the sets-tree clause (a #2230 mechanism) had no row at all.
      ['velour_plain', 'Velour Cloud Serum Tint', 'Other', 'beauty/makeup', 'makeup'],
      ['velour_count', 'Velour Cloud Serum 3 Count', 'Other', 'beauty/makeup', 'makeup'],
      ['velour_ct', 'Velour Cloud Serum 2 ct', 'Other', 'beauty/makeup', 'makeup'],
      ['velour_double', 'Velour Cloud Serum Double Pack', 'Other', 'beauty/makeup', 'makeup'],
      ['velour_multi', 'Velour Cloud Serum Multipack', 'Other', 'beauty/makeup', 'makeup'],
      // A count of ONE is still read as a pack spelling. Conservative on purpose: the row is only
      // held out of an admission it would otherwise get, and nothing else about it changes.
      ['velour_one', 'Velour Cloud Serum 1 Count', 'Other', 'beauty/makeup', 'makeup'],
      // Named like one product, but filed in the sets tree: excluded by category, not by name.
      ['velour_tree', 'Velour Cloud Serum Deluxe', 'Other', 'beauty/sets/gift', 'makeup'],
      // ...and one IN-category row carrying the same name, updated EARLIEST so flag-off order puts it
      // last. It must not be marked or boosted: only rows the category rejected are admitted.
      ['glacier_in', 'Glacier Silk Serum Refill', 'Other', 'beauty/skincare/treat/serum', 'Serum', "now() - interval '30 days'"],
      // ...and in-category rows that only carry "serum", updated LATER, so flag-off order puts them first.
      ...Array.from({ length: 30 }, (_, i) => [`barrier_${i}`, `Barrier Repair Serum ${String(i).padStart(3, '0')}`, 'Brand', 'beauty/skincare/treat/serum', 'Serum', "now() + interval '1 hour'"]),
      // LIMIT pressure: more in-category rows than the 200-row candidate LIMIT.
      ...Array.from({ length: 250 }, (_, i) => [`serum_${i}`, `Hydrating Serum ${String(i).padStart(3, '0')}`, 'Brand', 'beauty/skincare/treat/serum', 'Serum']),
    ];
    for (const [id, title, brand, category, type, updatedAt = 'now()'] of items) {
      const sig = `sig_${Buffer.from(id).toString('hex').padEnd(32, '0').slice(0, 32)}`;
      const payload = id === 'eyeliner' ? { description: 'Pairs with LIP-PRESSION Silver Serum Gloss' } : {};
      await db.query(`INSERT INTO catalog_products(product_key,merchant_id,platform,source_product_id,title,brand,product_type,
       category_path,content_key,pivota_signature_id,pivota_canonical_url,canonical_url,image_url,product_payload,updated_at)
       VALUES ($1,'retailer','shopify',$1,$2,$3,$4,$5,$1,$6,$7,$8,$9,$10,${updatedAt})`,
      [id, title, brand, type, category, sig, `https://agent.pivota.cc/products/${sig}`, `https://retailer.example/products/${id}`,
        `https://cdn.example/${id}.jpg`, payload]);
      await db.query('INSERT INTO index_pipeline_state(content_key,serving_eligible) VALUES ($1,true)', [id]);
      await db.query('INSERT INTO catalog_skus(sku_key,product_key,source_variant_id) VALUES ($1,$1,$2)', [id, `variant_${id}`]);
      await db.query("INSERT INTO catalog_offers(offer_id,sku_key,merchant_effective_price,currency,availability) VALUES ($1,$1,20,'USD','in_stock')", [id]);
    }
  });
  afterAll(async () => { if (db) { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); } });

  const boot = (flag, extraEnv = {}) => {
    priorEnv = { ...process.env }; jest.resetModules(); sqlCalls = [];
    Object.assign(process.env, { DATABASE_URL: url, PIVOTA_API_BASE: 'http://upstream-disabled.test', PIVOTA_API_KEY: 'test', API_MODE: 'REAL',
      INDEX_ELIGIBLE_RECALL: 'false', PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true', SEARCH_QUALITY_CONTRACT_V1_ENABLED: 'true',
      SEARCH_QUALITY_CONTRACT_V1_MODE: 'enforce', PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: 'false',
      CANONICAL_CATALOG_RECALL_DOC_MATCH: 'off', CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'off',
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false', ...extraEnv });
    if (flag) process.env[FLAG] = flag; else delete process.env[FLAG];
    nock.disableNetConnect(); nock.enableNetConnect((host) => host.includes('127.0.0.1'));
    jest.doMock('../../src/db', () => ({ query: async (sql, params) => {
      if (sql.includes('candidate_products AS') && sql.includes('ips.serving_eligible')) {
        sqlCalls.push({ sql, params }); return db.query(sql, params);
      }
      if (sql.includes('ips.index_eligible')) throw new Error('citation rescue must not execute');
      return { rows: [] };
    } }));
    app = require('../../src/server');
  };
  afterEach(() => { process.env = priorEnv; jest.dontMock('../../src/db'); jest.resetModules(); nock.cleanAll(); nock.enableNetConnect(); });

  // limit 12 is the production default page.
  const search = (query, limit = 12) => request(app).post('/agent/shop/v1/invoke').send({ operation: 'find_products_multi',
    payload: { search: { query, domain: 'beauty', market: 'US', limit } }, metadata: { source: 'public_api', market: 'US' } });
  const keys = (res) => (res.body.products || []).map((p) => p.product_key || p.product_ref?.product_id || p.id);
  const recalled = async () => (await db.query(sqlCalls.at(-1).sql, sqlCalls.at(-1).params)).rows;

  test('flag OFF: the named product is not served -- the reported defect, reproduced', async () => {
    boot(null);
    const res = await search('Silver Serum Gloss');
    expect(res.status).toBe(200);
    expect(keys(res)).not.toContain('jsm_gloss');
    expect(sqlCalls.at(-1).sql).not.toContain('name_evidence_carriers');
    // Flag off, the response shape is unchanged: no new tier-count key.
    expect(res.body.metadata.search_quality_tier_counts).not.toHaveProperty('category_waived_by_name_evidence_count');
  });

  test('flag ON: recalled past the category rows at the prod LIMIT, served, marked, and counted', async () => {
    boot('on');
    const res = await search('Silver Serum Gloss');
    expect(res.status).toBe(200);
    expect(keys(res)).toContain('jsm_gloss');
    const rows = await recalled();
    const admitted = rows.filter((r) => r.name_evidence_admitted === true).map((r) => r.product_key).sort();
    // Folded spellings are admitted; the description-only eyeliner never is.
    expect(admitted).toEqual(['folded_accent', 'folded_dots', 'jsm_gloss']);
    expect(res.body.metadata.search_quality_tier_counts.category_waived_by_name_evidence_count).toBe(3);
    // The admission mark is internal: it must not appear on any public product object.
    expect(JSON.stringify(res.body.products)).not.toContain('name_evidence_admitted');
  });

  // Review of #2230 v3: the folded spellings were admitted and waived but NOT served -- the ranker's
  // lexical arms compared unfolded text, so "MÉTAL SERUM GLOSS Sheer" scored below "Barrier Repair
  // Serum 000" and the 12-row page was jsm_gloss + serums. Pinned on the served page, with the
  // token-relevance tiering both off and on (it is secret-configured in prod).
  for (const tokenRank of ['false', 'true']) {
    test(`flag ON: folded spellings are SERVED, not only admitted (token relevance rank ${tokenRank})`, async () => {
      boot('on', { PIVOT_BEAUTY_TOKEN_RELEVANCE_RANK_ENABLED: tokenRank });
      const res = await search('Silver Serum Gloss');
      expect(res.status).toBe(200);
      const served = keys(res);
      expect(served.slice(0, 3).sort()).toEqual(['folded_accent', 'folded_dots', 'jsm_gloss']);
    });
  }

  test('THE THRESHOLD: 10 carriers are a name and are admitted; 11 are a browse and none is', async () => {
    boot('on');
    await search('Violet Cloud Serum');
    const violet = (await recalled()).filter((r) => r.name_evidence_admitted === true).map((r) => r.product_key);
    expect(violet).toHaveLength(10);
    await search('Velvet Cloud Serum');
    const velvet = (await recalled()).filter((r) => r.name_evidence_admitted === true);
    expect(velvet).toHaveLength(0);
    expect((await recalled()).some((r) => String(r.product_key).startsWith('velvet_'))).toBe(false);
  });

  test('a generic query is not a name: no admission when many rows carry it, even in-category', async () => {
    boot('on');
    await search('hydrating serum');
    expect((await recalled()).filter((r) => r.name_evidence_admitted === true)).toHaveLength(0);
  });

  test('a multi-product set is not admitted on name evidence -- unless the query asks for a set', async () => {
    boot('on');
    await search('Glacier Silk Serum');
    const plain = (await recalled()).filter((r) => r.name_evidence_admitted === true).map((r) => r.product_key).sort();
    // The duo, the twin pack, the combo and the x2 are all excluded; "Sunset" only contains "set".
    expect(plain).toEqual(['glacier_a', 'glacier_b', 'glacier_setting', 'glacier_sunset']);
    await search('Glacier Silk Serum Duo');
    const asked = (await recalled()).filter((r) => r.name_evidence_admitted === true).map((r) => r.product_key);
    expect(asked).toEqual(['glacier_set']);
  });

  test('every multi-product spelling is excluded, and so is the beauty/sets tree', async () => {
    boot('on');
    await search('Velour Cloud Serum');
    const admitted = (await recalled()).filter((r) => r.name_evidence_admitted === true).map((r) => r.product_key).sort();
    expect(admitted).toEqual(['velour_plain']);
  });

  test('a query that asks for a pack gets the pack: the exclusion reads the query the same way', async () => {
    boot('on');
    for (const [query, expected] of [
      ['Glacier Silk Serum Twin Pack', ['glacier_twin']],
      ['Glacier Silk Serum Combo', ['glacier_combo']],
      // NOT "Glacier Silk Serum x2": that query recalls nothing at all, admitted or not -- the
      // recall text predicate normalises the query to "x 2" and no row's text matches. A pack
      // spelled that way is findable only by the words around it.
    ]) {
      await search(query);
      expect({ query, admitted: (await recalled()).filter((r) => r.name_evidence_admitted === true).map((r) => r.product_key) })
        .toEqual({ query, admitted: expected });
    }
  });

  test('NO DISPLACEMENT: every row the category recalls off is still recalled on, in the same order', async () => {
    // Review of #2230: a +95 inside the SAME candidate LIMIT evicted the lowest in-category rows,
    // and rows that were served disappeared. Admitted rows now take extra slots.
    boot(null);
    const resOff = await search('Glacier Silk Serum');
    const off = (await recalled()).map((r) => r.product_key);
    // The LIMIT binds: flag off returns exactly the 200-candidate cap, flag on the cap plus the
    // MAX_CARRIERS allowance (candidate 200 -> 210, row 500 -> 510).
    expect(off.length).toBe(200);
    const offParams = sqlCalls.at(-1).params;
    expect([offParams[2], offParams[3]]).toEqual([200, 500]);
    boot('on');
    const resOn = await search('Glacier Silk Serum');
    expect([sqlCalls.at(-1).params[2], sqlCalls.at(-1).params[3]]).toEqual([210, 510]);
    const on = (await recalled()).map((r) => r.product_key);
    const onRows = await recalled();
    expect(onRows.filter((r) => r.name_evidence_admitted === true).map((r) => r.product_key).sort()).toEqual(['glacier_a', 'glacier_b', 'glacier_setting', 'glacier_sunset']);
    const admittedKeys = new Set(['glacier_a', 'glacier_b', 'glacier_setting', 'glacier_sunset']);
    // Off is a PREFIX of on: nothing removed, nothing reordered -- including the in-category
    // carrier, wherever flag-off order put it. The unused extra slots may add in-category rows at the tail.
    expect(on.filter((k) => !admittedKeys.has(k)).slice(0, off.length)).toEqual(off);
    // On the served page the admitted rows lead and the rest keep flag-off order; on a full page the
    // last flag-off rows are pushed to the next page, not removed.
    const offServed = keys(resOff);
    const onServed = keys(resOn);
    expect(onServed.filter((k) => admittedKeys.has(k)).sort()).toEqual(['glacier_a', 'glacier_b', 'glacier_setting', 'glacier_sunset']);
    const keptServed = onServed.filter((k) => !admittedKeys.has(k));
    expect(keptServed).toEqual(offServed.slice(0, keptServed.length));
  });
});
