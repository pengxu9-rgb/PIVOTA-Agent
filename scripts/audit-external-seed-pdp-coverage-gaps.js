#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query, getPool } = require('../src/db');
const { ensureJsonObject } = require('../src/services/externalSeedProducts');

const FORMULA_RE =
  /\b(skincare|skin care|makeup|cosmetic|haircare|hair care|fragrance|perfume|parfum|cologne|cleanser|toner|essence|serum|ampoule|moisturi[sz]er|cream|lotion|balm|mask|peel|exfoliant|treatment|oil|sunscreen|spf|foundation|concealer|mascara|lip(?:stick| gloss| balm| oil)?|blush|bronzer|powder|highlighter|eyeshadow|eyeliner|brow|primer|setting spray|shampoo|conditioner|body wash|body lotion|deodorant)\b/i;
const ACCESSORY_RE =
  /\b(brush|sponge|puff|applicator|sharpener|tweezer|curler|scissors|comb|mirror|case|bag|pouch|holder|spatula|tool|tools|gua sha|roller|headband|clip|clips|lash curler|refill case)\b/i;
const NON_MERCH_RE = /\b(e-?gift card|gift card|donat(?:e|ion)|sample service|appointment|booking)\b/i;
const BUNDLE_RE = /\b(bundle|set|kit|duo|trio|routine|collection|mini set|travel set|starter set|value set)\b/i;
const FRAGRANCE_RE = /\b(fragrance|perfume|parfum|eau de|edt|edp|cologne|body mist|mist|candle)\b/i;
const HAIR_RE = /\b(hair|shampoo|conditioner|scalp|leave-in|styling|curl|detangler)\b/i;
const MAKEUP_RE =
  /\b(makeup|foundation|concealer|mascara|lipstick|lip gloss|lip oil|blush|bronzer|powder|highlighter|eyeshadow|eyeliner|brow|primer|setting spray|tint|shade|palette)\b/i;
const SKINCARE_RE =
  /\b(skincare|skin care|cleanser|toner|essence|serum|ampoule|moisturi[sz]er|cream|lotion|balm|mask|peel|exfoliant|treatment|oil|sunscreen|spf|retinol|vitamin c|niacinamide|acid|salicylic|benzoyl|azelaic|ceramide|hyaluronic)\b/i;
const REGULATORY_ACTIVE_RE =
  /\b(sunscreen|spf|sun screen|uv|pa\+|acne|benzoyl peroxide|salicylic acid|zinc oxide|titanium dioxide|avobenzone|octocrylene|octisalate|homosalate|octinoxate|adapalene)\b/i;
