function pickSimilarProducts(products, baseProductId, limit = 8, excludeIds = []) {
  if (!Array.isArray(products)) return [];

  const excludes = new Set(excludeIds || []);
  excludes.add(baseProductId);

  const base = products.find((product) => String(product.product_id || product.id) === String(baseProductId));
  const basePrice = base ? Number(base.price || base.unit_price || 0) : null;

  let candidates = products.filter(
    (product) => !excludes.has(String(product.product_id || product.id)),
  );

  if (basePrice && basePrice > 0) {
    const min = basePrice * 0.7;
    const max = basePrice * 1.3;
    const priced = candidates.filter((product) => {
      const price = Number(product.price || product.unit_price || 0);
      return price >= min && price <= max;
    });

    if (priced.length) {
      candidates = priced;
    }

    candidates.sort((left, right) => {
      const leftDelta = Math.abs(Number(left.price || left.unit_price || 0) - basePrice);
      const rightDelta = Math.abs(Number(right.price || right.unit_price || 0) - basePrice);
      return leftDelta - rightDelta;
    });
  }

  return candidates.slice(0, limit);
}

module.exports = {
  pickSimilarProducts,
};
