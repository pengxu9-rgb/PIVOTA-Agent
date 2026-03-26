const SELLABLE_PRODUCT_STATUS_VALUES = [
  'active',
  'published',
  'online',
  'live',
  'enabled',
  'available',
];

const NON_SELLABLE_PRODUCT_STATUS_VALUES = new Set([
  'inactive',
  'disabled',
  'deleted',
  'archived',
  'archive',
  'draft',
  'hidden',
  'unpublished',
  'blocked',
]);

function buildSellableStatusPredicate(statusExpr) {
  const expr = `lower(coalesce(${statusExpr}, ''))`;
  const allowed = SELLABLE_PRODUCT_STATUS_VALUES.map((value) => `'${value}'`).join(', ');
  return `(${expr} = '' OR ${expr} IN (${allowed}))`;
}

function isStatusActive(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return true;
  if (SELLABLE_PRODUCT_STATUS_VALUES.includes(normalized)) return true;
  if (NON_SELLABLE_PRODUCT_STATUS_VALUES.has(normalized)) return false;
  // Unknown status should fail-open to avoid dropping sellable catalogs due
  // partner-specific status enums.
  return true;
}

function isProductSellable(product, options = {}) {
  if (!product || typeof product !== 'object') return false;
  if (!isStatusActive(product.status)) return false;
  const inStockOnly = options?.inStockOnly !== false;
  if (inStockOnly) {
    const rawInv =
      product.inventory_quantity ??
      product.inventoryQuantity ??
      (product.inventory && product.inventory.quantity);
    if (rawInv != null) {
      const inv = Number(rawInv);
      if (Number.isFinite(inv) && inv <= 0) return false;
    }
  }
  return true;
}

module.exports = {
  SELLABLE_PRODUCT_STATUS_VALUES,
  NON_SELLABLE_PRODUCT_STATUS_VALUES,
  buildSellableStatusPredicate,
  isStatusActive,
  isProductSellable,
};
