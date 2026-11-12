const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';
process.env.GATEWAY_DYNAMIC_BRAND_DETECT = '1';
process.env.GATEWAY_CATALOG_BEAUTY_BRAND_CONTRACT = '1';
delete process.env.GATEWAY_CATALOG_BRAND_SIBLING_SPELLINGS;

const app = require('../src/server');
const cache = require('../src/findProductsMulti/brandDictionaryCache');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');
const { brandIdentityBindKeys } = require('../src/services/canonicalSearchQualitySql');

const { getSearchQualityContractHardConstraintResult, projectSearchQualityContractForMetadata } = app._debug;

// The serving gate must admit every row the widened recall can return, and nothing it did not
// admit before except the family's own rows (GATEWAY_CATALOG_BRAND_SIBLING_SPELLINGS).
// Flag-on twins of tests/catalog_beauty_brand_gate.node.test.cjs, whose own assertions are
// unchanged. Placeholder brand names.
const FLAG = 'GATEWAY_CATALOG_BRAND_SIBLING_SPELLINGS';
const beauty = (b, n) => ({ b, n, nb: n, nc: n, nl: n });
const ROWS = [
  beauty('zentora', 5), beauty('zentora usa', 189), beauty('zentora uk', 31), beauty('zentora labs', 12),
  beauty('noble', 30), beauty('noble pegasus', 14), beauty('quillbright', 25),
];
cache.__setBrandSetForTest(ROWS.map((row) => row.b));
cache.__setBeautyBrandRowsForTest(ROWS);

function row(brand, overrides = {}) {
  return {
    id: 'ext:retailer:test', product_id: 'ext:retailer:test', merchant_id: 'external_seed',
    title: 'Daily Relief Toner', product_type: 'Toner',
    category_path: ['beauty', 'skincare', 'tone', 'toner'], catalog_category_path: 'beauty/skincare/tone/toner',
    brand, vendor: brand, source: 'canonical_chain', ...overrides,
  };
}

function withFlag(value, fn) {
  const prior = process.env[FLAG];
  if (value === null) delete process.env[FLAG]; else process.env[FLAG] = value;
  try { return fn(); } finally {
    if (prior === undefined) delete process.env[FLAG]; else process.env[FLAG] = prior;
  }
}

function gateFor(query, product) {
  const contract = buildSearchQualityContract({ rawQuery: query, source: 'shopping-agent-ui' });
  return { contract, gate: getSearchQualityContractHardConstraintResult(product, contract, query) };
}
const admitted = (query, brand) => gateFor(query, row(brand)).gate.eligible;

test('flag on: a bare contract admits every family member', () => withFlag('on', () => {
  const { contract } = gateFor('Zentora toner', row('Zentora'));
  assert.equal(contract.hard_constraints.brand.brand_key, 'catalog:zentora');
  assert.deepEqual(brandIdentityBindKeys(contract.hard_constraints.brand), ['zentora', 'zentorauk', 'zentorausa']);
  for (const brand of ['Zentora', 'ZENTORA USA', 'Zentora UK']) assert.equal(admitted('Zentora toner', brand), true, brand);
}));

test('flag on: a suffixed contract admits the bare key AND the other suffixed member', () => withFlag('on', () => {
  const { contract } = gateFor('Zentora USA toner', row('Zentora USA'));
  assert.equal(contract.hard_constraints.brand.brand_key, 'catalog:zentora usa');
  assert.deepEqual(brandIdentityBindKeys(contract.hard_constraints.brand), ['zentorausa', 'zentora', 'zentorauk']);
  for (const brand of ['Zentora USA', 'Zentora', 'Zentora UK']) assert.equal(admitted('Zentora USA toner', brand), true, brand);
}));

test('flag off: the other suffixed member is rejected, as on main (the gap the gate had)', () => withFlag(null, () => {
  assert.equal(admitted('Zentora USA toner', 'Zentora USA'), true);
  assert.equal(admitted('Zentora USA toner', 'Zentora'), true);
  const { gate } = gateFor('Zentora USA toner', row('Zentora UK'));
  assert.equal(gate.eligible, false);
  assert.ok(gate.reasons.includes('brand_mismatch'), JSON.stringify(gate.reasons));
}));

