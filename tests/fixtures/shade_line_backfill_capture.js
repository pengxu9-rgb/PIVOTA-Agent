// Runs backfillPdpIdentityGraph over a fixed set of invented seed rows with fake DB hooks and
// captures every statement it issues (a hash of the SQL text plus the exact params). Used by the
// shade-line golden test: with SHADE_LINE_RULE_V2_ENABLED off, the capture must equal the one taken
// from origin/main before the rule existed (tests/fixtures/shade_line_rule_flag_off_golden.json).
//
// Every store, brand and title below is invented.

const { createHash } = require('crypto');

const STORE = 'nail-store.example';

function seedRow({ code, title, price = 30, currency = 'SGD', productType = 'nail-polish', categoryPath = null, domain = STORE, merchantId = 'merch_obs_nailstore' }) {
  return {
    id: `seed:golden:${code}`,
    external_product_id: `golden:${code}`,
    market: 'US',
    tool: 'catalog_enrichment_agent_v1',
    destination_url: `https://${domain}/products/${code}`,
    canonical_url: `https://${domain}/products/${code}`,
    domain,
    title,
    image_url: `https://${domain}/images/${code}.jpg`,
    price_amount: price,
    price_currency: currency,
    availability: 'in_stock',
    seed_data: { brand: title.split(' ')[0], title, product_type: 'external' },
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    attached_product_key: `pk_${code}`,
    catalog_content_key: null,
    catalog_product_key: null,
    catalog_merchant_id: merchantId,
    catalog_product_type: productType,
    catalog_category_path: categoryPath,
  };
}

const GOLDEN_SEED_ROWS = [
  seedRow({ code: 'aura-k2207', title: 'BRANDA AURA K2207 SAFFRON' }),
  seedRow({ code: 'aura-t415', title: 'BRANDA AURA T415 MOSS' }),
  seedRow({ code: 'aura-p380', title: '[RETIRED] BRANDA AURA P380 HARBOR' }),
  seedRow({ code: 'lacq-884', title: 'BRANDB LACQ NO.884' }),
  seedRow({ code: 'lacq-885', title: 'BRANDB LACQ NO.885' }),
  seedRow({ code: 'atelier-271', title: 'BRANDD ATELIER - PEAR SPRITZ #271' }),
  seedRow({ code: 'atelier-272', title: 'BRANDD ATELIER - FIG TONIC #272' }),
  seedRow({ code: 'aura-kit', title: 'BRANDA AURA 0101-0105 GIFT SET', productType: 'gift-set' }),
  seedRow({ code: 'lash-ink', title: 'BRANDF Volume Lash - Ink Plum', productType: 'mascara', currency: 'USD', price: 24 }),
  seedRow({ code: 'lash-jet', title: 'BRANDF Volume Lash - Jet Night', productType: 'mascara', currency: 'USD', price: 24 }),
  seedRow({ code: 'serum-c23', title: 'BRANDH Bright C23 Serum', productType: 'serum', currency: 'USD', price: 40 }),
];

function hashSql(sql) {
  return createHash('sha1').update(String(sql || '').replace(/\s+/g, ' ').trim()).digest('hex');
}

// Wall-clock stamps written inside payloads (e.g. ingredient_intel.authoritative.generated_at).
function scrub(params) {
  if (params === undefined) return null;
  const text = JSON.stringify(params).replace(/(\\?"generated_at\\?":\\?")[^"\\]*/g, '$1<ts>');
  return JSON.parse(text);
}

async function captureBackfill(pdpIdentityGraph, { seedRows = GOLDEN_SEED_ROWS } = {}) {
  const statements = [];
  const queryFn = async (sql, params) => {
    statements.push({ via: 'query', sql: hashSql(sql), params: scrub(params) });
    if (String(sql || '').includes('FROM external_product_seeds e')) return { rows: seedRows };
    return { rows: [] };
  };
  const withClientFn = async (fn) =>
    fn({
      query: async (sql, params) => {
        statements.push({ via: 'client', sql: hashSql(sql), params: scrub(params) });
        return { rows: [] };
      },
    });
  const result = await pdpIdentityGraph.backfillPdpIdentityGraph({ queryFn, withClientFn });
  return { statements, result: JSON.parse(JSON.stringify(result)) };
}

module.exports = { GOLDEN_SEED_ROWS, captureBackfill, hashSql, seedRow };
