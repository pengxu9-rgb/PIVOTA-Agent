// Primary-route quality gates; no citation append or success-recovery helpers.
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');
let gate, availability, priceContract, applyBeautyContract;
beforeAll(() => {
  jest.doMock('../src/auroraBff/routes', () => ({ mountAuroraBffRoutes: () => {}, __internal: {} }));
  const d = require('../src/server')._debug;
  gate = d.getSearchQualityContractHardConstraintResult;
  availability = d.enforceFindProductsMultiAvailabilityContract;
  priceContract = d.enforceFindProductsMultiPriceContract;
  applyBeautyContract = d.applyPivotBeautyContractToInvokeSearchResponse;
});
const row = (id, title, brand = 'Stila Cosmetics', price = 15) => ({ product_id: id, title, brand, price, currency: 'USD', category_path: ['beauty', 'makeup'] });
test('exact Stila line accepts its own lipstick and rejects competitors and eyeliners', () => {
  const q = 'Stila Stay All Day Liquid Lipstick', c = buildSearchQualityContract({ rawQuery: q });
  expect(gate(row('lip', 'Mini Stay All Day Liquid Lipstick'), c, q).eligible).toBe(true);
  expect(gate(row('eye', 'Stay All Day Waterproof Liquid Eye Liner'), c, q).eligible).toBe(false);
  expect(gate(row('other', 'Stay All Day Liquid Lipstick', 'Fenty Beauty'), c, q)).toMatchObject({
    eligible: false, reasons: expect.arrayContaining(['brand_mismatch']),
  });
});
test('ancestor category requires own title/type, not cross-sell description', () => {
  const c = buildSearchQualityContract({ rawQuery: 'MAC lipstick' });
  expect(gate(row('lip', 'Amplified Lipstick', 'MAC Cosmetics'), c, c.effective_query).eligible).toBe(true);
  expect(gate({ ...row('brush', 'Foundation Brush', 'MAC Cosmetics'), description: 'Pair with our lipstick' }, c, c.effective_query).eligible).toBe(false);
});
test('apostrophe alias matches catalog brand at final gate', () => {
  const c = buildSearchQualityContract({ rawQuery: "A'PIEU Honey & Milk Lip Oil" });
  expect(gate(row('oil', 'Honey & Milk Lip Oil', 'APIEU'), c, c.effective_query).eligible).toBe(true);
  expect(gate(row('mask', 'Honey & Milk Lip Mask', 'APIEU'), c, c.effective_query).eligible).toBe(false);
});
test('primary price gate rejects missing prices without promoting a failed response', () => {
  const body = { status: 'failed', success: false, total: 2,
    products: [row('priced', 'Matte Lipstick'), row('unpriced', 'Matte Lipstick', 'Stila', null)], metadata: {} };
  priceContract(body);
  expect(body.products.map(p => p.product_id)).toEqual(['priced']);
  expect(body.metadata.price_contract.dropped_unpriced).toBe(1);
  expect(body).toMatchObject({ status: 'failed', success: false });
});
test('exact line matches the actual middle-dot branded product spelling', () => {
  const c = buildSearchQualityContract({ rawQuery: 'M·A·C MACximal Silky Matte Lipstick' });
  expect(gate(row('macximal', 'M·A·Cximal Silky Matte Lipstick', 'MAC Cosmetics'), c, c.effective_query).eligible).toBe(true);
});
test('availability gate rejects nontransactional citations without recovering failure', () => {
  const body = { status: 'failed', success: false, total: 1, metadata: { failure_class: 'beauty_mainline_empty' },
    products: [{ ...row('citation', 'Amplified Lipstick', 'MAC'), source: 'canonical_citation', catalog_track: 'citation', buyable: false }] };
  availability(body);
  expect(body).toMatchObject({ status: 'failed', success: false, products: [], total: 0 });
  expect(body.metadata.failure_class).toBe('beauty_mainline_empty');
  expect(body.metadata.availability_contract.dropped_known_unavailable).toBe(1);
});

