const AVAILABILITY_SCORES = {
  IN_STOCK: 1,
  LOW_STOCK: 0.7,
  PREORDER: 0.4,
  BACKORDER: 0.3,
  OUT_OF_STOCK: 0,
};

function availabilityScore(status) {
  return AVAILABILITY_SCORES[status] ?? 0.2;
}

function baseScore(item) {
  const recall = item.recall?.raw_score ?? 0.5;
  const popularity = item.signals?.popularity_7d ?? 0.3;
  const conversion = item.signals?.conversion_30d ?? 0.02;
  const avail = availabilityScore(item.availability?.status);
  return recall * 0.4 + popularity * 0.3 + conversion * 10 * 0.1 + avail * 0.2;
}

function rerankCandidates(candidates, options) {
  const {
    seenProductIds = [],
    hiddenProductIds = [],
    rejectedBrandIds = [],
    limit = 8,
    allowOutOfStock = false,
    trackDrops = false,
  } = options || {};

  const seen = new Set(seenProductIds || []);
  const hidden = new Set(hiddenProductIds || []);
  const rejectedBrands = new Set(rejectedBrandIds || []);
  const brandCounts = {};

  const scored = [];
  let droppedOos = 0;
  let filteredHidden = 0;
  let filteredSeen = 0;

  for (const c of candidates) {
    if (!c || !c.product_id) continue;
    if (hidden.has(c.product_id)) {
      filteredHidden += 1;
      continue;
    }
    const brandId = c.brand?.brand_id;
    if (brandId && rejectedBrands.has(brandId)) continue;

    const availStatus = c.availability?.status || 'UNKNOWN';
    if (!allowOutOfStock && availabilityScore(availStatus) === 0) {
      droppedOos += 1;
      continue;
    }

    if (seen.has(c.product_id)) {
      filteredSeen += 1;
      continue;
    }

    const score = baseScore(c);
    scored.push({ item: c, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const results = [];
  for (const entry of scored) {
    const brandId = entry.item.brand?.brand_id;
    if (brandId) {
      brandCounts[brandId] = brandCounts[brandId] || 0;
      if (brandCounts[brandId] >= 2) continue; // diversity cap
      brandCounts[brandId] += 1;
    }
    results.push(entry.item);
    if (results.length >= limit) break;
  }

  return trackDrops ? { results, droppedOos, filteredHidden, filteredSeen } : results;
}

module.exports = {
  rerankCandidates,
  availabilityScore,
};
