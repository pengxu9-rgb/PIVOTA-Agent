// Retailer-ingest rows (catalog_products product_key `ext:retailer:<hash>`) also write a sibling
// external_product_seeds row whose attached_product_key is that product_key. Both load into the
// relationship-graph pool, collapse into one family (same brand + title + category), and the
// merged record must keep the catalog row's identity: serving reads edges by `product:sig_<hash>`
// (productRelationshipGraph.buildAnchorRefsFromProduct), and the affected-products selector emits
// the sig / content_key / product_key as refs.
//
// The affected loader must also reach the catalog row from the seed: its LEFT JOIN used to key only on
// cp.source_product_id = eps.external_product_id, which a retailer seed never satisfies.
//
// Row shapes follow pivota-backend services/catalog_enrichment_agent/ingestion.py
// (_build_pdp_insert for the catalog row; the seed rows beside it).
const {
  collectRefsFromManifest,
  filterAffectedAnchors,
} = require('../../scripts/build-product-relationship-graph');
const {
  buildAffectedProductsManifest,
  buildCatalogAffectedRow,
  buildExternalSeedAffectedRow,
} = require('../../scripts/select-relationship-graph-affected-products');
const {
  dedupeNormalizedProducts,
  loadAffectedProductAnchorCandidates,
  loadProductRelationshipGraphSourceInputs,
  normalizeCatalogProductRow,
  normalizeExternalProductSeedRow,
} = require('../../src/auroraBff/productRelationshipGraphSources');

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SIG = 'sig_5f0e1d2c3b4a5968';
const SEED_EXTERNAL_ID = `japanesetaste-com:${HASH.slice(0, 16)}`;

const catalogRow = {
  product_key: `ext:retailer:${HASH}`,
  source_product_id: `retailer:${HASH}`,
  pivota_signature_id: SIG,
  content_key: 'ck_77aa88bb99cc00dd',
  merchant_id: 'merch_obs_japanesetaste.com',
  platform: 'external_seed',
  title: 'Kosé Sekkisei Clear Wellness Natural Drip',
  brand: 'Kosé',
  product_type: 'toner',
  category: 'toner',
  category_path: 'beauty/skincare/tone/toner',
  canonical_url: 'https://japanesetaste.com/products/kose-sekkisei-natural-drip',
  product_payload: { enrichment_meta: {} },
  updated_at: '2026-09-24T03:00:00Z',
  created_at: '2026-09-24T03:00:00Z',
};

const seedRow = {
  id: `seed:${HASH.slice(0, 16)}`,
  external_product_id: SEED_EXTERNAL_ID,
  attached_product_key: catalogRow.product_key,
  title: catalogRow.title,
  category: 'toner',
  price_amount: 28,
  price_currency: 'USD',
  market: 'US',
  canonical_url: catalogRow.canonical_url,
  destination_url: catalogRow.canonical_url,
  seed_data: { brand: 'Kosé', title: catalogRow.title, category_path: catalogRow.category_path },
  updated_at: catalogRow.updated_at,
  created_at: catalogRow.created_at,
};

function queryFnFor({ includePoolSeed = false } = {}) {
  return async (sql, params) => {
    const text = String(sql);
    if (/FROM external_product_seeds eps\s+LEFT JOIN catalog_products/.test(text)) {
      // The affected loader matches the seed by attached_product_key. The retailer seed's
      // external_product_id is not the catalog row's source_product_id, so only a join on
      // cp.product_key = eps.attached_product_key reaches the catalog columns.
      const joined = /cp\.product_key = eps\.attached_product_key/.test(text);
      return {
        rows: [{
          ...seedRow,
          product_key: joined ? catalogRow.product_key : null,
          source_product_id: joined ? catalogRow.source_product_id : null,
          pivota_signature_id: joined ? SIG : null,
          content_key: joined ? catalogRow.content_key : null,
          product_ref: joined ? `product:${SIG}` : `product:${SEED_EXTERNAL_ID}`,
        }],
      };
    }
    if (/FROM catalog_products cp\s+WHERE cp\.product_key = ANY/.test(text)) {
      const terms = new Set(params[0]);
      return { rows: terms.has(catalogRow.product_key) ? [{ ...catalogRow, product_ref: `product:${SIG}` }] : [] };
    }
    if (includePoolSeed && /FROM external_product_seeds\s+WHERE/.test(text)) {
      return {
        rows: [{
          ...seedRow,
          seed_data: { brand: 'Kosé', category: 'toner', snapshot: { title: catalogRow.title, brand: 'Kosé', category: 'toner' } },
        }],
      };
    }
    return { rows: [] };
  };
}

