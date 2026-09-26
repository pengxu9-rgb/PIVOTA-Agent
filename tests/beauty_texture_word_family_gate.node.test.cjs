const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';

const app = require('../src/server');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');

const { scoreBeautyExternalSeedProduct, inferBeautyMainlineIntent, buildBeautyMainlineRetrievalQueries } = app._debug;

// Measured 2026-09-26 on gateway-00387-yer (MCP search_catalog, market US):
// "MineTan self tan foam" recalled 16 serving-eligible rows on beauty/body/tanning/
// and returned 0 (ranker_rejected 16). The bare word "foam" set target_families
// ["cleanser"] (product_class_gate:cleanser), which no tanning row can satisfy.
// "MineTan self tanner" returned all 16. A texture word must not override the
// family the rest of the query names. "cream" / "lotion" did the same with the
// moisturizer family: "MineTan self tan lotion" kept 4 of the 16.

const FLAG = 'BEAUTY_RANKER_CATALOG_LEAF_SIGNAL_ENABLED';

// Prod row shape, fields copied from the live search_catalog response for
// "MineTan self tanner" (2026-09-26); description trimmed.
function mineTanFoamRow(overrides = {}) {
  return {
    id: 'sig_6448001138f987311460af2d8e38f458',
    product_id: 'sig_6448001138f987311460af2d8e38f458',
    merchant_id: 'merch_obs_fe6667be90b6392a',
    merchant_name: 'MineTan',
    platform: 'external_seed',
    platform_product_id: 'minetan-medium-dark-self-tan-foam',
    title: 'Medium Dark Self Tan Foam',
    description:
      'Details FOR FAIR SKIN TONES OR FIRST TIME TANNERS. 1 HOUR EXPRESS TRIPLE ACTION FORMULA. COCONUT SCENTED',
    price: 25.95,
    currency: 'USD',
    availability: 'in_stock',
    in_stock: true,
    product_type: 'tanning',
    category: 'tanning',
    category_path: ['beauty', 'body', 'tanning'],
    catalog_category_path: 'beauty/body/tanning',
    source: 'canonical_chain',
    brand: 'MineTan',
    vendor: 'MineTan',
    destination_url: 'https://us.shop.minetanbodyskin.com/products/medium-dark-self-tan-mousse',
    ...overrides,
  };
}

function cleanserFoamRow() {
  return {
    id: 'ext:test-amino-foam-cleanser',
    product_id: 'ext:test-amino-foam-cleanser',
    title: 'Amino Acid Foam Cleanser',
    description: 'A gentle foaming face wash for daily cleansing.',
    product_type: 'cleanser',
    category: 'cleanser',
    category_path: ['beauty', 'skincare', 'cleanse'],
    catalog_category_path: 'beauty/skincare/cleanse',
    source: 'canonical_chain',
    brand: 'Test Brand',
    price: 18,
    currency: 'USD',
  };
}

