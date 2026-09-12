const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');
let append, gate, finalize, availability;
beforeAll(() => {
  jest.doMock('../src/auroraBff/routes', () => ({ mountAuroraBffRoutes: () => {}, __internal: {} }));
  const d = require('../src/server')._debug;
  append = d.appendCitableSupplementItems; gate = d.getSearchQualityContractHardConstraintResult;
  finalize = d.finalizeCitableSupplementResponse; availability = d.enforceFindProductsMultiAvailabilityContract;
});
const row = (id, title, brand = 'Stila Cosmetics', price = 15) => ({ product_id: id, title, brand, price, currency: 'USD', source: 'canonical_citation', catalog_track: 'citation', category_path: ['beauty', 'makeup'] });
const response = q => ({ products: [], page: 1, total: 0, status: 'success', metadata: { search_quality_contract: buildSearchQualityContract({ rawQuery: q }) } });
test('exact Stila line rejects competitors and same-brand eyeliners after merge', () => {
  const q = 'Stila Stay All Day Liquid Lipstick', body = response(q);
  append(body, [row('lip', 'Mini Stay All Day Liquid Lipstick'), row('eye', 'Stay All Day Waterproof Liquid Eye Liner'), row('other', 'Stay All Day Liquid Lipstick', 'Fenty Beauty')], { queryText: q });
  expect(body.products.map(p => p.product_id)).toEqual(['lip']);
  expect(body.metadata.citable_supplement_rejected_count).toBe(2);
  expect(body.total).toBeGreaterThanOrEqual(body.products.length);
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
test('late citations obey price ceiling', () => {
  const q = 'Stila lipstick', body = response(q);
  append(body, [row('cheap', 'Matte Lipstick', 'Stila', 15), row('expensive', 'Matte Lipstick', 'Stila', 30)], { queryText: q, searchParams: { price_max: 20, currency: 'USD' } });
  expect(body.products.map(p => p.product_id)).toEqual(['cheap']);
});
test('cached citations are not repeated on later pages', () => {
  const body = { ...response('Stila lipstick'), page: 2, products: [row('main', 'Matte Lipstick')] };
  append(body, [row('repeat', 'Liquid Lipstick')], { queryText: 'Stila lipstick', searchParams: { page: 2 } });
  expect(body.products.map(p => p.product_id)).toEqual(['main']);
  expect(body.metadata.citable_supplement_skip_reason).toBe('primary_lane_paginated');
});
test('semantic-empty recovery preserves diagnosis with coherent envelope', () => {
  const body = response('MAC lipstick');
  Object.assign(body, { status: 'failed', success: false, reply: 'No matching beauty products found on the mainline catalog path.' });
  Object.assign(body.metadata, { status: 'failed', failure_class: 'beauty_mainline_empty', search_decision: { final_decision: 'beauty_mainline_empty' } });
  append(body, [row('mac', 'Amplified Lipstick', 'MAC Cosmetics')], { queryText: 'MAC lipstick' });
  finalize(body);
  expect(body).toMatchObject({ status: 'success', success: true, total: 1, reply: null });
  expect(body.metadata).toMatchObject({ failure_class: null, mainline_failure_class: 'beauty_mainline_empty' });
});
test('transport failure is never disguised as recovery', () => {
  const body = { ...response('MAC lipstick'), status: 'failed', success: false, error: 'UPSTREAM_UNAVAILABLE' };
  append(body, [row('mac', 'Amplified Lipstick', 'MAC Cosmetics')], { queryText: 'MAC lipstick' });
  expect(body.products).toHaveLength(0); expect(body.status).toBe('failed');
});

test('exact line matches the actual middle-dot branded product spelling', () => {
  const c = buildSearchQualityContract({ rawQuery: 'M·A·C MACximal Silky Matte Lipstick' });
  expect(gate(row('macximal', 'M·A·Cximal Silky Matte Lipstick', 'MAC Cosmetics'), c, c.effective_query).eligible).toBe(true);
});

test('the shopping-agent availability gate removes citations before success recovery', () => {
  const body = response('MAC lipstick');
  Object.assign(body, { status: 'failed', success: false });
  body.metadata.failure_class = 'beauty_mainline_empty';
  append(body, [row('mac', 'Amplified Lipstick', 'MAC Cosmetics')], { queryText: 'MAC lipstick' });
  availability(body);
  finalize(body);
  expect(body).toMatchObject({ status: 'failed', success: false, products: [], total: 0 });
  expect(body.metadata.citable_supplement_returned_count).toBe(0);
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
  const body = response(q);
  append(body, [wrong], { queryText: q });
  expect(body.products).toEqual([]);
});
test('trusted canonical title can identify an exact line when the display title is shortened', () => {
  const q = 'Stila Stay All Day Liquid Lipstick', c = buildSearchQualityContract({rawQuery:q});
  expect(gate({ ...row('right-line', 'Mini Lipstick'), canonical_title: 'Mini Stay All Day Liquid Lipstick' }, c, q).eligible).toBe(true);
});
