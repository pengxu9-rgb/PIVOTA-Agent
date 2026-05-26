const DEFAULT_MARKET = 'US';
const DEFAULT_SOURCE_LIMIT = 1000;

const SOURCE_MISSING_CODES = new Set([
  'NO_DATABASE',
  '42P01',
  '42703',
  '42704',
  '42883',
  '0A000',
]);

const SOURCE_PRIORITY = {
  relationship_graph_transitive_recall: 0.09,
  aurora_dupe_kb: 0.18,
  ingredient_kb: 0.12,
  product_intel_kb: 0.11,
  vector_recall: 0.1,
  external_product_seed: 0.08,
  external_seed: 0.08,
  products_cache: 0.06,
};

const EVIDENCE_GRADE_RANK = {
  A: 4,
  B: 3,
  C: 2,
  D: 1,
};

const BEAUTY_TEXT_PATTERNS = [
  '%beauty%',
  '%skincare%',
  '%skin care%',
  '%serum%',
  '%moisturizer%',
  '%cleanser%',
  '%sunscreen%',
  '%spf%',
  '%makeup%',
  '%cosmetic%',
  '%fragrance%',
  '%hair%',
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceJson(value) {
  if (isPlainObject(value) || Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asPlainObject(value) {
  if (isPlainObject(value)) return value;
  const parsed = coerceJson(value);
  return isPlainObject(parsed) ? parsed : null;
}

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeLower(value, max = 512) {
  return normalizeString(value, max).toLowerCase();
}

function pickFirstString(...values) {
  for (const value of values) {
    const text = normalizeString(value);
    if (text) return text;
  }
  return '';
}

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  if (isPlainObject(value)) {
    return toNumberOrNull(
      value.amount ??
        value.value ??
        value.price ??
        value.min ??
        value.min_price ??
        value.minPrice ??
        value.sale_price ??
        value.salePrice,
    );
  }
  const n = Number(String(value).replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeLimit(limit, fallback = DEFAULT_SOURCE_LIMIT) {
  const n = Number(limit);
  const base = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(1, Math.min(5000, base));
}

function normalizeMarket(value) {
  return normalizeString(value || DEFAULT_MARKET, 24).toUpperCase() || DEFAULT_MARKET;
}

function normalizeEvidenceGrade(value, fallback = 'B') {
  const grade = normalizeString(value, 8).toUpperCase();
  if (EVIDENCE_GRADE_RANK[grade]) return grade;
  return fallback;
}

function betterEvidenceGrade(left, right) {
  const l = normalizeEvidenceGrade(left, '');
  const r = normalizeEvidenceGrade(right, '');
  return (EVIDENCE_GRADE_RANK[r] || 0) > (EVIDENCE_GRADE_RANK[l] || 0) ? r : l || r || 'B';
}

function normalizeProductRef(value, fallbackPrefix = 'product') {
  const text = normalizeString(value, 512);
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return `url:${text}`;
  if (/^[a-z][a-z0-9_+-]*:/i.test(text)) return text;
  const prefix = normalizeLower(fallbackPrefix, 40) || 'product';
  return `${prefix}:${text}`;
}

const RETAILER_OR_MARKETPLACE_HOST_TOKENS = new Set([
  'amazon',
  'boots',
  'iherb',
  'moidaus',
  'sephora',
  'skincupid',
  'target',
  'tiktok',
  'ulta',
  'walmart',
  'yesstyle',
]);

function inferBrandFromOfficialUrl(value) {
  const text = normalizeString(value, 500);
  if (!/^https?:\/\//i.test(text)) return '';
  let host = '';
  try {
    host = new URL(text).hostname.toLowerCase();
  } catch {
    return '';
  }
  const parts = host.split('.').filter(Boolean);
  while (['www', 'shop', 'us', 'global'].includes(parts[0])) parts.shift();
  const root = parts[0] || '';
  if (!root || RETAILER_OR_MARKETPLACE_HOST_TOKENS.has(root)) return '';
  const words = root
    .replace(/(beauty|cosmetics|skincare|skin|official)$/i, ' $1')
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  if (!words.length) return '';
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function normalizeTokenText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeTokenText(item)).filter(Boolean).join(' ');
  }
  if (isPlainObject(value)) {
    return [
      value.name,
      value.label,
      value.title,
      value.tag,
      value.headline,
      value.body,
      value.step,
      value.category,
    ].map((item) => normalizeTokenText(item)).filter(Boolean).join(' ');
  }
  return normalizeString(value, 2000);
}

function normalizeTextList(value, max = 20) {
  const input = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const raw of input.flatMap((item) => {
    if (Array.isArray(item)) return item;
    if (isPlainObject(item)) {
      return [item.name, item.label, item.title, item.tag, item.headline, item.body, item.step, item.category];
    }
    if (typeof item === 'string' && /[,|;>]/.test(item)) return item.split(/[,|;>]/g);
    return [item];
  })) {
    const text = normalizeString(raw, 140);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeCategoryTaxonomy(...values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    for (const token of normalizeTextList(value, 12)) {
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(token);
      if (out.length >= 12) return out;
    }
  }
  return out;
}

function collectTextFragments(value, maxFragments = 32, depth = 0) {
  if (depth > 4 || maxFragments <= 0) return [];
  if (typeof value === 'string' || typeof value === 'number') {
    const text = normalizeString(value, 400);
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      out.push(...collectTextFragments(item, maxFragments - out.length, depth + 1));
      if (out.length >= maxFragments) break;
    }
    return out;
  }
  if (isPlainObject(value)) {
    const preferredKeys = [
      'headline',
      'body',
      'label',
      'tag',
      'name',
      'title',
      'summary',
      'description',
      'step',
      'texture',
      'finish',
    ];
    const out = [];
    for (const key of preferredKeys) {
      if (!(key in value)) continue;
      out.push(...collectTextFragments(value[key], maxFragments - out.length, depth + 1));
      if (out.length >= maxFragments) break;
    }
    return out;
  }
  return [];
}

function extractProductIntelBundle(value) {
  const obj = asPlainObject(value);
  if (!obj) return null;
  return (
    asPlainObject(obj.product_intel_v1) ||
    asPlainObject(obj.product_intel) ||
    (asPlainObject(obj.product_intel_core) ? obj : null)
  );
}

function extractProductIntelCore(bundle) {
  const obj = asPlainObject(bundle);
  return asPlainObject(obj?.product_intel_core) || asPlainObject(obj?.core) || null;
}

function normalizeSourceRefs(value, fallbackRef = null) {
  const refs = [];
  const seen = new Set();
  const push = (raw) => {
    const src = typeof raw === 'string' ? { type: raw } : isPlainObject(raw) ? raw : null;
    if (!src) return;
    const type = normalizeLower(src.type || src.source_type || src.source, 80);
    const name = normalizeString(src.name || src.label || src.title || src.table || src.source_id || src.id, 180);
    const url = normalizeString(src.url || src.href || src.canonical_url || src.source_ref, 500);
    const observedAt = toIsoOrNull(src.observed_at || src.observedAt);
    if (!type && !name && !url) return;
    const key = `${type}::${name}::${url}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({
      ...(type ? { type } : {}),
      ...(name ? { name } : {}),
      ...(url ? { url } : {}),
      ...(src.authoritative === true || src.authority === true ? { authoritative: true } : {}),
      ...(observedAt ? { observed_at: observedAt } : {}),
    });
  };
  if (Array.isArray(value)) {
    for (const item of value) push(item);
  } else {
    push(value);
  }
  push(fallbackRef);
  return refs.slice(0, 16);
}

function mergeSourceRefs(...refsLists) {
  return normalizeSourceRefs(refsLists.flatMap((refs) => (Array.isArray(refs) ? refs : [refs])).filter(Boolean));
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
}

function firstObject(...values) {
  for (const value of values) {
    const obj = asPlainObject(value);
    if (obj) return obj;
  }
  return {};
}

function sourceTypesFromRefs(sourceRefs) {
  return normalizeSourceRefs(sourceRefs).map((ref) => normalizeLower(ref.type)).filter(Boolean);
}

function sourceStrength(sourceRefs) {
  let strength = 0;
  for (const type of sourceTypesFromRefs(sourceRefs)) {
    strength = Math.max(strength, SOURCE_PRIORITY[type] || 0);
  }
  return strength;
}

function normalizeProductCandidateSnapshot(input = {}, options = {}) {
  const row = asPlainObject(input) || {};
  const productData = firstObject(row.product_data, row.productData, row.product, row.sku, row.item);
  const seedData = firstObject(row.seed_data, row.seedData);
  const snapshot = firstObject(row.snapshot, productData.snapshot, seedData.snapshot, seedData.product, seedData.sku);
  const product = {
    ...seedData,
    ...productData,
    ...snapshot,
  };
  const analysis = firstObject(row.analysis, product.analysis);
  const intelBundle =
    extractProductIntelBundle(row.product_intel) ||
    extractProductIntelBundle(row.productIntel) ||
    extractProductIntelBundle(analysis) ||
    extractProductIntelBundle(product);
  const intelCore = extractProductIntelCore(intelBundle);
  const canonicalProductRef = firstObject(intelBundle?.canonical_product_ref, row.canonical_product_ref);
  const sourceMeta = firstObject(row.source_meta, row.sourceMeta, intelBundle?.provenance, product.provenance);
  const variants = firstArray(product.variants, seedData.variants, snapshot.variants);
  const firstVariant = firstObject(variants[0]);
  const officialSourceUrl = pickFirstString(
    row.official_source_url,
    row.officialSourceUrl,
    product.official_source_url,
    product.officialSourceUrl,
    sourceMeta.official_source_url,
    sourceMeta.officialSourceUrl,
    sourceMeta.source_url,
    sourceMeta.sourceUrl,
  );

  const productId = pickFirstString(
    row.product_id,
    row.productId,
    row.external_product_id,
    row.externalProductId,
    row.attached_product_key,
    row.sku_key,
    row.product_key,
    product.product_id,
    product.productId,
    product.sku_id,
    product.skuId,
    product.id,
    product.external_product_id,
    canonicalProductRef.product_id,
    canonicalProductRef.productId,
    canonicalProductRef.external_product_id,
  );
  const rawRef = pickFirstString(
    options.productRef,
    row.product_ref,
    row.productRef,
    product.product_ref,
    product.productRef,
    productId,
    row.kb_key && /^product:/i.test(String(row.kb_key)) ? row.kb_key : '',
    product.url,
    product.canonical_url,
    row.canonical_url,
    row.destination_url,
    officialSourceUrl,
  );

  const brand = pickFirstString(
    row.brand,
    row.brand_name,
    row.brandName,
    product.brand,
    product.brand_name,
    product.brandName,
    product.vendor,
    product.vendor_name,
    seedData.brand,
    sourceMeta.brand,
    inferBrandFromOfficialUrl(officialSourceUrl),
  );
  const name = pickFirstString(
    row.name,
    row.title,
    row.product_name,
    row.productName,
    product.name,
    product.display_name,
    product.displayName,
    product.title,
    product.product_name,
    product.productName,
    firstVariant.title,
    intelBundle?.search_card?.title_candidate,
    intelBundle?.searchCard?.titleCandidate,
    intelBundle?.shopping_card?.title,
    intelBundle?.shoppingCard?.title,
    intelCore?.what_it_is?.headline,
    intelCore?.whatItIs?.headline,
  );
  const categoryTaxonomy = normalizeCategoryTaxonomy(
    row.category_taxonomy,
    row.categoryTaxonomy,
    product.category_taxonomy,
    product.categoryTaxonomy,
    row.category,
    product.category,
    product.product_type,
    product.productType,
    product.product_category,
    intelCore?.routine_fit?.step,
    intelCore?.routineFit?.step,
    intelCore?.best_for,
  );
  const category = pickFirstString(row.category, product.category, product.product_type, categoryTaxonomy[0]);
  const price = toNumberOrNull(
    row.price ??
      row.price_amount ??
      row.priceAmount ??
      product.price ??
      product.price_amount ??
      product.priceAmount ??
      product.sale_price ??
      product.salePrice ??
      firstVariant.price ??
      firstVariant.price_amount,
  );
  const url = pickFirstString(
    row.canonical_url,
    row.destination_url,
    row.url,
    product.canonical_url,
    product.canonicalUrl,
    product.destination_url,
    product.destinationUrl,
    product.url,
    product.pdp_url,
    product.pdpUrl,
    firstVariant.url,
    officialSourceUrl,
  );
  const observedAt =
    toIsoOrNull(options.observedAt) ||
    toIsoOrNull(row.last_success_at) ||
    toIsoOrNull(row.verified_at) ||
    toIsoOrNull(row.updated_at) ||
    toIsoOrNull(row.cached_at) ||
    toIsoOrNull(row.created_at) ||
    toIsoOrNull(intelCore?.freshness?.generated_at) ||
    null;
  const sourceType = normalizeLower(options.sourceType || row.source_type || row.sourceType || row.source, 80);
  const sourceName = normalizeString(options.sourceName || options.table || row.source || row.kb_key || row.id, 180);
  const fallbackSourceRef = sourceType
    ? {
      type: sourceType,
      name: sourceName || sourceType,
      url,
      authoritative: options.authoritative !== false,
      observed_at: observedAt,
    }
    : null;
  const sourceRefs = normalizeSourceRefs(row.source_refs || row.sourceRefs || product.source_refs, fallbackSourceRef);
  const intelText = collectTextFragments(intelCore).join(' ');
  const description = pickFirstString(
    row.description,
    row.summary,
    product.description,
    product.body_html,
    product.bodyHtml,
    product.pdp_description_raw,
    seedData.pdp_description_raw,
    seedData.description,
    intelCore?.what_it_is?.body,
    intelCore?.whatItIs?.body,
    intelText,
  );
  const ingredientText = [
    row.raw_ingredient_text_clean,
    row.inci_list,
    row.raw_inci,
    product.raw_ingredient_text_clean,
    product.inci_list,
    product.raw_inci,
    normalizeTokenText(product.ingredients),
    normalizeTokenText(product.ingredient_ids),
    normalizeTokenText(row.normalized_ingredients_json),
    normalizeTokenText(row.active_ingredients_json),
  ].map((item) => normalizeString(item, 2000)).filter(Boolean).join(' ');
  const tags = normalizeTextList(
    [
      row.tags,
      product.tags,
      product.labels,
      product.ingredient_ids,
      categoryTaxonomy,
      intelCore?.best_for,
      intelCore?.routine_fit?.am_pm,
      intelCore?.routineFit?.am_pm,
    ].flat(),
    32,
  );
  const ref = normalizeProductRef(rawRef || (brand && name ? `text:${brand}:${name}` : name ? `text:${name}` : ''));
  if (!ref) return null;

  return {
    product_ref: ref,
    product_id: productId || ref.replace(/^[a-z][a-z0-9_+-]*:/i, ''),
    brand,
    name,
    category,
    category_taxonomy: categoryTaxonomy,
    price,
    ...(url ? { url } : {}),
    ...(description ? { description } : {}),
    ...(ingredientText ? { ingredient_text: ingredientText } : {}),
    ...(tags.length ? { tags } : {}),
    source_refs: sourceRefs,
    evidence_grade: normalizeEvidenceGrade(
      options.evidenceGrade ||
        row.evidence_grade ||
        row.evidenceGrade ||
        (sourceType === 'aurora_dupe_kb' && row.verified === true ? 'A' : 'B'),
      'B',
    ),
    observed_at: observedAt,
    price_observed_at: observedAt,
    product_family_id: pickFirstString(
      row.product_family_id,
      row.productFamilyId,
      product.product_family_id,
      product.productFamilyId,
      product.product_line_id,
      product.productLineId,
      product.variant_of,
      product.variantOf,
    ),
    ...(intelBundle ? { product_intel: intelBundle } : {}),
    ...(intelText ? { intel_text: intelText } : {}),
    _source_type: sourceType || '',
  };
}

function normalizeProductsCacheRow(row = {}) {
  return normalizeProductCandidateSnapshot(row, {
    sourceType: 'products_cache',
    sourceName: 'products_cache',
    observedAt: row.updated_at || row.cached_at || row.created_at,
    authoritative: true,
    evidenceGrade: 'B',
  });
}

function normalizeExternalProductSeedRow(row = {}) {
  return normalizeProductCandidateSnapshot(row, {
    sourceType: 'external_product_seed',
    sourceName: row.external_product_id || row.id || 'external_product_seeds',
    observedAt: row.updated_at || row.created_at,
    authoritative: true,
    evidenceGrade: row.evidence_grade || 'B',
  });
}

function normalizeProductIntelKbRow(row = {}) {
  const analysis = firstObject(row.analysis);
  const bundle = extractProductIntelBundle(analysis);
  const canonical = firstObject(bundle?.canonical_product_ref);
  const productRef = pickFirstString(
    row.product_ref,
    row.productRef,
    canonical.product_ref,
    canonical.productRef,
    canonical.product_id,
    canonical.productId,
    row.kb_key && /^product:/i.test(String(row.kb_key)) ? row.kb_key : '',
    row.kb_key,
  );
  return normalizeProductCandidateSnapshot(
    {
      ...row,
      product_ref: productRef,
      product_intel: bundle || analysis,
      source_refs: row.source_refs,
    },
    {
      productRef,
      sourceType: 'product_intel_kb',
      sourceName: row.source || row.kb_key || 'aurora_product_intel_kb',
      observedAt: row.last_success_at || row.updated_at || row.created_at,
      authoritative: true,
      evidenceGrade: 'B',
    },
  );
}

function normalizeIngredientKbRow(row = {}, options = {}) {
  const table = normalizeString(options.table || row.table || 'ingredient_kb', 120);
  return normalizeProductCandidateSnapshot(
    {
      ...row,
      product_ref: pickFirstString(row.product_ref, row.sku_key, row.product_key, row.source_ref),
      name: pickFirstString(row.product_name, row.name, row.product_key, row.sku_key),
      description: [row.raw_ingredient_text_clean, row.inci_list, row.raw_inci].filter(Boolean).join(' '),
      source_refs: row.source_refs,
    },
    {
      sourceType: 'ingredient_kb',
      sourceName: table,
      observedAt: row.updated_at || row.created_at,
      authoritative: true,
      evidenceGrade: row.ingest_allowed === true || normalizeLower(row.parse_status) === 'ok' ? 'B' : 'C',
    },
  );
}

function normalizeLegacyDupeCandidate(item, row, relationHint) {
  const candidate = normalizeProductCandidateSnapshot(item, {
    sourceType: 'aurora_dupe_kb',
    sourceName: row.kb_key || row.source || 'aurora_dupe_kb',
    observedAt: row.verified_at || row.updated_at || row.created_at,
    authoritative: row.verified === true,
    evidenceGrade: row.verified === true ? 'A' : 'B',
  });
  if (!candidate) return null;
  return {
    ...candidate,
    relation_hint: relationHint,
    legacy_dupe_kb_key: normalizeString(row.kb_key, 256),
  };
}

function normalizeLegacyDupeKbRow(row = {}) {
  const sourceRow = asPlainObject(row) || {};
  const original = normalizeProductCandidateSnapshot(sourceRow.original || { product_ref: sourceRow.kb_key }, {
    sourceType: 'aurora_dupe_kb',
    sourceName: sourceRow.kb_key || sourceRow.source || 'aurora_dupe_kb',
    observedAt: sourceRow.verified_at || sourceRow.updated_at || sourceRow.created_at,
    authoritative: sourceRow.verified === true,
    evidenceGrade: sourceRow.verified === true ? 'A' : 'B',
  });
  const dupes = (Array.isArray(sourceRow.dupes) ? sourceRow.dupes : coerceJson(sourceRow.dupes) || [])
    .map((item) => normalizeLegacyDupeCandidate(item, sourceRow, 'dupe'))
    .filter(Boolean);
  const comparables = (Array.isArray(sourceRow.comparables) ? sourceRow.comparables : coerceJson(sourceRow.comparables) || [])
    .map((item) => normalizeLegacyDupeCandidate(item, sourceRow, 'competitive_alternative'))
    .filter(Boolean);
  return {
    kb_key: normalizeString(sourceRow.kb_key, 256),
    original,
    dupes,
    comparables,
    verified: sourceRow.verified === true,
    verified_at: toIsoOrNull(sourceRow.verified_at),
    source: normalizeString(sourceRow.source || 'aurora_dupe_kb', 120),
    source_meta: firstObject(sourceRow.source_meta),
    updated_at: toIsoOrNull(sourceRow.updated_at),
  };
}

function isSourceMissingError(err) {
  const code = normalizeString(err && err.code, 20);
  if (SOURCE_MISSING_CODES.has(code)) return true;
  const msg = normalizeLower(err && (err.message || err.detail || err.toString()), 1000);
  return (
    /relation .* does not exist/.test(msg) ||
    /schema .* does not exist/.test(msg) ||
    /column .* does not exist/.test(msg) ||
    /type .*vector.* does not exist/.test(msg) ||
    /extension .*vector.* is not available/.test(msg)
  );
}

async function guardedRows(queryFn, sql, params = []) {
  if (typeof queryFn !== 'function') return [];
  try {
    const res = await queryFn(sql, params);
    return Array.isArray(res?.rows) ? res.rows : [];
  } catch (err) {
    if (isSourceMissingError(err)) return [];
    throw err;
  }
}

async function tableExists(queryFn, regclassName) {
  const rows = await guardedRows(queryFn, `SELECT to_regclass($1) AS table_name`, [regclassName]);
  return Boolean(rows?.[0]?.table_name);
}

async function loadProductsCacheCandidates({ queryFn, limit = DEFAULT_SOURCE_LIMIT } = {}) {
  const rows = await guardedRows(
    queryFn,
    `
      SELECT
        COALESCE(
          NULLIF(platform_product_id, ''),
          NULLIF(product_data->>'product_id', ''),
          NULLIF(product_data->>'id', ''),
          id::text
        ) AS product_ref,
        product_data,
        cached_at,
        updated_at
      FROM products_cache
      WHERE lower(to_jsonb(product_data)::text) LIKE ANY($2::text[])
      ORDER BY cached_at DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
      LIMIT $1
    `,
    [normalizeLimit(limit), BEAUTY_TEXT_PATTERNS],
  );
  return rows.map(normalizeProductsCacheRow).filter(Boolean);
}

async function loadExternalProductSeedCandidates({ queryFn, limit = DEFAULT_SOURCE_LIMIT, market = DEFAULT_MARKET } = {}) {
  const normalizedMarket = normalizeMarket(market);
  const rows = await guardedRows(
    queryFn,
    `
      SELECT
        id,
        external_product_id,
        attached_product_key,
        title,
        category,
        price_amount,
        price_currency,
        market,
        canonical_url,
        destination_url,
        seed_data,
        updated_at,
        created_at
      FROM external_product_seeds
      WHERE COALESCE(status, 'active') = 'active'
        AND upper(COALESCE(market, $2)) = $2
        AND (
          lower(COALESCE(title, '')) LIKE ANY($3::text[])
          OR lower(COALESCE(category, '')) LIKE ANY($3::text[])
          OR lower(to_jsonb(seed_data)::text) LIKE ANY($3::text[])
        )
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id ASC
      LIMIT $1
    `,
    [normalizeLimit(limit), normalizedMarket, BEAUTY_TEXT_PATTERNS],
  );
  return rows.map(normalizeExternalProductSeedRow).filter(Boolean);
}

async function loadProductIntelKbRows({ queryFn, limit = DEFAULT_SOURCE_LIMIT } = {}) {
  const rows = await guardedRows(
    queryFn,
    `
      SELECT
        kb_key,
        analysis,
        source,
        source_meta,
        last_success_at,
        created_at,
        updated_at
      FROM aurora_product_intel_kb
      WHERE analysis IS NOT NULL
      ORDER BY last_success_at DESC NULLS LAST, updated_at DESC NULLS LAST, kb_key ASC
      LIMIT $1
    `,
    [normalizeLimit(limit)],
  );
  return rows.map(normalizeProductIntelKbRow).filter(Boolean);
}

async function loadIngredientKbCandidates({ queryFn, limit = DEFAULT_SOURCE_LIMIT } = {}) {
  const perTableLimit = normalizeLimit(limit);
  const out = [];
  if (await tableExists(queryFn, 'public.beauty_sku_ingredients')) {
    const rows = await guardedRows(
      queryFn,
      `
        SELECT
          sku_key,
          product_key,
          merchant_id,
          raw_inci,
          normalized_ingredients_json,
          active_ingredients_json,
          evidence_refs_json,
          source_system,
          created_at,
          updated_at
        FROM public.beauty_sku_ingredients
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, sku_key ASC
        LIMIT $1
      `,
      [perTableLimit],
    );
    out.push(...rows.map((row) => normalizeIngredientKbRow(row, { table: 'public.beauty_sku_ingredients' })).filter(Boolean));
  }
  if (await tableExists(queryFn, 'pci_kb.sku_ingredients')) {
    const rows = await guardedRows(
      queryFn,
      `
        SELECT
          sku_key,
          market,
          brand,
          product_name,
          source_ref,
          parse_status,
          review_status,
          audit_status,
          ingest_allowed,
          raw_ingredient_text_clean,
          inci_list,
          created_at
        FROM pci_kb.sku_ingredients
        WHERE (
          ingest_allowed = TRUE
          OR upper(COALESCE(parse_status, '')) = 'OK'
        )
          AND lower(COALESCE(review_status, '')) NOT IN ('reject', 'rejected', 'blocked', 'failed')
          AND lower(COALESCE(audit_status, '')) NOT IN ('reject', 'rejected', 'blocked', 'failed')
        ORDER BY created_at DESC NULLS LAST, sku_key ASC
        LIMIT $1
      `,
      [perTableLimit],
    );
    out.push(...rows.map((row) => normalizeIngredientKbRow(row, { table: 'pci_kb.sku_ingredients' })).filter(Boolean));
  }
  return dedupeNormalizedProducts(out);
}

async function loadLegacyDupeKbRows({ queryFn, limit = DEFAULT_SOURCE_LIMIT } = {}) {
  const rows = await guardedRows(
    queryFn,
    `
      SELECT
        kb_key,
        original,
        dupes,
        comparables,
        verified,
        verified_at,
        verified_by,
        source,
        source_meta,
        created_at,
        updated_at
      FROM aurora_dupe_kb
      WHERE verified = TRUE OR verified_at IS NOT NULL
      ORDER BY verified_at DESC NULLS LAST, updated_at DESC NULLS LAST, kb_key ASC
      LIMIT $1
    `,
    [normalizeLimit(limit)],
  );
  return rows.map(normalizeLegacyDupeKbRow).filter((row) => row.original || row.dupes.length || row.comparables.length);
}

function vectorLiteral(vec) {
  return `[${vec.map((n) => Number(n)).filter((n) => Number.isFinite(n)).join(',')}]`;
}

async function loadProductsCacheVectorRecallCandidates({
  queryFn,
  queryVector,
  limit = 200,
} = {}) {
  if (!Array.isArray(queryVector) || !queryVector.length) return [];
  const dim = queryVector.length;
  const col = dim === 768 ? 'embedding_768' : dim === 1536 ? 'embedding_1536' : '';
  if (!col) return [];
  const rows = await guardedRows(
    queryFn,
    `
      SELECT
        COALESCE(
          NULLIF(pc.platform_product_id, ''),
          NULLIF(pc.product_data->>'product_id', ''),
          NULLIF(pc.product_data->>'id', ''),
          pc.id::text
        ) AS product_ref,
        pc.product_data,
        pc.cached_at,
        pc.updated_at,
        1 - (pce.${col} <=> $1::vector) AS vector_score
      FROM products_cache_embeddings pce
      JOIN products_cache pc
        ON COALESCE(NULLIF(pc.platform_product_id, ''), NULLIF(pc.product_data->>'product_id', ''), pc.id::text) = pce.product_id
      WHERE pce.${col} IS NOT NULL
      ORDER BY pce.${col} <=> $1::vector
      LIMIT $2
    `,
    [vectorLiteral(queryVector), normalizeLimit(limit, 200)],
  );
  return rows.map((row) => ({
    ...normalizeProductCandidateSnapshot(row, {
      sourceType: 'vector_recall',
      sourceName: 'products_cache_embeddings',
      observedAt: row.updated_at || row.cached_at,
      authoritative: false,
      evidenceGrade: 'C',
    }),
    vector_score: clamp01(row.vector_score, 0),
  })).filter((row) => row && row.product_ref);
}

function productIdentityKeys(product = {}) {
  const item = normalizeProductCandidateSnapshot(product) || product;
  const keys = [];
  const push = (prefix, value) => {
    const text = normalizeLower(value, 512);
    if (!text) return;
    keys.push(`${prefix}:${text}`);
  };
  push('ref', item.product_ref);
  push('id', item.product_id || item.productId || item.id || String(item.product_ref || '').replace(/^[a-z][a-z0-9_+-]*:/i, ''));
  push('family', item.product_family_id || item.productFamilyId || item.product_line_id || item.productLineId || item.variant_of || item.variantOf);
  push('url', item.url || item.canonical_url || item.canonicalUrl || item.pdp_url || item.pdpUrl);
  const brand = pickFirstString(item.brand, item.brand_name, item.brandName, item.vendor);
  const name = pickFirstString(item.name, item.title, item.product_name, item.productName);
  if (brand && name) push('text', `${brand}:${name}`);
  else if (name) push('name', name);
  return Array.from(new Set(keys));
}

function familyIdentityKey(product = {}) {
  const item = normalizeProductCandidateSnapshot(product) || product;
  const family = pickFirstString(
    item.product_family_id,
    item.productFamilyId,
    item.product_line_id,
    item.productLineId,
    item.variant_of,
    item.variantOf,
  );
  if (family) return `family:${normalizeLower(family, 512)}`;
  const brand = pickFirstString(item.brand, item.brand_name, item.brandName, item.vendor);
  const name = pickFirstString(item.name, item.title, item.product_name, item.productName);
  if (brand && name) return `text:${normalizeLower(`${brand}:${name}`, 512)}`;
  if (item.url) return `url:${normalizeLower(item.url, 512)}`;
  return `ref:${normalizeLower(item.product_ref, 512)}`;
}

function tokenSet(value) {
  const text = normalizeTokenText(value).toLowerCase();
  return new Set(text.split(/[^a-z0-9]+/g).filter((token) => token.length >= 3));
}

function overlapScore(left, right) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const token of a) {
    if (b.has(token)) hits += 1;
  }
  return hits / Math.max(a.size, b.size);
}

function hasIntersectingIdentity(left, right) {
  const a = new Set(productIdentityKeys(left));
  for (const key of productIdentityKeys(right)) {
    if (a.has(key)) return true;
  }
  return false;
}

function buildIntelIndex(intelRows = []) {
  const index = new Map();
  for (const raw of Array.isArray(intelRows) ? intelRows : []) {
    const intel = normalizeProductIntelKbRow(raw) || normalizeProductCandidateSnapshot(raw);
    if (!intel) continue;
    for (const key of productIdentityKeys(intel)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(intel);
    }
  }
  return index;
}

function findIntelForCandidate(candidate, intelIndex) {
  if (!intelIndex || typeof intelIndex.get !== 'function') return [];
  const matches = [];
  const seen = new Set();
  for (const key of productIdentityKeys(candidate)) {
    for (const row of intelIndex.get(key) || []) {
      const ref = row.product_ref || key;
      if (seen.has(ref)) continue;
      seen.add(ref);
      matches.push(row);
    }
  }
  return matches;
}

function mergeCandidateWithIntel(candidate, intelRows) {
  let out = { ...candidate };
  for (const intel of intelRows) {
    out = {
      ...out,
      source_refs: mergeSourceRefs(out.source_refs, intel.source_refs),
      evidence_grade: betterEvidenceGrade(out.evidence_grade, intel.evidence_grade),
      product_intel: out.product_intel || intel.product_intel,
      intel_text: [out.intel_text, intel.intel_text, intel.description].map((item) => normalizeString(item, 2000)).filter(Boolean).join(' '),
      description: [out.description, intel.description, intel.intel_text].map((item) => normalizeString(item, 2000)).filter(Boolean).join(' '),
      category: out.category || intel.category,
      category_taxonomy: normalizeCategoryTaxonomy(out.category_taxonomy, intel.category_taxonomy),
    };
  }
  return out;
}

function normalizeLegacyRows(legacyDupes = []) {
  return (Array.isArray(legacyDupes) ? legacyDupes : [])
    .map((row) => {
      if (row && Array.isArray(row.dupes) && Array.isArray(row.comparables) && row.original !== undefined) {
        return row;
      }
      return normalizeLegacyDupeKbRow(row);
    })
    .filter(Boolean);
}

function legacySignalsForAnchor(anchor, legacyRows) {
  const explicitCandidates = [];
  const candidateKeys = new Set();
  for (const row of legacyRows) {
    const original = row.original || { product_ref: row.kb_key };
    const rowMatchesAnchor =
      hasIntersectingIdentity(anchor, original) ||
      normalizeLower(row.kb_key) === normalizeLower(anchor.product_ref);
    if (!rowMatchesAnchor) continue;
    for (const candidate of [...(row.dupes || []), ...(row.comparables || [])]) {
      explicitCandidates.push(candidate);
      for (const key of productIdentityKeys(candidate)) candidateKeys.add(key);
    }
  }
  return { explicitCandidates, candidateKeys };
}

function scoreCandidateForAnchor(anchor, candidate, { legacyMatch = false, intelMatch = false } = {}) {
  const anchorText = [
    anchor.name,
    anchor.category,
    normalizeTokenText(anchor.category_taxonomy),
    anchor.description,
    anchor.ingredient_text,
    normalizeTokenText(anchor.tags),
  ].filter(Boolean).join(' ');
  const candidateText = [
    candidate.name,
    candidate.category,
    normalizeTokenText(candidate.category_taxonomy),
    candidate.description,
    candidate.ingredient_text,
    normalizeTokenText(candidate.tags),
    candidate.intel_text,
  ].filter(Boolean).join(' ');
  const nameScore = overlapScore(anchor.name, candidate.name);
  const categoryScoreBase = Math.max(
    overlapScore(anchor.category, candidate.category),
    overlapScore(anchor.category_taxonomy, candidate.category_taxonomy),
    overlapScore(anchor.name, candidate.category),
    nameScore * 0.65,
  );
  const exactCategory =
    normalizeLower(anchor.category) &&
    normalizeLower(anchor.category) === normalizeLower(candidate.category);
  const categoryUseCase = clamp01(
    Math.max(categoryScoreBase, exactCategory ? 0.72 : 0) +
      (legacyMatch ? 0.12 : 0) +
      (intelMatch ? 0.05 : 0),
    0,
  );
  const ingredientScore = Math.max(
    overlapScore(anchor.ingredient_text, candidate.ingredient_text),
    overlapScore(anchor.description, candidate.description),
    overlapScore(anchor.tags, candidate.tags),
    overlapScore(anchorText, candidateText) * 0.75,
    categoryUseCase * 0.72,
  );
  const sourceBonus = sourceStrength(candidate.source_refs);
  const explicitScore = clamp01(candidate.similarity_score ?? candidate.score_total ?? candidate.vector_score, 0);
  const similarityScore = clamp01(
    Math.max(explicitScore, categoryUseCase, ingredientScore, nameScore) +
      sourceBonus +
      (legacyMatch ? 0.12 : 0) +
      (intelMatch ? 0.05 : 0),
    0,
  );
  const anchorPrice = toNumberOrNull(anchor.price);
  const candidatePrice = toNumberOrNull(candidate.price);
  const priceAdvantage = anchorPrice != null && candidatePrice != null && anchorPrice > 0
    ? clamp01(1 - Math.min(candidatePrice / anchorPrice, 1), 0)
    : 0;

  return {
    category_use_case_match: Number(categoryUseCase.toFixed(4)),
    ingredient_functional_similarity: Number(clamp01(ingredientScore + (sourceTypesFromRefs(candidate.source_refs).includes('ingredient_kb') ? 0.05 : 0), 0).toFixed(4)),
    price_advantage: Number(priceAdvantage.toFixed(4)),
    evidence_quality: Number(clamp01(0.62 + sourceBonus + (legacyMatch ? 0.08 : 0), 0).toFixed(4)),
    availability_confidence: Number(clamp01(0.66 + (candidatePrice != null ? 0.08 : 0) + sourceBonus / 2, 0).toFixed(4)),
    social_reference_strength: sourceTypesFromRefs(candidate.source_refs).includes('product_intel_kb') ? 0.2 : 0,
    score_total: Number(similarityScore.toFixed(4)),
  };
}

function shouldKeepScoredCandidate(candidate, score, legacyMatch) {
  if (legacyMatch) return true;
  if (score.category_use_case_match >= 0.35) return true;
  if (score.score_total >= 0.45) return true;
  return sourceTypesFromRefs(candidate.source_refs).includes('product_intel_kb') && score.score_total >= 0.35;
}

function compareScoredCandidates(a, b) {
  const scoreDelta = Number(b.similarity_score || b.score_total || 0) - Number(a.similarity_score || a.score_total || 0);
  if (Math.abs(scoreDelta) > 0.0001) return scoreDelta;
  const catDelta = Number(b.category_use_case_match || 0) - Number(a.category_use_case_match || 0);
  if (Math.abs(catDelta) > 0.0001) return catDelta;
  const gradeDelta = (EVIDENCE_GRADE_RANK[normalizeEvidenceGrade(b.evidence_grade)] || 0) - (EVIDENCE_GRADE_RANK[normalizeEvidenceGrade(a.evidence_grade)] || 0);
  if (gradeDelta) return gradeDelta;
  const priceA = toNumberOrNull(a.price);
  const priceB = toNumberOrNull(b.price);
  if (priceA != null && priceB != null && priceA !== priceB) return priceA - priceB;
  return normalizeLower(a.product_ref).localeCompare(normalizeLower(b.product_ref));
}

function mergeDuplicateCandidate(existing, candidate) {
  if (!existing) return candidate;
  const preferred = compareScoredCandidates(existing, candidate) <= 0 ? existing : candidate;
  const secondary = preferred === existing ? candidate : existing;
  return {
    ...secondary,
    ...preferred,
    source_refs: mergeSourceRefs(existing.source_refs, candidate.source_refs),
    evidence_grade: betterEvidenceGrade(existing.evidence_grade, candidate.evidence_grade),
    category_taxonomy: normalizeCategoryTaxonomy(existing.category_taxonomy, candidate.category_taxonomy),
    tags: normalizeTextList([existing.tags, candidate.tags].flat(), 32),
    description: pickFirstString(preferred.description, secondary.description),
    ingredient_text: pickFirstString(preferred.ingredient_text, secondary.ingredient_text),
    intel_text: [existing.intel_text, candidate.intel_text].map((item) => normalizeString(item, 2000)).filter(Boolean).join(' '),
  };
}

function dedupeNormalizedProducts(products = []) {
  const byKey = new Map();
  for (const raw of Array.isArray(products) ? products : []) {
    const product = normalizeProductCandidateSnapshot(raw);
    if (!product) continue;
    const key = familyIdentityKey(product);
    byKey.set(key, mergeDuplicateCandidate(byKey.get(key), product));
  }
  return Array.from(byKey.values()).sort((a, b) => normalizeLower(a.product_ref).localeCompare(normalizeLower(b.product_ref)));
}

function buildCandidatesByAnchorFromSources({
  anchors = [],
  products = [],
  legacyDupes = [],
  intelRows = [],
  maxPerAnchor = 24,
  includeTransitiveRecall = true,
  maxBridgePerAnchor = 8,
  maxBridgeCandidates = 8,
  maxTransitivePerAnchor = 8,
} = {}) {
  const normalizedAnchors = (Array.isArray(anchors) ? anchors : [])
    .map((anchor) => normalizeProductCandidateSnapshot(anchor))
    .filter(Boolean);
  const normalizedProducts = (Array.isArray(products) ? products : [])
    .map((product) => normalizeProductCandidateSnapshot(product))
    .filter(Boolean);
  const normalizedIntelRows = (Array.isArray(intelRows) ? intelRows : [])
    .map((row) => normalizeProductIntelKbRow(row) || normalizeProductCandidateSnapshot(row))
    .filter(Boolean);
  const intelIndex = buildIntelIndex(normalizedIntelRows);
  const legacyRows = normalizeLegacyRows(legacyDupes);
  const out = {};

  for (const anchor of normalizedAnchors) {
    const legacy = legacySignalsForAnchor(anchor, legacyRows);
    const rawPool = [...normalizedProducts, ...normalizedIntelRows, ...legacy.explicitCandidates];
    const byFamily = new Map();
    const identityToFamilyKey = new Map();
    for (const rawCandidate of rawPool) {
      const baseCandidate = normalizeProductCandidateSnapshot(rawCandidate);
      if (!baseCandidate) continue;
      if (hasIntersectingIdentity(anchor, baseCandidate)) continue;
      const intelMatches = findIntelForCandidate(baseCandidate, intelIndex);
      const enriched = mergeCandidateWithIntel(baseCandidate, intelMatches);
      const candidateKeys = productIdentityKeys(enriched);
      const legacyMatch = candidateKeys.some((key) => legacy.candidateKeys.has(key));
      const score = scoreCandidateForAnchor(anchor, enriched, {
        legacyMatch,
        intelMatch: intelMatches.length > 0 || sourceTypesFromRefs(enriched.source_refs).includes('product_intel_kb'),
      });
      if (!shouldKeepScoredCandidate(enriched, score, legacyMatch)) continue;
      const scored = {
        ...enriched,
        ...score,
        similarity_score: score.score_total,
        score_breakdown: score,
        source_refs: mergeSourceRefs(
          enriched.source_refs,
          legacyMatch ? { type: 'aurora_dupe_kb', name: 'legacy_match', authoritative: true } : null,
        ),
        why_candidate: {
          summary: legacyMatch
            ? 'Legacy dupe/comparable evidence plus source overlap.'
            : 'Source overlap across category, product text, ingredient, or product-intel evidence.',
          reasons_user_visible: [
            'Category or use-case evidence is aligned.',
            'Candidate source provenance is available.',
          ],
        },
      };
      const identityKeys = productIdentityKeys(scored);
      const existingKey = identityKeys.map((key) => identityToFamilyKey.get(key)).find(Boolean);
      const key = existingKey || familyIdentityKey(scored);
      byFamily.set(key, mergeDuplicateCandidate(byFamily.get(key), scored));
      for (const identityKey of identityKeys) identityToFamilyKey.set(identityKey, key);
    }
    out[anchor.product_ref] = Array.from(byFamily.values())
      .sort(compareScoredCandidates)
      .slice(0, Math.max(1, Number(maxPerAnchor) || 24));
  }

  if (!includeTransitiveRecall) return out;
  return augmentCandidatesWithTransitiveRecall({
    anchors: normalizedAnchors,
    candidatesByAnchor: out,
    maxPerAnchor,
    maxBridgePerAnchor,
    maxBridgeCandidates,
    maxTransitivePerAnchor,
  });
}

function candidateMapList(candidatesByAnchor, productRef) {
  const normalizedRef = normalizeProductRef(productRef);
  return (
    candidatesByAnchor[normalizedRef] ||
    candidatesByAnchor[String(normalizedRef).replace(/^product:/, '')] ||
    candidatesByAnchor[normalizeLower(normalizedRef)] ||
    []
  );
}

function normalizeCandidatePreservingFields(input) {
  const normalized = normalizeProductCandidateSnapshot(input);
  if (!normalized) return null;
  return {
    ...normalized,
    ...(isPlainObject(input) ? input : {}),
    product_ref: normalized.product_ref,
    product_id: normalized.product_id,
    brand: normalized.brand,
    name: normalized.name,
    category: normalized.category,
    category_taxonomy: normalizeCategoryTaxonomy(
      isPlainObject(input) ? input.category_taxonomy || input.categoryTaxonomy : null,
      normalized.category_taxonomy,
    ),
    source_refs: mergeSourceRefs(isPlainObject(input) ? input.source_refs || input.sourceRefs : null, normalized.source_refs),
    tags: normalizeTextList([isPlainObject(input) ? input.tags : null, normalized.tags].flat(), 32),
  };
}

function sourceHasProductIntel(candidate) {
  return sourceTypesFromRefs(candidate.source_refs).includes('product_intel_kb');
}

function buildTransitiveRecallCandidate({ anchor, bridge, candidate } = {}) {
  const anchorToBridge = clamp01(bridge?.similarity_score ?? bridge?.score_total, 0);
  const bridgeToCandidate = clamp01(candidate?.similarity_score ?? candidate?.score_total, 0);
  const hopConfidence = Math.sqrt(anchorToBridge * bridgeToCandidate);
  if (hopConfidence < 0.55) return null;

  const baseScore = scoreCandidateForAnchor(anchor, candidate, {
    intelMatch: sourceHasProductIntel(candidate),
  });
  if (baseScore.category_use_case_match < 0.25 && baseScore.score_total < 0.35) return null;

  const categoryUseCase = clamp01(Math.max(
    baseScore.category_use_case_match,
    Math.min(
      clamp01(bridge.category_use_case_match, 0),
      clamp01(candidate.category_use_case_match, 0),
    ) * 0.85,
  ));
  const ingredientSimilarity = clamp01(Math.max(
    baseScore.ingredient_functional_similarity,
    Math.min(
      clamp01(bridge.ingredient_functional_similarity, 0),
      clamp01(candidate.ingredient_functional_similarity, 0),
    ) * 0.85,
  ));
  const scoreTotal = clamp01(Math.max(
    baseScore.score_total,
    categoryUseCase,
    ingredientSimilarity,
    hopConfidence * 0.92,
  ));
  const transitiveScore = {
    ...baseScore,
    category_use_case_match: Number(categoryUseCase.toFixed(4)),
    ingredient_functional_similarity: Number(ingredientSimilarity.toFixed(4)),
    evidence_quality: Number(clamp01(Math.max(baseScore.evidence_quality, 0.68)).toFixed(4)),
    availability_confidence: Number(clamp01(baseScore.availability_confidence).toFixed(4)),
    social_reference_strength: Number(clamp01(baseScore.social_reference_strength).toFixed(4)),
    score_total: Number(scoreTotal.toFixed(4)),
    transitive_path_confidence: Number(hopConfidence.toFixed(4)),
  };

  return {
    ...candidate,
    ...transitiveScore,
    similarity_score: transitiveScore.score_total,
    score_breakdown: transitiveScore,
    source_refs: mergeSourceRefs(
      candidate.source_refs,
      bridge.source_refs,
      {
        type: 'relationship_graph_transitive_recall',
        name: 'two_hop_candidate',
        authoritative: false,
      },
    ),
    transitive_bridge_ref: bridge.product_ref,
    transitive_path_confidence: transitiveScore.transitive_path_confidence,
    why_candidate: {
      summary: 'Two-hop recall candidate surfaced through another inter-related product; requires normal review before publish.',
      reasons_user_visible: [
        'Candidate is connected through an already plausible intermediate product.',
        'Direct category/use-case evidence is still checked before review.',
      ],
    },
  };
}

function augmentCandidatesWithTransitiveRecall({
  anchors = [],
  candidatesByAnchor = {},
  maxPerAnchor = 24,
  maxBridgePerAnchor = 8,
  maxBridgeCandidates = 8,
  maxTransitivePerAnchor = 8,
} = {}) {
  const normalizedAnchors = (Array.isArray(anchors) ? anchors : [])
    .map((anchor) => normalizeCandidatePreservingFields(anchor))
    .filter(Boolean);
  const out = {};
  for (const [key, value] of Object.entries(candidatesByAnchor || {})) {
    const normalizedRef = normalizeProductRef(key);
    out[normalizedRef] = (Array.isArray(value) ? value : [])
      .map((candidate) => normalizeCandidatePreservingFields(candidate))
      .filter(Boolean)
      .sort(compareScoredCandidates)
      .slice(0, Math.max(1, Number(maxPerAnchor) || 24));
  }

  for (const anchor of normalizedAnchors) {
    const anchorRef = anchor.product_ref;
    const directList = candidateMapList(out, anchorRef);
    if (!directList.length) {
      out[anchorRef] = [];
      continue;
    }

    const anchorIdentity = new Set(productIdentityKeys(anchor));
    const directIdentity = new Set(directList.flatMap((candidate) => productIdentityKeys(candidate)));
    const transitiveByFamily = new Map();
    const bridges = directList
      .filter((bridge) => normalizeProductRef(bridge.product_ref) !== anchorRef)
      .slice(0, Math.max(1, Number(maxBridgePerAnchor) || 8));

    for (const bridge of bridges) {
      const bridgeList = candidateMapList(out, bridge.product_ref)
        .filter((candidate) => !hasIntersectingIdentity(bridge, candidate))
        .slice(0, Math.max(1, Number(maxBridgeCandidates) || 8));
      for (const secondHop of bridgeList) {
        const secondHopKeys = productIdentityKeys(secondHop);
        if (secondHopKeys.some((key) => anchorIdentity.has(key) || directIdentity.has(key))) continue;
        const transitive = buildTransitiveRecallCandidate({ anchor, bridge, candidate: secondHop });
        if (!transitive) continue;
        const familyKey = familyIdentityKey(transitive);
        transitiveByFamily.set(familyKey, mergeDuplicateCandidate(transitiveByFamily.get(familyKey), transitive));
      }
    }

    const transitiveRows = Array.from(transitiveByFamily.values())
      .sort(compareScoredCandidates)
      .slice(0, Math.max(0, Number(maxTransitivePerAnchor) || 0));
    const combinedByFamily = new Map();
    for (const row of directList) {
      combinedByFamily.set(familyIdentityKey(row), mergeDuplicateCandidate(combinedByFamily.get(familyIdentityKey(row)), row));
    }
    for (const row of transitiveRows) {
      combinedByFamily.set(familyIdentityKey(row), mergeDuplicateCandidate(combinedByFamily.get(familyIdentityKey(row)), row));
    }
    out[anchorRef] = Array.from(combinedByFamily.values())
      .sort(compareScoredCandidates)
      .slice(0, Math.max(1, Number(maxPerAnchor) || 24) + Math.max(0, Number(maxTransitivePerAnchor) || 0));
  }

  return out;
}

async function loadProductRelationshipGraphSourceInputs({
  queryFn,
  limit = DEFAULT_SOURCE_LIMIT,
  market = DEFAULT_MARKET,
  queryVector,
} = {}) {
  const sourceLimit = normalizeLimit(limit);
  const productsCache = await loadProductsCacheCandidates({ queryFn, limit: sourceLimit * 4 });
  const externalSeeds = await loadExternalProductSeedCandidates({ queryFn, limit: sourceLimit * 3, market });
  const ingredientRows = await loadIngredientKbCandidates({ queryFn, limit: sourceLimit * 2 });
  const intelRows = await loadProductIntelKbRows({ queryFn, limit: sourceLimit * 2 });
  const legacyDupes = await loadLegacyDupeKbRows({ queryFn, limit: sourceLimit * 2 });
  const vectorRows = await loadProductsCacheVectorRecallCandidates({ queryFn, queryVector, limit: sourceLimit });
  const products = dedupeNormalizedProducts([
    ...productsCache,
    ...externalSeeds,
    ...ingredientRows,
    ...vectorRows,
    ...intelRows,
  ]);
  return {
    products,
    productsCache,
    externalSeeds,
    ingredientRows,
    intelRows,
    legacyDupes,
    vectorRows,
    source_counts: {
      products_cache: productsCache.length,
      external_product_seeds: externalSeeds.length,
      ingredient_kb: ingredientRows.length,
      product_intel_kb: intelRows.length,
      aurora_dupe_kb: legacyDupes.length,
      vector_recall: vectorRows.length,
      products: products.length,
    },
  };
}

module.exports = {
  isSourceMissingError,
  normalizeProductCandidateSnapshot,
  normalizeProductsCacheRow,
  normalizeExternalProductSeedRow,
  normalizeProductIntelKbRow,
  normalizeIngredientKbRow,
  normalizeLegacyDupeKbRow,
  augmentCandidatesWithTransitiveRecall,
  dedupeNormalizedProducts,
  buildCandidatesByAnchorFromSources,
  loadProductsCacheCandidates,
  loadExternalProductSeedCandidates,
  loadProductIntelKbRows,
  loadIngredientKbCandidates,
  loadLegacyDupeKbRows,
  loadProductsCacheVectorRecallCandidates,
  loadProductRelationshipGraphSourceInputs,
  __internal: {
    BEAUTY_TEXT_PATTERNS,
    SOURCE_PRIORITY,
    clamp01,
    compareScoredCandidates,
    familyIdentityKey,
    buildTransitiveRecallCandidate,
    inferBrandFromOfficialUrl,
    mergeSourceRefs,
    overlapScore,
    productIdentityKeys,
    scoreCandidateForAnchor,
    sourceStrength,
    tableExists,
  },
};
