const { detectAllowOOS } = require('../src/recommend/intent');

describe('detectAllowOOS', () => {
  test('false on normal shopping query', () => {
    expect(detectAllowOOS('cozy hoodie gift', {})).toBe(false);
    expect(detectAllowOOS('show me jackets for travel', {})).toBe(false);
  });

  test('true on explicit OOS/restock intent', () => {
    expect(detectAllowOOS("notify me when it's back in stock", {})).toBe(true);
    expect(detectAllowOOS('restock hoodies please', {})).toBe(true);
    expect(detectAllowOOS('out of stock is ok', {})).toBe(true);
    expect(detectAllowOOS('show me oos options', {})).toBe(true);
    expect(detectAllowOOS('any availability, including oos', {})).toBe(true);
    expect(detectAllowOOS('OOS is fine', {})).toBe(true);
  });

  test('slots override', () => {
    expect(detectAllowOOS('cozy hoodie gift', { allow_oos: true })).toBe(true);
  });
});