function score(query, product) {
  const prev = process.env[FLAG];
  process.env[FLAG] = '1'; // prod value on gateway-00387-yer
  try {
    const contract = buildSearchQualityContract({ rawQuery: query, source: 'shopping-agent-ui' });
    return scoreBeautyExternalSeedProduct({
      product,
      queryText: query,
      intent: inferBeautyMainlineIntent(query),
      normalizedQuery: query,
      queryTokens: query.toLowerCase().split(' '),
      searchQualityContract: contract,
    });
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

test('MineTan self tan foam: no cleanser gate, same as "self tanner"', () => {
  assert.deepEqual(inferBeautyMainlineIntent('MineTan self tan foam').families, []);
  assert.deepEqual(inferBeautyMainlineIntent('MineTan self tanner').families, []);
});

test('MineTan self tan foam: the real tanning row is kept by the ranker', () => {
  const out = score('MineTan self tan foam', mineTanFoamRow());
  assert.equal(out.relevant, true, JSON.stringify(out));
});

test('MineTan self tan foam: no cleanser retrieval variant', () => {
  const variants = buildBeautyMainlineRetrievalQueries('MineTan self tan foam');
  assert.ok(!variants.includes('gentle cleanser face wash'), JSON.stringify(variants));
});

for (const query of ['tanning foam', 'bronzing foam', 'self-tan foam', 'sunless tanning foam']) {
  test(`"${query}" does not gate to cleanser`, () => {
    assert.ok(!inferBeautyMainlineIntent(query).families.includes('cleanser'));
  });
}

test('a resolved non-cleanse category wins over "foam": sunscreen keeps only its own family', () => {
  assert.deepEqual(inferBeautyMainlineIntent('foam sunscreen').families, ['sunscreen']);
  assert.ok(!inferBeautyMainlineIntent('foundation foam').families.includes('cleanser'));
});

// Controls: the fix must not take the cleanser gate away from cleanser queries.
for (const query of ['foam cleanser', 'cleansing foam', 'amino acid foam', 'foam', 'CeraVe foaming cleanser']) {
  test(`control: "${query}" still gates to cleanser`, () => {
    assert.deepEqual(inferBeautyMainlineIntent(query).families, ['cleanser']);
  });
}

test('control: an explicit cleanser word still gates even next to a tanning word', () => {
  assert.ok(inferBeautyMainlineIntent('self tan foam cleanser').families.includes('cleanser'));
});

test('control: "foam cleanser" still rejects the tanning row and keeps a cleanser row', () => {
  assert.equal(score('foam cleanser', mineTanFoamRow()).relevant, false);
  const kept = score('foam cleanser', cleanserFoamRow());
  assert.equal(kept.relevant, true, JSON.stringify(kept));
});

function moisturizerRow() {
  return {
    id: 'ext:test-ceramide-face-cream',
    product_id: 'ext:test-ceramide-face-cream',
    title: 'Ceramide Barrier Face Cream',
    description: 'A rich daily moisturizer with ceramides.',
    product_type: 'moisturizer',
    category: 'moisturizer',
    category_path: ['beauty', 'skincare', 'moisturize'],
    catalog_category_path: 'beauty/skincare/moisturize',
    source: 'canonical_chain',
    brand: 'Test Brand',
    price: 24,
    currency: 'USD',
  };
}

// --- "cream" / "lotion" -> moisturizer ---

for (const query of ['MineTan self tan lotion', 'MineTan tanning cream', 'gradual tan lotion', 'self tan cream']) {
  test(`"${query}": no moisturizer gate, and the real tanning row is kept`, () => {
    assert.deepEqual(inferBeautyMainlineIntent(query).families, []);
    const out = score(query, mineTanFoamRow());
    assert.equal(out.relevant, true, JSON.stringify(out));
  });
}

test('MineTan self tan lotion: no moisturizer retrieval variant', () => {
  const variants = buildBeautyMainlineRetrievalQueries('MineTan self tan lotion');
  assert.ok(!variants.includes('barrier repair moisturizer cream'), JSON.stringify(variants));
});

test('a resolved non-moisturize category wins over "cream" / "lotion"', () => {
  assert.deepEqual(inferBeautyMainlineIntent('sunscreen lotion').families, ['sunscreen']);
  assert.deepEqual(inferBeautyMainlineIntent('cream cleanser').families, ['cleanser']);
  assert.deepEqual(inferBeautyMainlineIntent('cream blush').families, []);
  assert.deepEqual(inferBeautyMainlineIntent('hair cream').families, []);
  assert.deepEqual(inferBeautyMainlineIntent('perfume lotion').families, []);
});

// Controls: moisturizer queries keep their gate.
for (const query of ['face cream', 'body lotion', 'night cream', 'cream', 'lotion', 'moisturizer', 'ceramide cream']) {
  test(`control: "${query}" still gates to moisturizer`, () => {
    assert.deepEqual(inferBeautyMainlineIntent(query).families, ['moisturizer']);
  });
}

test('control: a query that resolves the moisturize path keeps its gate despite a tanning word', () => {
  // "bronzing lotion" resolves beauty/skincare/moisturize/; dropping the family would swap a
  // text gate its tanning rows pass for a path gate they fail.
  assert.deepEqual(inferBeautyMainlineIntent('bronzing lotion').families, ['moisturizer']);
});

test('control: an explicit moisturizer word still gates next to a tanning word', () => {
  assert.ok(inferBeautyMainlineIntent('tanning moisturizer').families.includes('moisturizer'));
});

test('control: "face cream" still rejects the tanning row and keeps a moisturizer row', () => {
  assert.equal(score('face cream', mineTanFoamRow()).relevant, false);
  const kept = score('face cream', moisturizerRow());
  assert.equal(kept.relevant, true, JSON.stringify(kept));
});
