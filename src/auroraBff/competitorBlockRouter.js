function pickFirstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (!text) continue;
    return text;
  }
  return '';
}

function toNumberOrNull(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeScore01(value) {
  const n = toNumberOrNull(value);
  if (n == null) return null;
  if (n > 1) return clamp01(n / 100);
  return clamp01(n);
}

function normalizeText(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return text;
}

function uniq(strings) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(strings) ? strings : []) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function splitCategoryTokensFromString(value) {
  const text = String(value == null ? '' : value)
    .replace(/[>/_|]+/g, ' ')
    .replace(/[,:;()[\]{}]+/g, ' ')
    .trim()
    .toLowerCase();
  if (!text) return [];
  return text.split(/\s+/).filter(Boolean);
}

function extractCategoryTokens(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return uniq(value.flatMap((item) => extractCategoryTokens(item)));
  }
  if (typeof value === 'string') {
    return uniq(splitCategoryTokensFromString(value));
  }
  if (typeof value === 'object') {
    const obj = value;
    const seeds = [
      obj.category,
      obj.category_name,
      obj.categoryName,
      obj.category_id,
      obj.categoryId,
      obj.taxonomy,
      obj.taxonomy_path,
      obj.taxonomyPath,
      obj.path,
      obj.path_name,
      obj.pathName,
      obj.use_case,
      obj.useCase,
      obj.slug,
      obj.name,
      obj.id,
    ];
    return uniq(seeds.flatMap((item) => extractCategoryTokens(item)));
  }
  return [];
}

function computeJaccard(left, right) {
  const l = new Set(Array.isArray(left) ? left.filter(Boolean) : []);
  const r = new Set(Array.isArray(right) ? right.filter(Boolean) : []);
  if (!l.size || !r.size) return 0;
  let intersect = 0;
  for (const token of l) {
    if (r.has(token)) intersect += 1;
  }
  const union = l.size + r.size - intersect;
  if (!union) return 0;
  return intersect / union;
}

function extractSourceType(candidate) {
  const row = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  return normalizeText(
    pickFirstNonEmpty(
      row?.source?.type,
      row?.source_type,
      row?.sourceType,
      row?.source,
    ),
  );
}

function extractBrandId(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return '';
  return normalizeText(
    pickFirstNonEmpty(
      row.brand_id,
      row.brandId,
      row.brand,
      row.brand_name,
      row.brandName,
    ),
  );
}

function extractPriceAmount(priceLike) {
  if (priceLike == null) return null;
  const direct = toNumberOrNull(priceLike);
  if (direct != null) return direct > 0 ? direct : null;
  if (typeof priceLike === 'object' && !Array.isArray(priceLike)) {
    const value = toNumberOrNull(
      priceLike.amount ??
      priceLike.value ??
      priceLike.price ??
      priceLike.min ??
      priceLike.min_price ??
      priceLike.minPrice ??
      priceLike.sale_price ??
      priceLike.salePrice,
    );
    return value != null && value > 0 ? value : null;
  }
  return null;
}

function extractCategoryMatch(candidate, anchorCategoryTokens) {
  const row = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  const explicit = normalizeScore01(
    row.category_use_case_match ??
    row.categoryUseCaseMatch ??
    row.category_match ??
    row.categoryMatch ??
    row.use_case_match ??
    row.useCaseMatch ??
    row?.score_breakdown?.category_score ??
    row?.scoreBreakdown?.category_score ??
    row?.scoreBreakdown?.categoryScore,
  );
  if (explicit != null) return explicit;
  const candidateCategoryTokens = extractCategoryTokens(
    row.category_taxonomy ??
    row.categoryTaxonomy ??
    row.category ??
    row.use_case ??
    row.useCase,
  );
  if (!anchorCategoryTokens.length || !candidateCategoryTokens.length) return 0.7;
  return clamp01(computeJaccard(anchorCategoryTokens, candidateCategoryTokens));
}

function extractSimTotal(candidate) {
  const row = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  return normalizeScore01(
    row.sim_total ??
    row.simTotal ??
    row.similarity_score ??
    row.similarityScore ??
    row.similarity,
  );
}

function buildCandidateKey(candidate, index) {
  const row = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  const key = pickFirstNonEmpty(
    row.product_id,
    row.productId,
    row.sku_id,
    row.skuId,
    row.id,
    row.name,
    row.display_name,
    row.displayName,
    row.url,
  );
  if (key) return key.toLowerCase();
  return `idx:${index}`;
}

