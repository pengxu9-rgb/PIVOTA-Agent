const roster = require('./fixtures/meitu_brand_roster.json');
const { buildSearchQualityContract: contract } = require('../src/findProductsMulti/queryUnderstanding');
const { detectBrandEntities, resolveBeautyBrandBrowseQuery } = require('../src/findProductsMulti/brandLexicon');
test.each(roster.flatMap(r => r.names))('Meitu %s scoped before candidate recall', name => {
  const c = contract({ rawQuery: `${name} lipstick` });
  expect(c.target_domain).toBe('beauty');
  expect(c.hard_constraints.brand).not.toBeNull();
  expect(c.hard_constraints.strict_lipstick).toBe(true);
});
test.each(['M·A·C', 'M.A.C', 'MAC'])('%s preserves MAC exact-line scope', alias => {
  const c = contract({ rawQuery: `${alias} MACximal Silky Matte Lipstick` });
  expect(c.hard_constraints.brand.brand_key).toBe('mac_cosmetics');
  expect(c.hard_constraints.exact_product_anchor).toContain('silky matte lipstick');
});
test.each([['rom&nd', 'romand'], ['APIEU', 'apieu'], ["A’PIEU", 'apieu'], ['Stila', 'stila'], ['VDL', 'vdl'], ['NYX', 'nyx']])('%s reviewed brand identity', (alias, key) => {
  expect(resolveBeautyBrandBrowseQuery(`${alias} lip tint`).brand_key).toBe(key);
});
test('Stila brand-only query remains shopping', () => {
  expect(contract({ rawQuery: 'Stila Cosmetics products' }).query_class).toBe('brand_browse');
});
test.each(['note the finish of this lipstick', 'a pixel on my phone', 'a macadamia face cream'])('no substring brand for %s', q => {
  expect(detectBrandEntities(q).brand_like).toBe(false);
});
