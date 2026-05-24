const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { selectors } = require('../scripts/selectors/index.cjs');

const EXPECTED_SELECTORS = [
  'missing_offers_fixable_positive_price',
  'missing_offers_blocked_no_positive_price',
  'missing_catalog_surface_image',
  'identity_missing',
  'identity_approved_not_live',
  'identity_review_required',
  'catalog_payload_missing_seed_data',
  'catalog_payload_missing_snapshot',
  'catalog_quality_summary_lost',
  'catalog_staler_than_seed',
  'index_serving_contract_violation',
  'orphan_catalog_product',
  'orphan_offer_without_sku',
  'zero_or_missing_price_offer',
];

const SAMPLING_SCRIPTS = [
  'audit-orphan-shopify-offers.cjs',
  'sample-serving-contract-violations.cjs',
  'sample-duplicate-canonical-groups.cjs',
  'audit-zero-price-offer-timestamps.cjs',
];

function scriptPath(file) {
  return path.join(__dirname, '..', 'scripts', file);
}

function envWithoutDbUrl() {
  const env = { ...process.env };
  delete env.DATABASE_URL_PUBLIC;
  return env;
}

test('PDP PR-1 selector registry contains exactly the expected unique selectors', () => {
  const names = selectors.map((selector) => selector.name);
  assert.deepEqual([...names].sort(), [...EXPECTED_SELECTORS].sort());
  assert.equal(new Set(names).size, names.length);

  for (const selector of selectors) {
    assert.equal(typeof selector.name, 'string');
    assert.equal(typeof selector.description, 'string');
    assert.equal(typeof selector.query, 'string');
    assert.ok(selector.name.length > 0);
    assert.ok(selector.description.length > 0);
    assert.ok(selector.query.length > 0);
  }
});

test('PDP PR-1 selector queries are read-only SELECT/CTE statements', () => {
  for (const selector of selectors) {
    const query = selector.query.trim();
    assert.match(query, /^(SELECT|WITH)\b/i, selector.name);
    assert.doesNotMatch(query, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i, selector.name);
  }
});

test('PDP PR-1 sampling scripts emit usage with --help', () => {
  for (const file of SAMPLING_SCRIPTS) {
    const result = spawnSync(process.execPath, [scriptPath(file), '--help'], {
      env: envWithoutDbUrl(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    assert.match(result.stdout, /Usage: node scripts\//);
    assert.match(result.stdout, /DATABASE_URL_PUBLIC/);
  }
});

test('PDP PR-1 sampling scripts fail loud without DATABASE_URL_PUBLIC', () => {
  for (const file of SAMPLING_SCRIPTS) {
    const result = spawnSync(process.execPath, [scriptPath(file), '--limit', '1', '--json'], {
      env: envWithoutDbUrl(),
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, file);
    assert.match(result.stderr, /DATABASE_URL_PUBLIC is required/);
  }
});

test('PDP PR-1 run-selector exposes usage without requiring the database', () => {
  const result = spawnSync(process.execPath, [scriptPath('run-selector.cjs'), '--help'], {
    env: envWithoutDbUrl(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Available selectors:/);
  assert.match(result.stdout, /zero_or_missing_price_offer/);
});
