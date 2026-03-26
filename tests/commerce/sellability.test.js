const {
  buildSellableStatusPredicate,
  isStatusActive,
  isProductSellable,
} = require('../../src/commerce/catalog/sellability');

describe('sellability helpers', () => {
  test('buildSellableStatusPredicate includes known allowlist', () => {
    expect(buildSellableStatusPredicate("product_data->>'status'")).toContain(
      "lower(coalesce(product_data->>'status', ''))",
    );
    expect(buildSellableStatusPredicate("product_data->>'status'")).toContain("'published'");
    expect(buildSellableStatusPredicate("product_data->>'status'")).toContain("'available'");
  });

  test('isStatusActive fails open for unknown enums and blocks known disabled ones', () => {
    expect(isStatusActive('published')).toBe(true);
    expect(isStatusActive('blocked')).toBe(false);
    expect(isStatusActive('partner_custom_liveish')).toBe(true);
    expect(isStatusActive('')).toBe(true);
  });

  test('isProductSellable respects inventory only when inStockOnly is enabled', () => {
    const base = { id: 'p1', status: 'published', inventory_quantity: 0 };

    expect(isProductSellable(base)).toBe(false);
    expect(isProductSellable(base, { inStockOnly: false })).toBe(true);
    expect(isProductSellable({ ...base, inventory_quantity: 3 })).toBe(true);
    expect(isProductSellable({ ...base, status: 'blocked', inventory_quantity: 3 })).toBe(false);
  });
});