test.each(['price', 'availability'])('final beauty contract reports empty after the %s gate removes the last primary card', reason => {
  const req = { body: { operation: 'find_products_multi', metadata: { source: 'shopping_agent' },
    payload: { search: { query: 'MAC lipstick', domain: 'beauty' } } } };
  const candidate = row('primary', 'MAC Matte Lipstick', 'MAC Cosmetics');
  candidate.source = 'canonical_chain';
  if (reason === 'price') candidate.price = null;
  else candidate.serving_eligible = false;
  let body = { status: 'success', success: true, products: [candidate], total: 1, page_size: 1,
    metadata: { query_source: 'agent_products_beauty_external_seed_mainline',
      canonical_returned_count: 1, external_seed_returned_count: 0,
      route_health: { primary_path_used: 'beauty_external_seed_mainline', final_returned_count: 1 },
      search_decision: { final_decision: 'products_returned' } } };
  const contract = value => applyBeautyContract({ body: value, req, operation: 'find_products_multi' });
  body = contract(body); // Same initial contract pass as the HTTP send wrapper.
  expect(body.status).toBe('success');
  body = availability(priceContract(body));
  body = contract(body); // Final send boundary must recompute after filters.
  expect(body).toMatchObject({ status: 'failed', success: false, products: [], total: 0, page_size: 0 });
  expect(body.metadata).toMatchObject({ status: 'failed', failure_class: 'beauty_mainline_empty',
    canonical_returned_count: 0, external_seed_returned_count: 0,
    route_health: { final_returned_count: 0, fallback_triggered: false, fallback_adopted: false },
    search_decision: { final_decision: 'beauty_mainline_empty' } });
});

test.each([
  ['MAC foundation', 'Foundation Brush'],
  ['MAC foundation', 'Foundation Brushes'],
  ['MAC bronzer', 'Bronzer Brush'],
  ['MAC eyeliner', 'Eyeliner Sharpener'],
  ['MAC lipstick', 'Lipstick Applicator'],
  ['MAC lipstick', 'Lipstick Applicators'],
])('requested-category accessory cannot use a shallow ancestor: %s / %s', (q, title) => {
  const c = buildSearchQualityContract({ rawQuery: q });
  expect(gate(row('tool', title, 'MAC Cosmetics'), c, q)).toMatchObject({
    eligible: false, reasons: expect.arrayContaining(['accessory_for_product_query']),
  });
});
test.each([
  ['MAC foundation', 'Studio Fix Fluid Foundation'],
  ['MAC bronzer', 'Butter Bronzer with Mirror'],
  ['MAC foundation brush', 'Foundation Brush'],
])('own product and explicitly requested tool remain eligible: %s / %s', (q, title) => {
  const c = buildSearchQualityContract({ rawQuery: q });
  expect(gate(row('match', title, 'MAC Cosmetics'), c, q).eligible).toBe(true);
});
test.each([
  ['Stila Stay All Day Liquid Lipstick', 'Plumping Lipstick', 'Stila Cosmetics', 'Pair with Stay All Day Liquid Lipstick'],
  ['MAC MACximal Silky Matte Lipstick', 'Frost Lipstick', 'MAC Cosmetics', 'Try our MACximal Silky Matte Lipstick too'],
])('exact product line cannot be proved by cross-sell copy: %s', (q, title, brand, description) => {
  const c = buildSearchQualityContract({ rawQuery: q });
  const wrong = { ...row('wrong-line', title, brand), description };
  expect(gate(wrong, c, q)).toMatchObject({ eligible: false, reasons: expect.arrayContaining(['exact_product_mismatch']) });
});
test('trusted canonical title can identify an exact line when the display title is shortened', () => {
  const q = 'Stila Stay All Day Liquid Lipstick', c = buildSearchQualityContract({rawQuery:q});
  expect(gate({ ...row('right-line', 'Mini Lipstick'), canonical_title: 'Mini Stay All Day Liquid Lipstick' }, c, q).eligible).toBe(true);
});