test('the gate admits every key recall binds, for every family member typed (flag on)', () => withFlag('on', () => {
  const spellings = { zentora: 'Zentora', zentorausa: 'Zentora USA', zentorauk: 'Zentora UK' };
  for (const typed of Object.values(spellings)) {
    const { contract } = gateFor(`${typed} toner`, row(typed));
    const bound = brandIdentityBindKeys(contract.hard_constraints.brand);
    assert.equal(bound.length, 3, typed);
    for (const key of bound) assert.equal(admitted(`${typed} toner`, spellings[key]), true, `${typed} -> ${key}`);
  }
}));

// This gate's own containment check (main's, untouched) admits a row whose brand contains the
// contract's or is contained in it, so "Noble" passes it under a "Noble Pegasus" contract with
// the flag on or off; the SQL equality is what keeps such rows out of recall, and the Postgres
// route test pins that. What this file pins is that the flag adds family rows and nothing else.
test('flag on, CONTROL: another brand is still rejected, and so is a brand of the same first word under a suffixed contract', () => withFlag('on', () => {
  for (const [query, brand] of [
    ['Zentora toner', 'Quillbright'], ['Zentora USA toner', 'Quillbright'],
    ['Zentora USA toner', 'Zentora Labs'], ['Zentora UK toner', 'Zentora Labs'],
    ['Quillbright toner', 'Zentora USA'],
  ]) {
    const { gate } = gateFor(query, row(brand));
    assert.equal(gate.eligible, false, `${query} / ${brand}`);
    assert.ok(gate.reasons.includes('brand_mismatch'), JSON.stringify(gate.reasons));
  }
}));

test('the flag changes the verdict for family rows only: every other (query, row) pair is identical on and off', () => {
  const brands = ['Zentora', 'Zentora USA', 'Zentora UK', 'Zentora Labs', 'Noble', 'Noble Pegasus', 'Quillbright', ''];
  const changed = [];
  for (const typed of brands.filter(Boolean)) {
    for (const brand of brands) {
      const off = withFlag(null, () => admitted(`${typed} toner`, brand));
      const on = withFlag('on', () => admitted(`${typed} toner`, brand));
      if (off !== on) changed.push(`${typed} -> ${brand}: ${off} -> ${on}`);
    }
  }
  assert.deepEqual(changed, ['Zentora USA -> Zentora UK: false -> true', 'Zentora UK -> Zentora USA: false -> true']);
});

test('metadata: the count of bound spellings, only with the flag on and more than one key, never the strings', () => {
  const project = (query) => projectSearchQualityContractForMetadata(buildSearchQualityContract({ rawQuery: query, source: 'shopping-agent-ui' }));
  const off = withFlag(null, () => project('Zentora toner'));
  const on = withFlag('on', () => project('Zentora toner'));
  assert.equal('brand_spellings_bound' in off, false);
  assert.equal(on.brand_spellings_bound, 3);
  const { brand_spellings_bound: _count, ...rest } = on;
  assert.deepEqual(rest, off, 'the rest of the projection is unchanged');
  assert.deepEqual(on.hard_constraints.brand, { brand_key: 'catalog:zentora', canonical: 'zentora', alias: 'zentora' });
  assert.equal(JSON.stringify(on).includes('zentora usa'), false);
  assert.equal(JSON.stringify(on).includes('zentora uk'), false);
  // a static-lexicon brand, taken from the reviewed roster rather than named here
  const staticName = Object.values(require('../data/beauty/meitu_brand_aliases.json'))[0][0];
  assert.ok(project(`${staticName} lipstick`).hard_constraints.brand, 'premise: the roster brand is a hard brand');
  for (const query of ['Quillbright toner', 'Zentora Labs toner', 'toner', `${staticName} lipstick`]) {
    const single = withFlag('on', () => project(query));
    assert.equal('brand_spellings_bound' in single, false, query);
    assert.deepEqual(single, withFlag(null, () => project(query)), query);
  }
});