const SOURCE_BLOCKED_RE = /\b(no_product_urls|missing_target_url|bot_challenge|timeout|http_404|not_found|navigation_failed|extractor_failure)\b/i;
const PRODUCT_URL_RE = /(?:\/products?\/|\/p\/|\/product\/|\.html(?:[?#]|$))/i;

const FIELD_NAMES = Object.freeze([
  'product_key_kb',
  'identity',
  'details_sections',
  'faq',
  'how_to',
  'inci',
  'active_ingredients',
]);

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function pickFirstString(...values) {
  for (const value of values) {
    const normalized = normalizeNonEmptyString(value);
    if (normalized) return normalized;
  }
  return '';
}

function collectSeedText(row = {}) {
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  return [
    row.title,
    row.domain,
    row.canonical_url,
    row.destination_url,
    seedData.brand,
    snapshot.brand,
    seedData.category,
    snapshot.category,
    seedData.product_type,
    snapshot.product_type,
    seedData.productType,
    snapshot.productType,
    seedData.tags,
    snapshot.tags,
  ]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => normalizeNonEmptyString(value))
    .filter(Boolean)
    .join(' ');
}

function classifyProductContext(row = {}) {
  const text = collectSeedText(row);
  const lowerUrl = [row.canonical_url, row.destination_url].map((value) => normalizeNonEmptyString(value)).join(' ');
  const nonMerchandise = NON_MERCH_RE.test(text);
  const accessory = ACCESSORY_RE.test(text);
  const bundle = BUNDLE_RE.test(text);
  const fragrance = FRAGRANCE_RE.test(text);
  const hair = HAIR_RE.test(text);
  const makeup = MAKEUP_RE.test(text);
  const skincare = SKINCARE_RE.test(text);
  const formula = !nonMerchandise && !accessory && (FORMULA_RE.test(text) || skincare || makeup || hair || fragrance);
  const regulatoryActiveExpected = REGULATORY_ACTIVE_RE.test(text);
  const productUrlLike = PRODUCT_URL_RE.test(lowerUrl);

  let product_family = 'unknown_product';
  if (nonMerchandise) product_family = 'non_merchandise';
  else if (accessory) product_family = 'tool_accessory';
  else if (bundle) product_family = 'set_or_bundle';
  else if (skincare) product_family = 'skincare';
  else if (makeup) product_family = 'makeup';
  else if (hair) product_family = 'haircare';
  else if (fragrance) product_family = 'fragrance';
  else if (formula) product_family = 'formula_product';

  return {
    product_family,
    formula,
    accessory,
    non_merchandise: nonMerchandise,
    bundle,
    fragrance,
    regulatory_active_expected: regulatoryActiveExpected,
    product_url_like: productUrlLike,
  };
}

function getSeedCoverage(row = {}) {
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const detailsSections = [
    ...asArray(seedData.pdp_details_sections),
    ...asArray(snapshot.pdp_details_sections),
    ...asArray(seedData.details_sections),
    ...asArray(snapshot.details_sections),
  ];
  const faqItems = [
    ...asArray(seedData.pdp_faq_items),
    ...asArray(snapshot.pdp_faq_items),
    ...asArray(seedData.faq_items),
    ...asArray(snapshot.faq_items),
  ];
  const description = pickFirstString(
    seedData.pdp_description_raw,
    snapshot.pdp_description_raw,
    seedData.description_raw,
    snapshot.description_raw,
    seedData.description,
    snapshot.description,
  );
  const howTo = pickFirstString(
    seedData.pdp_how_to_use_raw,
    snapshot.pdp_how_to_use_raw,
    seedData.how_to_use_raw,
    snapshot.how_to_use_raw,
  );
  const inci = pickFirstString(
    seedData.pdp_ingredients_raw,
    snapshot.pdp_ingredients_raw,
    seedData.ingredients_raw,
    snapshot.ingredients_raw,
    seedData.raw_ingredient_text_clean,
    snapshot.raw_ingredient_text_clean,
  );
  const active = pickFirstString(
    seedData.pdp_active_ingredients_raw,
    snapshot.pdp_active_ingredients_raw,
    seedData.active_ingredients,
    snapshot.active_ingredients,
  );
  const diagnostics = asObject(snapshot.diagnostics || seedData.diagnostics);
  const failureCategory = pickFirstString(diagnostics.failure_category, diagnostics.failureCategory);
  const imageCount = Math.max(
    countArray(seedData.image_urls),
    countArray(snapshot.image_urls),
    normalizeNonEmptyString(row.image_url) ? 1 : 0,
  );
  const variants = asArray(seedData.variants).length ? asArray(seedData.variants) : asArray(snapshot.variants);
  return {
    description_chars: description.length,
    details_sections_count: detailsSections.length,
    faq_count: faqItems.length,
    how_to_chars: howTo.length,
    inci_chars: inci.length,
    active_ingredients_chars: active.length,
    image_count: imageCount,
    variant_count: variants.length,
    extractor_failure_category: failureCategory || null,
  };
}

function hasEnoughSeedContentForKb(coverage = {}) {
  return (
    coverage.details_sections_count > 0 ||
    coverage.description_chars >= 180 ||
    coverage.inci_chars >= 120 ||
    coverage.how_to_chars >= 80
  );
}

function isFieldApplicable(field, context = {}) {
  if (context.non_merchandise) return false;
  if (field === 'faq') return false;
  if (['product_key_kb', 'identity', 'details_sections'].includes(field)) return true;
  if (field === 'how_to') return !context.accessory;
  if (field === 'inci') return context.formula || context.bundle || context.fragrance;
  if (field === 'active_ingredients') return context.regulatory_active_expected;
  return true;
}

function classifyMissingField({ field, row, context, coverage, hasProductKeyKb, hasIdentity }) {
  if (!isFieldApplicable(field, context)) {
    if (field === 'faq') return 'source_optional_or_needs_truth_check';
    if (field === 'active_ingredients' && !context.regulatory_active_expected) {
      return 'not_applicable_without_regulatory_active_signal';
    }
    return 'not_applicable';
  }

  if (!context.product_url_like) return 'non_product_or_uncertain_url';
  if (coverage.extractor_failure_category && SOURCE_BLOCKED_RE.test(coverage.extractor_failure_category)) {
    return 'extractor_or_url_blocked';
  }

  if (field === 'product_key_kb') {
    if (!hasIdentity && row.has_any_identity) return 'blocked_identity_review_queue_or_live_disabled';
    if (!hasIdentity) return 'blocked_missing_identity';
    if (!hasEnoughSeedContentForKb(coverage)) return 'blocked_seed_underfilled';
    return 'kb_generation_candidate';
  }

  if (field === 'identity') {
    if (row.has_any_identity) return 'identity_review_queue_or_live_blocked';
    return 'identity_backfill_candidate';
  }

  if (['details_sections', 'how_to', 'inci', 'active_ingredients'].includes(field)) {
    if (coverage.description_chars >= 260 && coverage.details_sections_count === 0) {
      return 'seed_structuring_candidate';
    }
    return 'catalog_truth_or_backfill_candidate';
  }

  return 'needs_review';
}

function classifyRow(row = {}) {
  const context = classifyProductContext(row);
  const coverage = getSeedCoverage(row);
  const hasProductKeyKb = Boolean(row.has_product_key_kb);
  const hasIdentity = Boolean(row.has_identity);
  const present = {
    product_key_kb: hasProductKeyKb,
    identity: hasIdentity,
    details_sections: coverage.details_sections_count > 0,
    faq: coverage.faq_count > 0,
    how_to: coverage.how_to_chars > 0,
    inci: coverage.inci_chars > 0,
    active_ingredients: coverage.active_ingredients_chars > 0,
  };
  const field_status = {};
  for (const field of FIELD_NAMES) {
    field_status[field] = present[field]
      ? 'present'
      : classifyMissingField({ field, row, context, coverage, hasProductKeyKb, hasIdentity });
  }
  return {
    seed_id: normalizeNonEmptyString(row.id),
    external_product_id: normalizeNonEmptyString(row.external_product_id),
    market: normalizeNonEmptyString(row.market),
    domain: normalizeNonEmptyString(row.domain),
    title: normalizeNonEmptyString(row.title),
    canonical_url: normalizeNonEmptyString(row.canonical_url),
    destination_url: normalizeNonEmptyString(row.destination_url),
    product_context: context,
    coverage,
    field_status,
    missing_fields: FIELD_NAMES.filter((field) => field_status[field] !== 'present'),
    actionable_fields: FIELD_NAMES.filter((field) => isActionableStatus(field_status[field])),
  };
}

function isActionableStatus(status) {
  return [
    'kb_generation_candidate',
    'identity_backfill_candidate',
    'seed_structuring_candidate',
    'catalog_truth_or_backfill_candidate',
  ].includes(status);
}

function increment(map, key, amount = 1) {
  const normalized = normalizeNonEmptyString(key) || 'unknown';
  map[normalized] = (map[normalized] || 0) + amount;
}

function topEntries(map, limit = 20) {
  return Object.entries(map)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, Math.max(1, limit))
    .map(([key, count]) => ({ key, count }));
}

function summarizeRows(rows, { sampleLimit = 25 } = {}) {
  const summary = {
    scanned: rows.length,
    by_product_family: {},
    raw_missing_by_field: {},
    actionable_missing_by_field: {},
    by_field_status: {},
    actionable_by_domain: {},
    top_actionable_domains: [],
    candidate_external_product_ids: {
      kb_generation_candidate: [],
      identity_backfill_candidate: [],
      seed_backfill_or_structuring_candidate: [],
    },
    samples: [],
  };

  for (const row of rows) {
    increment(summary.by_product_family, row.product_context.product_family);
    const rowActionable = new Set();
    for (const field of FIELD_NAMES) {
      const status = row.field_status[field];
      if (status !== 'present') increment(summary.raw_missing_by_field, field);
      if (!summary.by_field_status[field]) summary.by_field_status[field] = {};
      increment(summary.by_field_status[field], status);
      if (isActionableStatus(status)) {
        increment(summary.actionable_missing_by_field, field);
        rowActionable.add(field);
        if (status === 'kb_generation_candidate') {
          summary.candidate_external_product_ids.kb_generation_candidate.push(row.external_product_id);
        } else if (status === 'identity_backfill_candidate') {
          summary.candidate_external_product_ids.identity_backfill_candidate.push(row.external_product_id);
        } else {
          summary.candidate_external_product_ids.seed_backfill_or_structuring_candidate.push(row.external_product_id);
        }
      }
    }
    if (rowActionable.size > 0) increment(summary.actionable_by_domain, row.domain);
  }

  summary.top_actionable_domains = topEntries(summary.actionable_by_domain, 25);
  for (const key of Object.keys(summary.candidate_external_product_ids)) {
    summary.candidate_external_product_ids[key] = Array.from(
      new Set(summary.candidate_external_product_ids[key].filter(Boolean)),
    ).slice(0, 500);
  }
  summary.samples = rows
    .filter((row) => row.actionable_fields.length > 0)
    .slice(0, Math.max(1, sampleLimit))
    .map((row) => ({
      seed_id: row.seed_id,
      external_product_id: row.external_product_id,
      domain: row.domain,
      title: row.title,
      product_family: row.product_context.product_family,
      actionable_fields: row.actionable_fields,
      field_status: row.field_status,
      canonical_url: row.canonical_url,
    }));
  return summary;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function fetchRows(options = {}) {
  const where = [
    `eps.status = 'active'`,
    `eps.market = $1`,
    `eps.external_product_id LIKE 'ext_%'`,
    `(eps.tool = '*' OR eps.tool = 'creator_agents')`,
  ];
  const params = [options.market];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (!options.includeAttached) where.push(`eps.attached_product_key IS NULL`);
  if (options.domain) where.push(`eps.domain = ${bind(options.domain)}`);
  if (options.brand) {
    where.push(`lower(coalesce(eps.seed_data->>'brand', eps.seed_data->'snapshot'->>'brand', '')) = lower(${bind(options.brand)})`);
  }
  if (options.externalProductId) where.push(`eps.external_product_id = ${bind(options.externalProductId)}`);

  params.push(options.limit);
  const limitBind = `$${params.length}`;
  params.push(options.offset);
  const offsetBind = `$${params.length}`;

  const res = await query(
    `
      SELECT
        eps.id,
        eps.external_product_id,
        eps.market,
        eps.tool,
        eps.domain,
        eps.title,
        eps.canonical_url,
        eps.destination_url,
        eps.image_url,
        eps.attached_product_key,
        coalesce(eps.seed_data, '{}'::jsonb) AS seed_data,
        EXISTS (
          SELECT 1
          FROM aurora_product_intel_kb kb
          WHERE kb.kb_key = 'product:' || eps.external_product_id
        ) AS has_product_key_kb,
        EXISTS (
          SELECT 1
          FROM pdp_identity_listing pil
          WHERE pil.merchant_id = 'external_seed'
            AND pil.product_id = eps.external_product_id
            AND coalesce(pil.live_read_enabled, true) = true
        ) AS has_identity
        ,
        EXISTS (
          SELECT 1
          FROM pdp_identity_listing pil
          WHERE pil.merchant_id = 'external_seed'
            AND pil.product_id = eps.external_product_id
        ) AS has_any_identity,
        coalesce((
          SELECT bool_or(pil.review_required = true OR coalesce(pil.live_read_enabled, false) = false)
          FROM pdp_identity_listing pil
          WHERE pil.merchant_id = 'external_seed'
            AND pil.product_id = eps.external_product_id
        ), false) AS identity_review_or_live_blocked
      FROM external_product_seeds eps
      WHERE ${where.join('\n        AND ')}
      ORDER BY eps.updated_at DESC NULLS LAST, eps.created_at DESC NULLS LAST
      LIMIT ${limitBind}
      OFFSET ${offsetBind}
    `,
    params,
  );
  return res.rows || [];
}

function renderSummary(payload) {
  const lines = [];
  lines.push(`scanned=${payload.summary.scanned}`);
  lines.push(`raw_missing_by_field=${JSON.stringify(payload.summary.raw_missing_by_field)}`);
  lines.push(`actionable_missing_by_field=${JSON.stringify(payload.summary.actionable_missing_by_field)}`);
  lines.push(`by_product_family=${JSON.stringify(payload.summary.by_product_family)}`);
  lines.push(`top_actionable_domains=${JSON.stringify(payload.summary.top_actionable_domains.slice(0, 10))}`);
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = {
    market: normalizeNonEmptyString(argValue('market') || 'US').toUpperCase(),
    domain: argValue('domain') || null,
    brand: argValue('brand') || null,
    externalProductId: argValue('external-product-id') || argValue('externalProductId') || null,
    limit: Math.max(1, Math.min(Number(argValue('limit') || 5000), 10000)),
    offset: Math.max(0, Number(argValue('offset') || 0)),
    includeAttached: hasFlag('include-attached') || hasFlag('includeAttached'),
    format: normalizeNonEmptyString(argValue('format') || 'summary').toLowerCase(),
    out: argValue('out') || null,
    sampleLimit: Math.max(1, Math.min(Number(argValue('sample-limit') || 25), 200)),
  };
  const rawRows = await fetchRows(options);
  const rows = rawRows.map(classifyRow);
  const payload = {
    generated_at: new Date().toISOString(),
    options,
    summary: summarizeRows(rows, { sampleLimit: options.sampleLimit }),
    rows: options.format === 'json' ? rows : undefined,
  };
  const output = options.format === 'json' ? `${JSON.stringify(payload, null, 2)}\n` : renderSummary(payload);
  if (options.out) {
    ensureParentDir(options.out);
    fs.writeFileSync(options.out, output, 'utf8');
  }
  process.stdout.write(output);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await getPool()?.end();
      } catch {}
    });
}

module.exports = {
  FIELD_NAMES,
  classifyProductContext,
  getSeedCoverage,
  classifyMissingField,
  classifyRow,
  isActionableStatus,
  summarizeRows,
};
