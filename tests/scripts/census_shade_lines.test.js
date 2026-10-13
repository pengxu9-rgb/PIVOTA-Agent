// scripts/census-shade-lines.js: the read-only census computes proposed lines from STORED rows in
// memory. Invented store and brand.

describe('census-shade-lines', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test' };
    delete process.env.SHADE_LINE_RULE_V2_ENABLED;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  const storedRow = (code, title, productLineId, reviewFamilyId = `rf_${code}`) => ({
    source_listing_ref: `merch_obs_shopone:golden:${code}`,
    merchant_id: 'merch_obs_shopone',
    product_id: `golden:${code}`,
    source_kind: 'external_seed',
    product_line_id: productLineId,
    review_family_id: reviewFamilyId,
    identity_status: 'approved',
    matched_by_rule: 'official_url_route',
    source_payload: {
      title,
      brand: 'BRANDA',
      product_type: 'external',
      price: { amount: 30, currency: 'SGD' },
      currency: 'SGD',
      canonical_url: `https://shop-one.example/products/${code}`,
    },
    catalog_product_type: 'nail-polish',
    catalog_category_path: null,
  });

  test('stored per-page lines come out as the re-key backlog, with both ids; nothing else is touched', () => {
    const { censusShadeLines, CENSUS_SQL } = require('../../scripts/census-shade-lines');
    const result = censusShadeLines([
      storedRow('k2207', 'BRANDA AURA K2207 SAFFRON', 'pl_page_k2207'),
      storedRow('t415', 'BRANDA AURA T415 MOSS', 'pl_page_t415'),
      storedRow('p380', 'BRANDA AURA P380 HARBOR', 'pl_page_p380'),
      storedRow('kit', 'BRANDA AURA 0101-0105 GIFT SET', 'pl_page_kit'),
    ]);
    expect(result.lines).toHaveLength(1);
    const [line] = result.lines;
    expect(line.product_line_id).toMatch(/^pl_[0-9a-f]{24}$/);
    expect(line.review_family_id).toMatch(/^rf_[0-9a-f]{24}$/);
    expect(line.members.map((member) => [member.stored_product_line_id, member.status])).toEqual([
      ['pl_page_k2207', 'rekey'],
      ['pl_page_t415', 'rekey'],
      ['pl_page_p380', 'rekey'],
    ]);
    expect(result.rekey_rows).toBe(3);
    // The rule flag is forced on only inside the census, and restored.
    expect(process.env.SHADE_LINE_RULE_V2_ENABLED).toBeUndefined();
    // Read-only by construction: one SELECT, no write statement.
    expect(CENSUS_SQL).toMatch(/^\s*SELECT/);
    expect(CENSUS_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  test('rows already in their proposed line are in_line, not re-keyed', () => {
    const { censusShadeLines } = require('../../scripts/census-shade-lines');
    const first = censusShadeLines([
      storedRow('k2207', 'BRANDA AURA K2207 SAFFRON', 'pl_page_k2207'),
      storedRow('t415', 'BRANDA AURA T415 MOSS', 'pl_page_t415'),
    ]);
    const lineId = first.lines[0].product_line_id;
    const again = censusShadeLines([
      storedRow('k2207', 'BRANDA AURA K2207 SAFFRON', lineId),
      storedRow('t415', 'BRANDA AURA T415 MOSS', lineId),
    ]);
    expect(again.lines[0].members.map((member) => member.status)).toEqual(['in_line', 'in_line']);
    expect(again.rekey_rows).toBe(0);
  });

  test('a v2 shade adopts the STORED line of its v1 siblings (not a rebuilt key)', () => {
    const { censusShadeLines } = require('../../scripts/census-shade-lines');
    const makeup = (code, title, lineId) => ({
      ...storedRow(code, title, lineId),
      source_payload: { ...storedRow(code, title, lineId).source_payload, brand: 'BRANDF', price: { amount: 22, currency: 'USD' }, currency: 'USD' },
      catalog_product_type: null,
    });
    const result = censusShadeLines([
      makeup('l471', 'BRANDF Lipstick 471', 'pl_v1_live_line'),
      makeup('l472', 'BRANDF Lipstick 472', 'pl_v1_live_line'),
      makeup('l473', 'BRANDF Lipstick 473 Blue', 'pl_page_l473'),
    ]);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].product_line_id).toBe('pl_v1_live_line');
    expect(result.lines[0].members).toEqual([
      expect.objectContaining({ stored_product_line_id: 'pl_page_l473', status: 'rekey' }),
    ]);
  });

  test('a v1 line another seller also holds is not adopted in the census either: the store line is minted', () => {
    const { censusShadeLines, LINE_STORES_SQL } = require('../../scripts/census-shade-lines');
    const makeup = (code, title, lineId) => ({
      ...storedRow(code, title, lineId),
      source_payload: { ...storedRow(code, title, lineId).source_payload, brand: 'BRANDF', price: { amount: 22, currency: 'USD' }, currency: 'USD' },
      catalog_product_type: null,
    });
    const rows = [
      makeup('l471', 'BRANDF Lipstick 471', 'pl_v1_live_line'),
      makeup('l472', 'BRANDF Lipstick 472', 'pl_v1_live_line'),
      makeup('l473', 'BRANDF Lipstick 473 Blue', 'pl_page_l473'),
      makeup('l474', 'BRANDF Lipstick 474 Pink', 'pl_page_l474'),
    ];
    const result = censusShadeLines(rows, { lineStores: new Map([['pl_v1_live_line', ['merch_obs_reseller@reseller.example']]]) });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].product_line_id).not.toBe('pl_v1_live_line');
    expect(result.lines[0].members.map((member) => member.status)).toEqual(['rekey', 'rekey']);
    expect(result.stats.adoption_not_store_scoped).toBe(1);
    expect(LINE_STORES_SQL).toMatch(/^\s*SELECT/);
    expect(LINE_STORES_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  describe('throttled read (2-vCPU primary)', () => {
    const fakeDb = (pages, storeRows = []) => {
      const statements = [];
      let page = 0;
      const withClientFn = async (fn) =>
        fn({
          query: async (sql, params) => {
            statements.push({ sql: String(sql).replace(/\s+/g, ' ').trim().slice(0, 60), params });
            if (/FROM pdp_identity_listing pil/.test(sql) && /source_listing_ref > \$2/.test(sql)) {
              const rows = pages[page] || [];
              page += 1;
              return { rows };
            }
            if (/SELECT DISTINCT product_line_id, merchant_id, official_domain/.test(sql)) return { rows: storeRows };
            return { rows: [] };
          },
        });
      return { statements, withClientFn };
    };

    test('keyset batches, each READ ONLY under a LOCAL statement_timeout, with a sleep between batches', async () => {
      const { readCensusInputsThrottled } = require('../../scripts/census-shade-lines');
      const rows = (from, n) => Array.from({ length: n }, (_, i) => storedRow(`r${from + i}`, `BRANDA AURA K${2200 + from + i} SAFFRON`, `pl_page_${from + i}`));
      const pages = [rows(0, 2), rows(2, 2), rows(4, 1)];
      const { statements, withClientFn } = fakeDb(pages);
      const sleepFn = jest.fn(async () => {});
      const result = await readCensusInputsThrottled({
        withClientFn,
        merchantIds: ['merch_obs_shopone'],
        limit: 100,
        batchSize: 2,
        sleepMs: 300,
        statementTimeoutMs: 9000,
        sleepFn,
      });
      expect(result.rows).toHaveLength(5);
      expect(result.batches).toBe(3);
      const reads = statements.filter((statement) => /source_listing_ref/.test(JSON.stringify(statement.params || [])) || statement.params?.length === 3);
      expect(statements.filter((statement) => statement.sql === 'BEGIN READ ONLY')).toHaveLength(3);
      expect(statements.filter((statement) => /set_config\('statement_timeout'/.test(statement.sql)).map((statement) => statement.params)).toEqual([['9000'], ['9000'], ['9000']]);
      const batchParams = statements.filter((statement) => statement.params && statement.params.length === 3).map((statement) => statement.params);
      expect(batchParams).toEqual([
        [['merch_obs_shopone'], '', 2],
        [['merch_obs_shopone'], 'merch_obs_shopone:golden:r1', 2],
        [['merch_obs_shopone'], 'merch_obs_shopone:golden:r3', 2],
      ]);
      expect(reads.length).toBeGreaterThan(0);
      expect(statements.some((statement) => /\b(INSERT|UPDATE|DELETE)\b/i.test(statement.sql))).toBe(false);
      expect(sleepFn).toHaveBeenCalledWith(300);
    });

    test('the CPU gate is awaited before every batch, and the census waits while it says no', async () => {
      const { readCensusInputsThrottled } = require('../../scripts/census-shade-lines');
      const { withClientFn } = fakeDb([[storedRow('a', 'BRANDA AURA K2207 SAFFRON', 'pl_a')]]);
      const answers = [false, false, true];
      const cpuGate = jest.fn(async () => answers.shift() ?? true);
      const sleepFn = jest.fn(async () => {});
      await readCensusInputsThrottled({ withClientFn, merchantIds: ['m'], limit: 10, batchSize: 5, cpuGate, sleepFn });
      expect(cpuGate).toHaveBeenCalledTimes(3);
      expect(sleepFn.mock.calls.filter(([ms]) => ms === 5000)).toHaveLength(2);
    });

    test('a gate that never opens gives up instead of reading', async () => {
      const { readCensusInputsThrottled } = require('../../scripts/census-shade-lines');
      const { statements, withClientFn } = fakeDb([[]]);
      await expect(
        readCensusInputsThrottled({ withClientFn, merchantIds: ['m'], cpuGate: async () => false, sleepFn: async () => {} }),
      ).rejects.toThrow('SHADE_LINE_CENSUS_CPU_GATE_TIMEOUT');
      expect(statements).toHaveLength(0);
    });

    test('the stores of adoptable v1 lines are read the same way', async () => {
      const { readCensusInputsThrottled } = require('../../scripts/census-shade-lines');
      const makeup = (code, title, lineId) => ({
        ...storedRow(code, title, lineId),
        source_payload: { ...storedRow(code, title, lineId).source_payload, brand: 'BRANDF', price: { amount: 22, currency: 'USD' }, currency: 'USD' },
        catalog_product_type: null,
      });
      const { statements, withClientFn } = fakeDb(
        [[makeup('l471', 'BRANDF Lipstick 471', 'pl_v1_live_line'), makeup('l473', 'BRANDF Lipstick 473 Blue', 'pl_page_l473')]],
        [{ product_line_id: 'pl_v1_live_line', merchant_id: 'merch_obs_reseller', official_domain: 'reseller.example' }],
      );
      const result = await readCensusInputsThrottled({ withClientFn, merchantIds: ['merch_obs_shopone'], limit: 10, batchSize: 5, sleepFn: async () => {} });
      expect(result.lineStores.get('pl_v1_live_line')).toEqual(['merch_obs_reseller@reseller.example']);
      expect(statements.filter((statement) => statement.sql === 'BEGIN READ ONLY')).toHaveLength(2);
    });
  });
});
