'use strict';

// Fixture shared by the two Postgres suites for GATEWAY_CATALOG_BRAND_SIBLING_SPELLINGS
// (tests/integration/find_products_multi_brand_sibling_spellings_postgres.test.js, on Jest, and
// ..._door_postgres.node.test.cjs, on node:test because the /mcp door imports an ES module).
// Several brand families, single-spelling brands and different brands that share a first word.
// Every brand name is a placeholder.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const GENERIC = {
  sunscreen: ['beauty/skincare/sun/sunscreen', 'Sunscreen', 'Daily Shield Sunscreen'],
  serum: ['beauty/skincare/treat/serum', 'Serum', 'Hydra Renewal Serum'],
  toner: ['beauty/skincare/tone/toner', 'Toner', 'Calming Prep Toner'],
  lipstick: ['beauty/makeup/lip/lipstick', 'Lipstick', 'Velvet Matte Lipstick'],
};
const KINDS = Object.keys(GENERIC);
// [stored brand, what a buyer types for it, the generic products it sells]
const BRANDS = [
  // family 1: the retailer's bare spelling has NO sunscreen; the store's suffixed spelling does
  ['Zentora', 'Zentora', ['serum', 'toner', 'lipstick']],
  ['Zentora USA', 'Zentora', ['sunscreen', 'serum', 'toner', 'lipstick']],
  // a DIFFERENT brand sharing the first word ("labs" is not a market or channel word)
  ['Zentora Labs', 'Zentora Labs', ['sunscreen', 'serum', 'toner']],
  // family 2: three spellings, two of them suffixed
  ['Lumavelle', 'Lumavelle', ['serum', 'toner', 'lipstick']],
  ['Lumavelle UK', 'Lumavelle', ['sunscreen', 'serum', 'toner']],
  ['Lumavelle Official Store', 'Lumavelle', ['sunscreen', 'toner', 'lipstick']],
  // two different brands sharing the first word
  ['Noble', 'Noble', ['sunscreen', 'serum', 'toner']],
  ['Noble Pegasus', 'Noble Pegasus', ['sunscreen', 'serum', 'lipstick']],
  // single-spelling brands
  ['Quillbright', 'Quillbright', ['sunscreen', 'serum', 'toner', 'lipstick']],
  ['Orrin', 'Orrin', ['serum', 'toner', 'lipstick']],
  // "Beauty" is part of a brand name, not a market word: these two stay two brands
  ['Brisa', 'Brisa', ['serum', 'toner', 'lipstick']],
  ['Brisa Beauty', 'Brisa Beauty', ['sunscreen', 'serum', 'toner']],
];
// Spellings that LOOK like a family and are not one, so no query of one may return another's rows,
// flag on or off: a name that is only a channel word, a name too short to be a dictionary key, and
// a mixed-script brand whose dictionary key keeps only its Latin part. They sit in the catalogue
// and the dictionary beside the brands above, outside the invariant (their own brand query is the
// dictionary's business, not this flag's).
const NOT_FAMILIES = [
  ['Global', ['serum', 'toner', 'lipstick']],
  ['Global Store', ['sunscreen', 'serum', 'toner']],
  ['Glob-Al US', ['serum', 'toner', 'lipstick']], // the same family key as "Global", typed another way
  ['Ma US', ['serum', 'toner', 'lipstick']],
  ['Ma Store', ['sunscreen', 'serum', 'toner']],
  ['가나다 Velmora', ['serum', 'toner', 'lipstick']],
  ['Velmora Store', ['sunscreen', 'serum', 'toner']],
];
// The rows a brand query may return, written by hand, not derived by the code under test.
const FAMILY = { Zentora: ['Zentora', 'Zentora USA'], Lumavelle: ['Lumavelle', 'Lumavelle UK', 'Lumavelle Official Store'] };
const familyOf = (brand) => Object.values(FAMILY).find((members) => members.includes(brand)) || [brand];
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_');
const ITEMS = BRANDS.flatMap(([brand, typed, kinds]) => kinds.map((kind) => {
  const [category, type, title] = GENERIC[kind];
  return { id: `${slug(brand)}__${kind}`, brand, typed, kind, category, type, title: `${title} ${slug(brand).length}${kind.length}` };
}));
// The store's own sunscreen, under a fuller title, for the full-title query.
ITEMS.find((item) => item.id === 'zentora_usa__sunscreen').title = 'Daily Shield Mineral Sunscreen SPF 50';
const itemsOf = (brands, prefix) => brands.flatMap(([brand, kinds], at) => kinds.map((kind) => {
  const [category, type, title] = GENERIC[kind];
  return { id: `${prefix}${at}_${slug(brand)}__${kind}`, brand, kind, category, type, title: `${title} 9${prefix.length}${at}${kind.length}` };
}));
const OTHER_ITEMS = itemsOf(NOT_FAMILIES, 'other');
// One brand under spellings that differ only in spacing, for the reviewed-list test. NOT in the
// catalogue by default: the test that needs them inserts and removes them (insertItems).
const REVIEW_CASE = [
  ['Pallor', ['serum', 'toner', 'lipstick']],
  ['Pallor USA', ['serum', 'toner', 'sunscreen']],
  ['Pal Lor USA', ['serum', 'toner', 'lipstick']],
  ['Pallor UK', ['serum', 'toner', 'sunscreen']],
];
const REVIEW_ITEMS = itemsOf(REVIEW_CASE, 'review');
// "Match only the typed spelling plus the bare name": a three-spelling family (bare, US, JP), a
// two-spelling one (bare, Global), and a spelling too small to be a brand by itself (one row).
// Inserted and removed by the test that needs them.
const MARKET_WORD_CASE = [
  ['Solvane', ['serum', 'toner', 'lipstick']],
  ['Solvane US', ['serum', 'toner', 'sunscreen']],
  ['Solvane JP', ['serum', 'toner', 'lipstick']],
  ['Solvane KR', ['serum']],
  ['Tavrin', ['serum', 'toner', 'lipstick']],
  ['Tavrin Global', ['serum', 'toner', 'sunscreen']],
];
const MARKET_WORD_ITEMS = itemsOf(MARKET_WORD_CASE, 'market');
// The same family as market storefronts, each priced in its own currency, for the currency walk.
const STOREFRONT_CASE = [
  ['Solvane', ['serum', 'toner', 'lipstick'], 'USD'],
  ['Solvane US', ['serum', 'toner', 'sunscreen'], 'USD'],
  ['Solvane JP', ['serum', 'toner', 'lipstick'], 'JPY'],
  ['Solvane UK', ['serum', 'toner', 'sunscreen'], 'GBP'],
  ['Solvane Global', ['serum', 'toner', 'lipstick'], 'SGD'],
];
const STOREFRONT_ITEMS = itemsOf(STOREFRONT_CASE, 'storefront').map((item) => ({
  ...item, currency: STOREFRONT_CASE.find(([brand]) => brand === item.brand)[2],
}));
const ALL_ITEMS = [...ITEMS, ...OTHER_ITEMS];
const brandOf = Object.fromEntries(ALL_ITEMS.map((item) => [item.id, item.brand]));
const sigOf = (id) => `sig_${crypto.createHash('md5').update(id).digest('hex')}`;
const idOfSig = Object.fromEntries(ALL_ITEMS.map((item) => [sigOf(item.id), item.id]));
// The products that sit under a suffixed spelling of a brand whose buyer types the bare name.
const UNDER_A_SIBLING_SPELLING = ITEMS.filter((item) => item.brand !== item.typed).map((item) => item.id).sort();

