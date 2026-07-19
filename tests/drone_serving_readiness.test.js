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

describe('buildPdpPayload — electronics_meta from external-seed seed_data', () => {
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

  test('seed_data.electronics_meta reaches the payload', () => {
    const payload = buildPdpPayload({
      product: productWith({
        seed_data: { electronics_meta: { spec_groups: SPEC_GROUPS, in_box: ['Drone', 'Battery'] } },
      }),
    });
    expect(payload.product.electronics_meta).toEqual({
      spec_groups: SPEC_GROUPS,
      in_box: ['Drone', 'Battery'],
    });
  });

  test('top-level electronics_meta still wins over seed_data', () => {
    const topLevel = { spec_groups: [{ label: 'Top', rows: [['A', 'B']] }] };
    const payload = buildPdpPayload({
      product: productWith({
        electronics_meta: topLevel,
        seed_data: { electronics_meta: { spec_groups: SPEC_GROUPS } },
      }),
    });
    expect(payload.product.electronics_meta).toEqual(topLevel);
  });

  test('garbage seed_data shapes are safe no-ops', () => {
    for (const seed_data of [null, 'text', 42, [], { electronics_meta: 'nope' }, { electronics_meta: {} }]) {
      const payload = buildPdpPayload({ product: productWith({ seed_data }) });
      expect(payload.product.electronics_meta).toBeUndefined();
    }
  });
});
