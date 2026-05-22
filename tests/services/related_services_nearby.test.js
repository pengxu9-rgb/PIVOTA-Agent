jest.mock('../../src/db', () => ({
  query: jest.fn(),
}));

jest.mock('../../src/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { query } = require('../../src/db');
const logger = require('../../src/logger');
const { buildPdpPayload } = require('../../src/pdpBuilder');
const {
  enrichProductWithRelatedServices,
  __test,
} = require('../../src/services/catalogRelatedServicesNearby');

const originalServicesNearbyEnabled = process.env.SERVICES_NEARBY_ENABLED;
const CATEGORY_PATH = 'beauty/skincare/treat/serum';

function listing(overrides = {}) {
  return {
    service_type: 'facial',
    title: 'Hydration Facial',
    price_cents: 30000,
    currency: 'KRW',
    duration_minutes: 60,
    requires_consult: false,
    ...overrides,
  };
}

function providerRow(overrides = {}) {
  return {
    provider_id: 'provider-1',
    display_name: 'Aya Seoul',
    name: 'Aya Seoul Legal',
    address_line1: '15 Seolleung-ro 148-gil',
    city: 'Seoul',
    region: 'Gangnam-gu',
    country_code: 'KR',
    english_friendly_signal: 'explicit',
    english_friendly_evidence: 'English booking page and consultation notes.',
    tourist_metadata: {
      nearest_station: 'Apgujeong Rodeo',
      walk_in_accepted: 'false',
      accepts_card: 'unknown',
      tipping_norm: 'not-expected',
    },
    provider_url: 'https://www.ayaseoul.com/about-aya-seoul',
    rating: null,
    rating_count: null,
    matching_listings: [listing()],
    ...overrides,
  };
}

function mockTaxonomy(serviceTypes = ['facial']) {
  query.mockResolvedValueOnce({
    rows: [{ service_types: serviceTypes, confidence: 0.94 }],
  });
}

describe('catalogRelatedServicesNearby', () => {
  beforeEach(() => {
    query.mockReset();
    logger.warn.mockReset();
    __test._invalidateCache();
    process.env.SERVICES_NEARBY_ENABLED = 'true';
  });

  afterAll(() => {
    __test._invalidateCache();
    if (originalServicesNearbyEnabled === undefined) {
      delete process.env.SERVICES_NEARBY_ENABLED;
    } else {
      process.env.SERVICES_NEARBY_ENABLED = originalServicesNearbyEnabled;
    }
  });

  test('flag-off short-circuits without querying the DB', async () => {
    delete process.env.SERVICES_NEARBY_ENABLED;
    const product = { category_path: CATEGORY_PATH };

    const out = await enrichProductWithRelatedServices(product);

    expect(out).toBe(product);
    expect(product._related_services_nearby).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  test('non-beauty category_path short-circuits without querying the DB', async () => {
    const product = { category_path: 'fashion/womens/dresses' };

    const out = await enrichProductWithRelatedServices(product);

    expect(out).toBe(product);
    expect(product._related_services_nearby).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  test('no taxonomy match returns the product unchanged and skips provider lookup', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const product = { category_path: CATEGORY_PATH };

    const out = await enrichProductWithRelatedServices(product);

    expect(out).toBe(product);
    expect(product._related_services_nearby).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('empty service_types returns the product unchanged and skips provider lookup', async () => {
    mockTaxonomy([]);
    const product = { category_path: CATEGORY_PATH };

    const out = await enrichProductWithRelatedServices(product);

    expect(out).toBe(product);
    expect(product._related_services_nearby).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('no providers returns the product unchanged', async () => {
    mockTaxonomy(['facial']);
    query.mockResolvedValueOnce({ rows: [] });
    const product = { category_path: CATEGORY_PATH };

    const out = await enrichProductWithRelatedServices(product);

    expect(out).toBe(product);
    expect(product._related_services_nearby).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  test('happy path attaches sorted providers with capped cheapest-first listings', async () => {
    mockTaxonomy(['facial']);
    query.mockResolvedValueOnce({
      rows: [
        providerRow({
          provider_id: 'provider-inferred',
          display_name: 'Inferred Spa',
          english_friendly_signal: 'inferred',
          matching_listings: [
            listing({ title: 'B', price_cents: 45000 }),
            listing({ title: 'A', price_cents: 25000 }),
            listing({ title: 'C', price_cents: null }),
          ],
        }),
        providerRow({
          provider_id: 'provider-explicit',
          display_name: 'Explicit Clinic',
          name: 'Explicit Clinic',
          english_friendly_signal: 'explicit',
          matching_listings: [
            listing({ title: 'Consult', price_cents: null }),
            listing({ title: 'Five', price_cents: 50000 }),
            listing({ title: 'One', price_cents: 10000 }),
            listing({ title: 'Three', price_cents: 30000 }),
            listing({ title: 'Two', price_cents: 20000 }),
            listing({ title: 'Four', price_cents: 40000 }),
          ],
        }),
      ],
    });
    const product = { category_path: CATEGORY_PATH };

    const out = await enrichProductWithRelatedServices(product);

    expect(out).toBe(product);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual([CATEGORY_PATH]);
    expect(query.mock.calls[1][1]).toEqual([['facial']]);
    expect(product._related_services_nearby).toEqual(
      expect.objectContaining({
        category_path: CATEGORY_PATH,
        service_types: ['facial'],
        scope: { city: 'Seoul', region: 'Gangnam-gu', country_code: 'KR' },
      }),
    );
    expect(product._related_services_nearby.providers).toHaveLength(2);
    expect(product._related_services_nearby.providers[0]).toEqual(
      expect.objectContaining({
        provider_id: 'provider-explicit',
        display_name: 'Explicit Clinic',
        address: '15 Seolleung-ro 148-gil, Seoul, Gangnam-gu, KR',
        url: 'https://www.ayaseoul.com/about-aya-seoul',
        english_friendly_signal: 'explicit',
        matching_listings_count: 6,
      }),
    );
    expect(product._related_services_nearby.providers[0].matching_listings).toHaveLength(5);
    expect(product._related_services_nearby.providers[0].matching_listings.map((item) => item.price_cents))
      .toEqual([10000, 20000, 30000, 40000, 50000]);
    expect(product._related_services_nearby.providers[1].provider_id).toBe('provider-inferred');
    expect(product._related_services_nearby.providers[1].matching_listings.map((item) => item.price_cents))
      .toEqual([25000, 45000, null]);
  });

  test('DB errors are logged and swallowed', async () => {
    mockTaxonomy(['facial']);
    query.mockRejectedValueOnce(new Error('provider query failed'));
    const product = { category_path: CATEGORY_PATH };

    await expect(enrichProductWithRelatedServices(product)).resolves.toBe(product);

    expect(product._related_services_nearby).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: 'provider query failed',
        category_path: CATEGORY_PATH,
      }),
      expect.stringContaining('PDP renders without related services'),
    );
  });

  test('cache hit avoids re-querying the DB for the same category_path', async () => {
    mockTaxonomy(['facial']);
    query.mockResolvedValueOnce({ rows: [providerRow()] });
    const first = { category_path: CATEGORY_PATH };
    const second = { category_path: CATEGORY_PATH };

    await enrichProductWithRelatedServices(first);
    await enrichProductWithRelatedServices(second);

    expect(query).toHaveBeenCalledTimes(2);
    expect(first._related_services_nearby).toBeTruthy();
    expect(second._related_services_nearby).toEqual(first._related_services_nearby);
  });

  test('address composition includes available components and skips missing ones', () => {
    expect(
      __test._composeAddress({
        address_line1: '15 Seolleung-ro 148-gil',
        city: 'Seoul',
        region: 'Gangnam-gu',
        country_code: 'KR',
      }),
    ).toBe('15 Seolleung-ro 148-gil, Seoul, Gangnam-gu, KR');
    expect(
      __test._composeAddress({
        address_line1: '15 Seolleung-ro 148-gil',
        region: 'Gangnam-gu',
        country_code: 'KR',
      }),
    ).toBe('15 Seolleung-ro 148-gil, Gangnam-gu, KR');
    // When address_line1 already contains city/region (extractor often
    // captures the full Korean address inline), don't duplicate them.
    expect(
      __test._composeAddress({
        address_line1: '3F, 51, Apgujeong-ro 30-gil, Gangnam-gu, Seoul',
        city: 'Seoul',
        region: 'Gangnam-gu',
        country_code: 'KR',
      }),
    ).toBe('3F, 51, Apgujeong-ro 30-gil, Gangnam-gu, Seoul, KR');
  });

  test('pdpBuilder emits related_services_nearby module without leaking the internal field', () => {
    const moduleData = {
      category_path: CATEGORY_PATH,
      service_types: ['facial'],
      scope: { city: 'Seoul', region: 'Gangnam-gu', country_code: 'KR' },
      providers: [
        {
          provider_id: 'provider-1',
          name: 'Aya Seoul',
          display_name: 'Aya Seoul',
          address: '15 Seolleung-ro 148-gil, Seoul, Gangnam-gu, KR',
          url: 'https://www.ayaseoul.com/about-aya-seoul',
          english_friendly_signal: 'explicit',
          english_friendly_evidence: 'English booking page.',
          tourist_metadata: null,
          rating: null,
          rating_count: null,
          matching_listings_count: 1,
          matching_listings: [listing()],
        },
      ],
    };
    const product = {
      product_id: 'serum-1',
      title: 'Niacinamide Serum',
      category: CATEGORY_PATH,
      category_path: CATEGORY_PATH,
      price: 12000,
      currency: 'KRW',
      _related_services_nearby: moduleData,
    };

    const pdpPayload = buildPdpPayload({ product });
    const relatedServicesModule = pdpPayload.modules.find((module) => module.type === 'related_services_nearby');

    expect(relatedServicesModule).toEqual({
      module_id: 'm_related_services_nearby',
      type: 'related_services_nearby',
      priority: 35,
      data: moduleData,
    });
    expect(pdpPayload.product._related_services_nearby).toBeUndefined();
    expect(product._related_services_nearby).toBeUndefined();
  });
});