// Materialize, in a schema of its own, the columns the production statement reads (as the
// main-catalog suite does), then the fixture rows. Returns the schema name.
async function createFixture(db, { fetchCanonicalChainRows, buildSearchQualityContract }) {
  const schema = `brand_siblings_${process.pid}_${Date.now()}`;
  await db.query(`CREATE SCHEMA ${schema}`);
  await db.query(`SET search_path TO ${schema}`);
  let sql;
  await fetchCanonicalChainRows({ query: 'lipstick', categoryPathPrefix: 'beauty/makeup/lip/', categoryMode: 'category_browse',
    includeSkuOffers: true, marketId: 'US', searchQualityContract: buildSearchQualityContract({ rawQuery: 'lipstick' }),
    deps: { query: async (text) => { sql = text; return { rows: [] }; } } });
  const tables = {};
  for (const match of sql.matchAll(/(?:FROM|JOIN)\s+(catalog_\w+|index_pipeline_state|external_product_seeds|merchant_stores)\s+(\w+)/g)) {
    const [, table, alias] = match; tables[table] ||= new Set();
    for (const ref of sql.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))) tables[table].add(ref[1]);
  }
  tables.index_pipeline_state.add('serving_eligible');
  for (const [table, cols] of Object.entries(tables)) {
    const definitions = [...cols].map((col) => {
      const type = /^(serving_eligible|index_eligible)$/.test(col) ? 'boolean'
        : /(_payload|_json|^seed_data$|^visible_attributes$|^visible_option_labels$|^ingredient_ids$)/.test(col) ? 'jsonb'
          : /^(list_price|merchant_effective_price|estimated_best_price|inventory_quantity|.*confidence)$/.test(col) ? 'numeric'
            : /(_at)$/.test(col) ? 'timestamptz' : 'text';
      return `${col} ${type}`;
    });
    await db.query(`CREATE TABLE ${table} (${definitions.join(',')})`);
    if (table === 'external_product_seeds') {
      await db.query('CREATE INDEX ON external_product_seeds(attached_product_key); ANALYZE external_product_seeds');
    }
  }
  await db.query("INSERT INTO catalog_merchants(merchant_id,merchant_name,status,primary_platform) VALUES ('retailer','Retailer','active','shopify')");
  await insertItems(db, ALL_ITEMS);
  return schema;
}

