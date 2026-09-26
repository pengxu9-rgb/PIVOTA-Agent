const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';
process.env.GATEWAY_DYNAMIC_BRAND_DETECT = '1';
process.env.GATEWAY_CATALOG_BEAUTY_BRAND_CONTRACT = '1';

const app = require('../src/server');
const cache = require('../src/findProductsMulti/brandDictionaryCache');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');

const { getSearchQualityContractHardConstraintResult } = app._debug;

// Serving-side hard gate for a CATALOG-derived brand contract, and for the
// self-tan prefix. Counts are prod catalog shapes, 2026-09-25.
cache.__setBrandSetForTest(['round lab', 'round lab us', 'anua', 'bondi sands']);
cache.__setBeautyBrandRowsForTest([
  { b: 'round lab', n: 161, nb: 148, nc: 161 },
  { b: 'round lab us', n: 20, nb: 20, nc: 20 },
  { b: 'anua', n: 131, nb: 116, nc: 131 },
  { b: 'bondi sands', n: 17, nb: 17, nc: 17 },
]);

function row(overrides = {}) {
  return {
    id: 'ext:retailer:test',
    product_id: 'ext:retailer:test',
    merchant_id: 'external_seed',
    title: '1025 Dokdo Toner',
    product_type: 'Toner',
    category_path: ['beauty', 'skincare', 'tone', 'toner'],
    catalog_category_path: 'beauty/skincare/tone/toner',
    brand: 'ROUND LAB',
    vendor: 'ROUND LAB',
    source: 'canonical_chain',
    ...overrides,
  };
}

function gateFor(query, product) {
  const contract = buildSearchQualityContract({ rawQuery: query, source: 'shopping-agent-ui' });
  return { contract, gate: getSearchQualityContractHardConstraintResult(product, contract, query) };
}

test('a catalog beauty brand contract admits its own rows', () => {
  const { contract, gate } = gateFor('Round Lab', row());
  // premise: the contract really is the catalog-derived one
  assert.equal(contract.hard_constraints.brand.brand_key, 'catalog:round lab');
  assert.equal(gate.eligible, true, JSON.stringify(gate.reasons));
});

test('a market-suffixed sibling spelling ("Round Lab US") is still admitted', () => {
  // Without the static-only identity short-circuit, this row resolves to its own
  // catalog key (catalog:round lab us) and is rejected brand_mismatch.
  const { gate } = gateFor('Round Lab', row({ brand: 'Round Lab US', vendor: 'Round Lab US' }));
  assert.equal(gate.eligible, true, JSON.stringify(gate.reasons));
});

test('CONTROL: another catalog beauty brand is rejected by the same contract', () => {
  const { gate } = gateFor('Round Lab', row({ title: 'Heartleaf 77% Soothing Toner', brand: 'Anua', vendor: 'Anua' }));
  assert.equal(gate.eligible, false);
  assert.ok(gate.reasons.includes('brand_mismatch'), JSON.stringify(gate.reasons));
});

test('a tanning row at the bare leaf passes the self-tan prefix', () => {
  const tanning = row({
    title: 'Technocolor Caramel Tanning Mousse',
    product_type: 'Self Tanner',
    category_path: ['beauty', 'body', 'tanning'],
    catalog_category_path: 'beauty/body/tanning',
    brand: 'Bondi Sands',
    vendor: 'Bondi Sands',
  });
  const { contract, gate } = gateFor('self tanner', tanning);
  assert.equal(contract.hard_constraints.category_path_prefix, 'beauty/body/tanning/');
  assert.equal(gate.eligible, true, JSON.stringify(gate.reasons));
});

test('CONTROL: a bronzer is not a self tanner', () => {
  const bronzer = row({
    title: 'Sun Stalk\'r Instant Warmth Bronzer',
    product_type: 'Bronzer',
    category_path: ['beauty', 'makeup', 'face', 'bronzer'],
    catalog_category_path: 'beauty/makeup/face/bronzer',
    brand: 'Fenty Beauty',
    vendor: 'Fenty Beauty',
  });
  const { gate } = gateFor('self tanner', bronzer);
  assert.equal(gate.eligible, false);
  assert.ok(gate.reasons.includes('category_mismatch'), JSON.stringify(gate.reasons));
});
