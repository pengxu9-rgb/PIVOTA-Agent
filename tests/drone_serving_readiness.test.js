// Drone serving readiness (Slices 3+6 of the drone category build):
//   6. resolveCanonicalCategoryPathPrefixForQuery gains an electronics/drones/
//      branch so drone-intent queries stop safe-emptying and can retrieve the
//      served drone canonicals (category_path 'electronics/drones/camera-drone').
//   3. buildPdpPayload reads electronics_meta from an external-seed product's
//      seed_data (catalog rows have no top-level electronics_meta and it is
//      never auto-extracted) so the Electronics PDP renders a real spec table.

const appDebug = require('../src/server')._debug;
const { buildPdpPayload } = require('../src/pdpBuilder');

const resolvePrefix = appDebug.resolveCanonicalCategoryPathPrefixForQuery;
const isNonBeauty = appDebug.isNonBeautyCanonicalCategoryPathPrefix;

describe('resolveCanonicalCategoryPathPrefixForQuery — drones branch', () => {
  test.each([
    ['best camera drone', 'electronics/drones/'],
    ['best drone for travel', 'electronics/drones/'],
    ['self-flying camera', 'electronics/drones/'],
    ['follow me drone for hiking', 'electronics/drones/'],
    ['quadcopter', 'electronics/drones/'],
    ['HoverAir X1', 'electronics/drones/'],
    ['fpv drone', 'electronics/drones/'],
    ['无人机', 'electronics/drones/'],
  ])('%s -> %s', (query, expected) => {
    expect(resolvePrefix(query)).toBe(expected);
  });

  test('drone prefix counts as non-beauty (direct lane engages)', () => {
    expect(isNonBeauty(resolvePrefix('best camera drone'))).toBe(true);
  });

  test('audio and reading branches unchanged', () => {
    expect(resolvePrefix('wireless earbuds')).toBe('electronics/audio/');
    expect(resolvePrefix('noise cancelling headphones')).toBe('electronics/audio/');
    expect(resolvePrefix('kindle')).toBe('electronics/reading/');
  });

  test('no false fire: plain cameras are not drones', () => {
    expect(resolvePrefix('best camera')).toBe('');
    expect(resolvePrefix('mirrorless camera')).toBe('');
  });

  test('beauty precedence intact: beauty queries still resolve beauty', () => {
    const beautyPrefix = resolvePrefix('lipstick');
    expect(beautyPrefix.startsWith('beauty/')).toBe(true);
  });
});

describe('electronics_meta — MAIN ROUTE (first-class at compose time, no render fallback)', () => {
  const SPEC_GROUPS = [
    { label: 'Flight', rows: [['Weight', '125 g'], ['Flight time', '16 min']] },
  ];

  function productWith(overrides = {}) {
    return {
      product_id: 'prod-drone-1',
      title: 'HOVERAir X1 Self-Flying Camera Drone',
      product_type: 'Camera Drone',
      category_path: 'electronics/drones/camera-drone',
      ...overrides,
    };
  }

  test('composer promotes seed_data.electronics_meta to a first-class field', () => {
    const { buildExternalSeedProduct } = require('../src/services/externalSeedProducts');
    const product = buildExternalSeedProduct({
      id: 'seed-1',
      external_product_id: 'hoverair_x1',
      title: 'HOVERAir X1 Self-Flying Camera Drone',
      domain: 'us.hoverair.com',
      destination_url: 'https://us.hoverair.com/products/x1',
      image_url: 'https://us.hoverair.com/x1.jpg',
      price_amount: 349,
      price_currency: 'USD',
      seed_data: { electronics_meta: { spec_groups: SPEC_GROUPS, in_box: ['Drone', 'Battery'] } },
    });
    expect(product.electronics_meta).toEqual({
      spec_groups: SPEC_GROUPS,
      in_box: ['Drone', 'Battery'],
    });
  });

  test('composer emits no field when seed_data has no/garbage meta', () => {
    const { buildExternalSeedProduct } = require('../src/services/externalSeedProducts');
    for (const seed_data of [{}, { electronics_meta: 'nope' }, { electronics_meta: {} }, null]) {
      const product = buildExternalSeedProduct({
        id: 'seed-2', external_product_id: 'x', title: 'T',
        domain: 'd.example', destination_url: 'https://d.example/p',
        seed_data,
      });
      expect(product.electronics_meta).toBeUndefined();
    }
  });

  test('payload renders the first-class field (main route)', () => {
    const topLevel = { spec_groups: SPEC_GROUPS };
    const payload = buildPdpPayload({ product: productWith({ electronics_meta: topLevel }) });
    expect(payload.product.electronics_meta).toEqual(topLevel);
  });

  test('NO render-time fallback: seed_data alone never renders meta', () => {
    // Founder decision: if a route misses the spec table, fix its composer —
    // the reader must not dig into seed_data. This pins the fallback removal.
    const payload = buildPdpPayload({
      product: productWith({
        seed_data: { electronics_meta: { spec_groups: SPEC_GROUPS } },
      }),
    });
    expect(payload.product.electronics_meta).toBeUndefined();
  });
});
