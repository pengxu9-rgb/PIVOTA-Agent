'use strict';

// #1784: a seed observed on a known third-party retailer PDP (ulta.com,
// dermstore.com, …) must NOT mint that retailer host as the product's
// official_url/official_domain. 48 prod pdp_identity_listing rows (63 at
// audit time) carried official_domain='ulta.com' for The Ordinary et al.
// because extractOfficialUrl trusted any listing URL as "official".

const { buildIdentityListingFromProduct, _internals } = require('../src/services/pdpIdentityGraph');

const { extractStrongIdentity, extractSoftIdentity, extractVariantAxes } = _internals;

function seedProduct(overrides = {}) {
  return {
    product_id: 'ext_test_retailer_url',
    title: 'Niacinamide 10% + Zinc 1% Serum',
    brand: 'The Ordinary',
    canonical_url: 'https://www.ulta.com/p/niacinamide-10-zinc-1-serum-pimprod2007111?sku=2551167',
    ...overrides,
  };
}

describe('retailer-host listing URLs are not "official"', () => {
  test('strong identity mints no official_url/official_domain from a retailer PDP URL', () => {
    const product = seedProduct();
    const strong = extractStrongIdentity(product, extractVariantAxes(product));
    expect(strong.official_url).toBeUndefined();
    expect(strong.official_domain).toBeUndefined();
  });

  test('soft identity mints no official_domain from a retailer PDP URL', () => {
    const product = seedProduct();
    const soft = extractSoftIdentity(product, extractVariantAxes(product));
    expect(soft.official_domain).toBeUndefined();
  });

  test('falls past retailer candidates to a non-retailer URL when one exists', () => {
    const product = seedProduct({
      canonical_url: 'https://www.ulta.com/p/niacinamide-10-zinc-1-serum-pimprod2007111',
      product_url: 'https://theordinary.com/en-us/niacinamide-10-zinc-1-serum-100436.html',
    });
    const strong = extractStrongIdentity(product, extractVariantAxes(product));
    expect(strong.official_domain).toBe('theordinary.com');
    expect(strong.official_url).toContain('theordinary.com');
  });

  test('brand-site URLs keep working exactly as before', () => {
    const product = seedProduct({
      canonical_url: 'https://theordinary.com/en-us/niacinamide-10-zinc-1-serum-100436.html',
    });
    const strong = extractStrongIdentity(product, extractVariantAxes(product));
    expect(strong.official_domain).toBe('theordinary.com');
  });

  test('listing built from a retailer-seeded product does not match by official_url and carries no official_domain', () => {
    const listing = buildIdentityListingFromProduct({
      merchantId: 'external_seed',
      productId: 'ext_test_retailer_url',
      product: seedProduct(),
      sourceKind: 'external_seed',
    });
    expect(listing.official_url).toBeNull();
    expect(listing.official_domain).toBeNull();
    expect(['official_url_route', 'official_url_axes']).not.toContain(listing.matched_by_rule);
  });
});
