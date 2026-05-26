const {
  numberArg,
} = require('../../scripts/build-product-relationship-graph');

describe('build product relationship graph CLI helpers', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  test('uses fallback when optional numeric flag is omitted', () => {
    process.argv = ['node', 'scripts/build-product-relationship-graph.js'];

    expect(numberArg('max-per-anchor', 24, { min: 1, max: 100 })).toBe(24);
  });

  test('clamps provided numeric flags', () => {
    process.argv = ['node', 'scripts/build-product-relationship-graph.js', '--max-per-anchor', '0'];

    expect(numberArg('max-per-anchor', 24, { min: 1, max: 100 })).toBe(1);
  });

  test('supports source-limit and anchor-offset numeric flags', () => {
    process.argv = [
      'node',
      'scripts/build-product-relationship-graph.js',
      '--source-limit',
      '1600',
      '--anchor-offset',
      '1200',
    ];

    expect(numberArg('source-limit', 200, { min: 200, max: 5000 })).toBe(1600);
    expect(numberArg('anchor-offset', 0, { min: 0, max: 5000 })).toBe(1200);
  });
});