function buildDedupIdentity(candidate, index) {
  const row = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  const family = pickFirstNonEmpty(row.product_family_id, row.productFamilyId, row.family_id, row.familyId);
  if (family) {
    return {
      key: `family:${family}`.toLowerCase(),
      reasonCode: 'dedupe_product_family_id',
    };
  }
  const variantOf = pickFirstNonEmpty(row.variant_of, row.variantOf, row.parent_product_id, row.parentProductId);
  if (variantOf) {
    return {
      key: `variant_of:${variantOf}`.toLowerCase(),
      reasonCode: 'dedupe_variant_of',
    };
  }
  const productRef = pickFirstNonEmpty(row.product_id, row.productId, row.sku_id, row.skuId, row.id);
  if (productRef) {
    return {
      key: `product:${productRef}`.toLowerCase(),
      reasonCode: 'dedupe_product_identity',
    };
  }
  const name = pickFirstNonEmpty(row.display_name, row.displayName, row.name);
  if (name) {
    return {
      key: `name:${name}`.toLowerCase(),
      reasonCode: 'dedupe_name',
    };
  }
  return {
    key: `idx:${index}`,
    reasonCode: 'dedupe_index',
  };
}

function candidateQualityScore(candidate, anchorPrice) {
  const sourceType = extractSourceType(candidate);
  const onPagePenalty = sourceType === 'on_page_related' ? -0.1 : 0;
  const simTotal = extractSimTotal(candidate);
  const simScore = simTotal == null ? 0 : simTotal;
  const categoryMatch = extractCategoryMatch(candidate, []);
  const price = extractPriceAmount(candidate?.price);
  const priceKnownBoost = price != null && anchorPrice != null ? 0.02 : 0;
  return simScore * 0.8 + categoryMatch * 0.2 + onPagePenalty + priceKnownBoost;
}

function dedupeCandidates(candidates, anchorPrice) {
  const out = [];
  const traces = [];
  const indexByDedupKey = new Map();
  const rows = Array.isArray(candidates) ? candidates : [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] && typeof rows[i] === 'object' && !Array.isArray(rows[i]) ? rows[i] : null;
    if (!row) continue;
    const dedupIdentity = buildDedupIdentity(row, i);
    const candidateKey = buildCandidateKey(row, i);
    const nextScore = candidateQualityScore(row, anchorPrice);
    if (!indexByDedupKey.has(dedupIdentity.key)) {
      indexByDedupKey.set(dedupIdentity.key, out.length);
      out.push(row);
      continue;
    }
    const keptIndex = indexByDedupKey.get(dedupIdentity.key);
    const keptRow = out[keptIndex];
    const keptScore = candidateQualityScore(keptRow, anchorPrice);
    if (nextScore > keptScore) {
      const replacedKey = buildCandidateKey(keptRow, keptIndex);
      traces.push({
        candidate_key: replacedKey,
        route: 'rejected',
        reason_codes: [dedupIdentity.reasonCode, 'dedupe_replaced_by_higher_quality_candidate'],
      });
      out[keptIndex] = row;
    } else {
      traces.push({
        candidate_key: candidateKey,
        route: 'rejected',
        reason_codes: [dedupIdentity.reasonCode, 'dedupe_lower_quality_duplicate_removed'],
      });
    }
  }

  return { candidates: out, traces };
}