function refsFor(rows) {
  return collectRefsFromManifest(JSON.parse(JSON.stringify(buildAffectedProductsManifest({ rows, market: 'US' }))));
}

describe('relationship graph anchors for retailer-ingest (ext:retailer:) rows', () => {
  test.each([
    ['without', false],
    ['with', true],
  ])('a catalog_products-scoped run anchors the row on its sig (%s the pooled seed)', async (_label, includePoolSeed) => {
    const refs = refsFor([buildCatalogAffectedRow(catalogRow, 'US')]);
    const inputs = await loadProductRelationshipGraphSourceInputs({
      queryFn: queryFnFor({ includePoolSeed }),
      limit: 400,
      market: 'US',
      affectedRefs: refs,
    });

    const anchors = filterAffectedAnchors(inputs.products, refs);

    expect(anchors).toHaveLength(1);
    expect(anchors[0].product_ref).toBe(`product:${SIG}`);
    expect(anchors[0].pivota_signature_id).toBe(SIG);
    expect(anchors[0].content_key).toBe(catalogRow.content_key);
  });

  test('the nightly selector shape (catalog + seed sources) anchors on the sig, not the seed id', async () => {
    const refs = refsFor([
      buildCatalogAffectedRow(catalogRow, 'US'),
      buildExternalSeedAffectedRow({
        ...seedRow,
        catalog_product_key: catalogRow.product_key,
        pivota_signature_id: SIG,
        content_key: catalogRow.content_key,
      }, 'US'),
    ]);
    const inputs = await loadProductRelationshipGraphSourceInputs({
      queryFn: queryFnFor({ includePoolSeed: true }),
      limit: 400,
      market: 'US',
      affectedRefs: refs,
    });

    const anchors = filterAffectedAnchors(inputs.products, refs);

    expect(anchors.map((anchor) => anchor.product_ref)).toEqual([`product:${SIG}`]);
  });

  test('the affected loader joins a retailer seed to its catalog row by attached_product_key', async () => {
    const refs = refsFor([buildCatalogAffectedRow(catalogRow, 'US')]);
    const queryFn = queryFnFor();
    const seedOnly = async (sql, params) => (
      /FROM external_product_seeds eps/.test(String(sql)) ? queryFn(sql, params) : { rows: [] }
    );

    const affected = await loadAffectedProductAnchorCandidates({ queryFn: seedOnly, refs, market: 'US', limit: 10 });

    expect(affected).toHaveLength(1);
    expect(affected[0]).toMatchObject({
      product_ref: `product:${SIG}`,
      pivota_signature_id: SIG,
      content_key: catalogRow.content_key,
      product_key: catalogRow.product_key,
    });
  });

  test('a seed without a sig never replaces the identity of the catalog row it is attached to', () => {
    const merged = dedupeNormalizedProducts([
      normalizeExternalProductSeedRow({ ...seedRow, product_ref: `product:${SEED_EXTERNAL_ID}` }),
      normalizeCatalogProductRow(catalogRow),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      product_ref: `product:${SIG}`,
      pivota_signature_id: SIG,
      content_key: catalogRow.content_key,
      product_key: catalogRow.product_key,
    });
    // Non-identity evidence from the seed still survives the merge.
    expect(merged[0].price).toBe(28);
  });

  test('refusing case: two sig-bearing listings in one family keep the preferred listing whole', () => {
    const otherSig = 'sig_0000aaaa1111bbbb';
    const other = {
      ...catalogRow,
      product_key: 'ext:retailer:ffffffffffffffffffffffffffffffff',
      source_product_id: 'retailer:ffffffffffffffffffffffffffffffff',
      pivota_signature_id: otherSig,
      content_key: 'ck_other',
    };
    const [merged] = dedupeNormalizedProducts([
      normalizeCatalogProductRow(catalogRow),
      normalizeCatalogProductRow(other),
    ]);

    // Neither record is borrowed from field by field: the survivor's sig, content_key and
    // product_key all belong to one listing.
    const owner = merged.pivota_signature_id === SIG ? catalogRow : other;
    expect(merged).toMatchObject({
      product_ref: `product:${owner.pivota_signature_id}`,
      content_key: owner.content_key,
      product_key: owner.product_key,
      source_product_id: owner.source_product_id,
    });
  });
});
