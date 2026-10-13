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
});