function routeCandidates(anchor, candidates, ctx = {}) {
  const anchorObj = anchor && typeof anchor === 'object' && !Array.isArray(anchor) ? anchor : {};
  const config = {
    allow_same_brand_competitors: ctx.allow_same_brand_competitors === true,
    allow_same_brand_dupes: ctx.allow_same_brand_dupes === true,
    tau_cat: normalizeScore01(ctx.tau_cat ?? ctx.tauCat ?? 0.55) ?? 0.55,
    tau_dupe: normalizeScore01(ctx.tau_dupe ?? ctx.tauDupe ?? 0.82) ?? 0.82,
    tau_price_dupe: toNumberOrNull(ctx.tau_price_dupe ?? ctx.tauPriceDupe ?? 1.0) ?? 1.0,
  };

  const anchorBrandId = extractBrandId(anchorObj);
  const anchorCategoryTokens = extractCategoryTokens(
    anchorObj.category_taxonomy ??
    anchorObj.categoryTaxonomy ??
    anchorObj.category ??
    anchorObj.use_case ??
    anchorObj.useCase,
  );
  const anchorPrice = extractPriceAmount(anchorObj.price);

  const { candidates: deduped, traces: dedupTraces } = dedupeCandidates(candidates, anchorPrice);

  const comp_pool = [];
  const rel_pool = [];
  const dupe_pool = [];
  const internal_reason_codes = [...dedupTraces];

  for (let i = 0; i < deduped.length; i += 1) {
    const row = deduped[i];
    const candidateKey = buildCandidateKey(row, i);
    const sourceType = extractSourceType(row);
    const candidateBrandId = extractBrandId(row);
    const sameBrand = Boolean(anchorBrandId && candidateBrandId && anchorBrandId === candidateBrandId);
    const categoryMatch = extractCategoryMatch(row, anchorCategoryTokens);
    const simTotal = extractSimTotal(row);
    const candidatePrice = extractPriceAmount(row?.price);
    const priceRatio = anchorPrice != null && candidatePrice != null && anchorPrice > 0 ? candidatePrice / anchorPrice : null;

    const reasonCodes = [];

    if (sourceType === 'on_page_related') {
      rel_pool.push(row);
      reasonCodes.push('route_related_on_page_related_forced');
      internal_reason_codes.push({
        candidate_key: candidateKey,
        route: 'rel_pool',
        reason_codes: reasonCodes,
        metrics: {
          source_type: sourceType,
          category_match: categoryMatch,
          sim_total: simTotal,
          price_ratio: priceRatio,
          same_brand: sameBrand,
        },
      });
      continue;
    }

    let competitorEligible = true;
    if (!config.allow_same_brand_competitors && sameBrand) {
      competitorEligible = false;
      reasonCodes.push('competitor_same_brand_blocked');
    }
    if (categoryMatch < config.tau_cat) {
      competitorEligible = false;
      reasonCodes.push('competitor_category_match_below_threshold');
    }

    let dupeEligible = true;
    if (!config.allow_same_brand_dupes && sameBrand) {
      dupeEligible = false;
      reasonCodes.push('dupe_same_brand_blocked');
    }
    if (simTotal == null || simTotal < config.tau_dupe) {
      dupeEligible = false;
      reasonCodes.push('dupe_similarity_below_threshold');
    }
    if (priceRatio == null) {
      dupeEligible = false;
      reasonCodes.push('dupe_price_ratio_missing');
    } else if (priceRatio > config.tau_price_dupe) {
      dupeEligible = false;
      reasonCodes.push('dupe_price_ratio_above_threshold');
    }

    if (dupeEligible) {
      dupe_pool.push(row);
      reasonCodes.push('route_dupe_passed_hard_gates');
      if (competitorEligible) reasonCodes.push('competitor_eligible_but_route_preferred_dupe');
      internal_reason_codes.push({
        candidate_key: candidateKey,
        route: 'dupe_pool',
        reason_codes: uniq(reasonCodes),
        metrics: {
          source_type: sourceType,
          category_match: categoryMatch,
          sim_total: simTotal,
          price_ratio: priceRatio,
          same_brand: sameBrand,
        },
      });
      continue;
    }

    if (competitorEligible) {
      comp_pool.push(row);
      reasonCodes.push('route_competitor_passed_hard_gates');
      internal_reason_codes.push({
        candidate_key: candidateKey,
        route: 'comp_pool',
        reason_codes: uniq(reasonCodes),
        metrics: {
          source_type: sourceType,
          category_match: categoryMatch,
          sim_total: simTotal,
          price_ratio: priceRatio,
          same_brand: sameBrand,
        },
      });
      continue;
    }

    reasonCodes.push('candidate_rejected_by_hard_gates');
    internal_reason_codes.push({
      candidate_key: candidateKey,
      route: 'rejected',
      reason_codes: uniq(reasonCodes),
      metrics: {
        source_type: sourceType,
        category_match: categoryMatch,
        sim_total: simTotal,
        price_ratio: priceRatio,
        same_brand: sameBrand,
      },
    });
  }

  return {
    comp_pool,
    rel_pool,
    dupe_pool,
    internal_reason_codes,
    config,
  };
}

module.exports = {
  routeCandidates,
};
