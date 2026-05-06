const {
  URL_REPAIR_CONTRACT_VERSION,
  buildUrlRepairPatch,
  bodyMatchesTitleHint,
  canonicalUrlKey,
  matchesExpectedCurrentUrl,
} = require('../../scripts/repair-external-seed-url-fields.cjs');

describe('repair-external-seed-url-fields', () => {
  test('canonicalUrlKey ignores query/hash and trailing slash', () => {
    expect(canonicalUrlKey('https://www.skin1004.com/products/example/?utm=1#top')).toBe(
      'https://www.skin1004.com/products/example',
    );
  });

  test('matches expected current URL against row, seed, and snapshot fields', () => {
    const row = {
      canonical_url: 'https://old.example/products/a',
      destination_url: '',
      seed_data: {
        canonical_url: '',
        snapshot: {
          destination_url: 'https://old.example/products/a?variant=1',
        },
      },
    };
    expect(
      matchesExpectedCurrentUrl(row, {
        expected_current_url: 'https://old.example/products/a',
      }),
    ).toBe(true);
    expect(
      matchesExpectedCurrentUrl(row, {
        expected_current_url: 'https://old.example/products/b',
      }),
    ).toBe(false);
  });

  test('requires title hint when provided', () => {
    expect(
      bodyMatchesTitleHint('<title>Hyalu-Cica Water-Fit Sun Serum UV</title>', {
        expected_title_contains: 'Water-Fit Sun Serum',
      }),
    ).toBe(true);
    expect(
      bodyMatchesTitleHint('<title>Coming Soon</title>', {
        expected_title_contains: 'Water-Fit Sun Serum',
      }),
    ).toBe(false);
  });

  test('buildUrlRepairPatch updates root seed and snapshot URL contract', () => {
    const row = {
      canonical_url: 'https://www.skin1004.com/products/old',
      destination_url: 'https://www.skin1004.com/products/old',
      seed_data: {
        canonical_url: 'https://www.skin1004.com/products/old',
        destination_url: 'https://www.skin1004.com/products/old',
        snapshot: {
          canonical_url: 'https://www.skin1004.com/products/old',
          destination_url: 'https://www.skin1004.com/products/old',
        },
      },
    };
    const patch = buildUrlRepairPatch(
      row,
      {
        external_product_id: 'ext_1',
        url: 'https://www.skin1004.com/products/hyalu-cica-water-fit-sun-serum-uv',
        reason_codes: ['public_pdp_canonical_repair'],
      },
      '2026-05-06T00:00:00.000Z',
      { ok: true, status: 200 },
    );
    expect(patch.canonical_url).toBe('https://www.skin1004.com/products/hyalu-cica-water-fit-sun-serum-uv');
    expect(patch.seed_data.snapshot.destination_url).toBe(
      'https://www.skin1004.com/products/hyalu-cica-water-fit-sun-serum-uv',
    );
    expect(patch.seed_data.external_seed_url_repair_v1.contract_version).toBe(URL_REPAIR_CONTRACT_VERSION);
    expect(patch.seed_data.snapshot.external_seed_url_repair_v1.reason_codes).toEqual([
      'public_pdp_canonical_repair',
    ]);
  });
});