async function insertItems(db, items) {
  for (const { id, title, brand, category, type, currency = 'USD' } of items) {
    const sig = sigOf(id);
    await db.query(`INSERT INTO catalog_products(product_key,merchant_id,platform,source_product_id,title,brand,product_type,
     category_path,content_key,pivota_signature_id,pivota_canonical_url,canonical_url,image_url,product_payload,updated_at)
     VALUES ($1,'retailer','shopify',$1,$2,$3,$4,$5,$1,$6,$7,$8,$9,'{}',now())`,
    [id, title, brand, type, category, sig, `https://agent.pivota.cc/products/${sig}`, `https://retailer.example/products/${id}`,
      `https://cdn.example/${id}.jpg`]);
    await db.query('INSERT INTO index_pipeline_state(content_key,serving_eligible) VALUES ($1,true)', [id]);
    await db.query('INSERT INTO catalog_skus(sku_key,product_key,source_variant_id) VALUES ($1,$1,$2)', [id, `variant_${id}`]);
    await db.query("INSERT INTO catalog_offers(offer_id,sku_key,merchant_effective_price,currency,availability) VALUES ($1,$1,20,$2,'in_stock')", [id, currency]);
  }
}

async function removeItems(db, items) {
  const ids = items.map((item) => item.id);
  await db.query('DELETE FROM catalog_offers WHERE offer_id = ANY($1)', [ids]);
  await db.query('DELETE FROM catalog_skus WHERE sku_key = ANY($1)', [ids]);
  await db.query('DELETE FROM index_pipeline_state WHERE content_key = ANY($1)', [ids]);
  await db.query('DELETE FROM catalog_products WHERE product_key = ANY($1)', [ids]);
}

// The stand-in for src/db: the canonical statement and the brand dictionary's own statement
// run on the fixture; no other lane has data. `state.sqlCalls` collects the canonical ones and
// `state.coldDictionary` keeps the dictionary empty.
function fixtureDbQuery(db, state) {
  return async (sql, params) => {
    if (sql.includes('candidate_products AS') && sql.includes('ips.serving_eligible')) {
      state.sqlCalls.push({ sql, params });
      return db.query(sql, params);
    }
    if (sql.includes('GROUP BY LOWER(TRIM(brand))')) return state.coldDictionary ? { rows: [] } : db.query(sql, params);
    if (sql.includes('ips.index_eligible')) throw new Error('citation rescue must not execute');
    return { rows: [] };
  };
}

// THE INVARIANT: for every product a generic query returns, "<its brand as a buyer types it>
// <the same query>" returns that product too. `search(query)` answers sorted fixture ids.
// Returns the ids that break it, sorted.
async function invariantBreaks(search) {
  const breaks = [];
  let checked = 0;
  for (const kind of KINDS) {
    const generic = await search(kind);
    // premise: the generic query really returns every fixture product of that kind
    assert.deepEqual(generic, ALL_ITEMS.filter((item) => item.kind === kind).map((item) => item.id).sort());
    for (const id of generic) {
      const item = ITEMS.find((candidate) => candidate.id === id);
      if (!item) continue; // a NOT_FAMILIES row
      checked += 1;
      if (!(await search(`${item.typed} ${kind}`)).includes(id)) breaks.push(id);
    }
  }
  assert.equal(checked, ITEMS.length);
  return breaks.sort();
}

module.exports = {
  BRANDS, FAMILY, ITEMS, KINDS, MARKET_WORD_ITEMS, NOT_FAMILIES, REVIEW_ITEMS, STOREFRONT_ITEMS, UNDER_A_SIBLING_SPELLING,
  insertItems, removeItems, brandOf, createFixture, familyOf, fixtureDbQuery, idOfSig, invariantBreaks, sigOf,
};
