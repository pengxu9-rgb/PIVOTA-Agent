jest.mock('../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(),
}));

jest.mock('../src/services/catalogEntityResolution', () => ({
  resolveCanonicalCatalogEntityGroup: jest.fn(),
}));

const ORIGINAL_ENV = process.env;

function loadServer(envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: '',
    PIVOTA_API_KEY: '',
    ...envOverrides,
  };
  const db = require('../src/db');
  const catalogEntityResolution = require('../src/services/catalogEntityResolution');
  db.query.mockReset();
  catalogEntityResolution.resolveCanonicalCatalogEntityGroup.mockReset();
  const app = require('../src/server');
  return { app, debug: app._debug, db, catalogEntityResolution };
}

function externalSeedSimilarRow(overrides = {}) {
  return {
    external_product_id: 'ext_public_emit_source',
    matched_signature_product_id: 'sig_publicemit',
    brand: 'Pivota Test',
    category: 'Cleanser',
    product_type: 'Cleanser',
    title: 'Canonical Entity Cleanser',
    image_url: 'https://cdn.example.test/canonical-entity-cleanser.jpg',
    price_amount: '18.50',
    price_currency: 'USD',
    description: 'A cleanser used for canonical entity public emit tests.',
    pdp_description_raw: 'Raw cleanser details.',
    pdp_details_sections: [{ title: 'Details', body: 'Test section' }],
    ...overrides,
  };
}

describe('canonical_entity_id public emit flag', () => {
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('PDP requested signature chokepoint keeps flag-off output on sig ids', () => {
    const { debug } = loadServer({
      CANONICAL_ENTITY_ID_PUBLIC_EMIT_ENABLED: 'false',
    });

    const input = {
      id: 'ext_public_emit_source',
      product_id: 'ext_public_emit_source',
      source_product_id: 'ext_public_emit_source',
      canonical_url: 'https://merchant.example.test/products/source',
      url: 'https://merchant.example.test/products/source',
      destination_url: 'https://merchant.example.test/products/source',
      title: 'Canonical Entity Cleanser',
    };

    const product = debug.applyRequestedPivotaSignatureToPdpProduct(
      input,
      'sig_publicemit',
      '',
      'pg_public_emit',
    );

    expect(debug.isCanonicalEntityIdPublicEmitEnabled()).toBe(false);
    expect(product).toEqual({
      ...input,
      id: 'sig_publicemit',
      product_id: 'sig_publicemit',
      pivota_signature_id: 'sig_publicemit',
      signature_id: 'sig_publicemit',
      pivota_canonical_url: 'https://agent.pivota.cc/products/sig_publicemit',
      canonical_url: 'https://agent.pivota.cc/products/sig_publicemit',
      url: 'https://agent.pivota.cc/products/sig_publicemit',
      merchant_canonical_url: 'https://merchant.example.test/products/source',
      external_product_id: 'ext_public_emit_source',
      external_seed_product_id: 'ext_public_emit_source',
      platform_product_id: 'ext_public_emit_source',
    });
  });

  test('PDP requested signature chokepoint emits canonical_entity_id when enabled', () => {
    const { debug } = loadServer({
      CANONICAL_ENTITY_ID_PUBLIC_EMIT_ENABLED: 'true',
    });

    const product = debug.applyRequestedPivotaSignatureToPdpProduct(
      {
        id: 'ext_public_emit_source',
        product_id: 'ext_public_emit_source',
        source_product_id: 'ext_public_emit_source',
        canonical_url: 'https://merchant.example.test/products/source',
        url: 'https://merchant.example.test/products/source',
        destination_url: 'https://merchant.example.test/products/source',
      },
      'sig_publicemit',
      '',
      'pg_public_emit',
    );

    expect(debug.isCanonicalEntityIdPublicEmitEnabled()).toBe(true);
    expect(product).toEqual(
      expect.objectContaining({
        id: 'pg_public_emit',
        product_id: 'pg_public_emit',
        pivota_signature_id: 'sig_publicemit',
        signature_id: 'sig_publicemit',
        pivota_canonical_url: 'https://agent.pivota.cc/products/pg_public_emit',
        canonical_url: 'https://agent.pivota.cc/products/pg_public_emit',
        url: 'https://agent.pivota.cc/products/pg_public_emit',
        external_product_id: 'ext_public_emit_source',
        source_product_id: 'ext_public_emit_source',
      }),
    );
  });

  test('hydrated external seed source stays flag-off identical and does not resolve a group', async () => {
    const { debug, db, catalogEntityResolution } = loadServer({
      DATABASE_URL: 'postgres://test',
      CANONICAL_ENTITY_ID_PUBLIC_EMIT_ENABLED: 'false',
    });
    db.query.mockResolvedValue({ rows: [externalSeedSimilarRow()] });

    const sources = await debug.fetchExternalSeedSimilarCardSourcesFromDb([
      'ext_public_emit_source',
    ]);

    expect(catalogEntityResolution.resolveCanonicalCatalogEntityGroup).not.toHaveBeenCalled();
    expect(sources.get('ext_public_emit_source')).toEqual({
      product_id: 'ext_public_emit_source',
      brand: 'Pivota Test',
      category: 'Cleanser',
      product_type: 'Cleanser',
      title: 'Canonical Entity Cleanser',
      image_url: 'https://cdn.example.test/canonical-entity-cleanser.jpg',
      price: {
        amount: 18.5,
        currency: 'USD',
      },
      description: 'A cleanser used for canonical entity public emit tests.',
      pdp_description_raw: 'Raw cleanser details.',
      pdp_details_sections: [{ title: 'Details', body: 'Test section' }],
      seed_data: {
        snapshot: {
          brand: 'Pivota Test',
          category: 'Cleanser',
          product_type: 'Cleanser',
          title: 'Canonical Entity Cleanser',
          image_url: 'https://cdn.example.test/canonical-entity-cleanser.jpg',
          description: 'A cleanser used for canonical entity public emit tests.',
          pdp_description_raw: 'Raw cleanser details.',
          pdp_details_sections: [{ title: 'Details', body: 'Test section' }],
        },
      },
    });
  });

  test('hydrated external seed source emits canonical_entity_id and keeps ext lineage when enabled', async () => {
    const { debug, db, catalogEntityResolution } = loadServer({
      DATABASE_URL: 'postgres://test',
      CANONICAL_ENTITY_ID_PUBLIC_EMIT_ENABLED: 'true',
    });
    db.query.mockResolvedValue({ rows: [externalSeedSimilarRow()] });
    catalogEntityResolution.resolveCanonicalCatalogEntityGroup.mockResolvedValue({
      product_group_id: 'pg_public_emit',
      sellable_item_group_id: 'sig_publicemit',
      canonical_sig_id: 'sig_publicemit',
      canonical_entity_id: 'pg_public_emit',
      canonical_product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_public_emit_source',
      },
      members: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_public_emit_source',
          pivota_signature_id: 'sig_publicemit',
        },
      ],
    });

    const sources = await debug.fetchExternalSeedSimilarCardSourcesFromDb([
      'ext_public_emit_source',
    ]);

    expect(catalogEntityResolution.resolveCanonicalCatalogEntityGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'ext_public_emit_source',
      }),
    );
    expect(sources.get('ext_public_emit_source')).toEqual(
      expect.objectContaining({
        product_id: 'pg_public_emit',
        external_product_id: 'ext_public_emit_source',
        source_product_id: 'ext_public_emit_source',
      }),
    );
    expect(sources.get('sig_publicemit')).toBe(sources.get('ext_public_emit_source'));
  });
});
