#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REPORT_DIR =
  '/Users/pengchydan/dev/PIVOTA-Agent/reports/k_beauty_seed_expansion_20260429';
const DEFAULT_DTC_BASELINE_CSV =
  '/Users/pengchydan/Desktop/k_beauty_validated_dtc_seed_list.csv';
const DEFAULT_CHANNEL_BASELINE_CSV =
  '/Users/pengchydan/Desktop/k_beauty_validated_channel_seed_list.csv';

const KNOWN_SHADOW_HOSTS = Object.freeze({
  Torriden: ['torriden.us'],
  'Purito Seoul': ['purito-seoul.com'],
});

const KNOWN_MERGE_TRACKS = Object.freeze({
  merged_live_verified_pairs: [{ brand: 'Beauty of Joseon', channel: 'Ohlolly' }],
  blocked_public_live_rows: [
    {
      brand: 'COSRX',
      channel: 'Soko Glam',
      channel_external_product_id: 'ext_f6e9cfc1ee91df23073c40d5',
      official_anchor_external_product_id: 'ext_d3660c9697715994b1c767ba',
      merge_bucket: 'db_identity_ready_public_live_blocked',
      title: 'Advanced Snail 96 Mucin Power Essence',
    },
    {
      brand: 'COSRX',
      channel: 'Soko Glam',
      channel_external_product_id: 'ext_d45169d88ffb442bfa232ae0',
      official_anchor_external_product_id: 'ext_dd3ae164c5f4167251f61daf',
      merge_bucket: 'anchor_missing',
      title: 'The Vitamin C 13 Serum',
    },
    {
      brand: 'COSRX',
      channel: 'Soko Glam',
      channel_external_product_id: 'ext_3a9fb5b3ec487eca81d7b34a',
      official_anchor_external_product_id: 'ext_15b503e753d4e24c9040e42b',
      merge_bucket: 'db_identity_ready_public_live_blocked',
      title: 'Acne Pimple Master Patch',
    },
    {
      brand: 'COSRX',
      channel: 'Soko Glam',
      channel_external_product_id: 'ext_5af455e3b4d3be6d5f08702e',
      official_anchor_external_product_id: 'ext_7d2888c44663c43f1576ca0f',
      merge_bucket: 'anchor_missing',
      title: 'Advanced Snail 92 All In One Cream',
    },
    {
      brand: 'COSRX',
      channel: 'Soko Glam',
      channel_external_product_id: 'ext_18c8d90eada7a5ee53a1a410',
      official_anchor_external_product_id: 'ext_c2047472261bf6d82c60f109',
      merge_bucket: 'db_identity_ready_public_live_blocked',
      title: 'BHA Blackhead Power Liquid',
    },
    {
      brand: 'COSRX',
      channel: 'Soko Glam',
      channel_external_product_id: 'ext_db56c869999a87623557130d',
      official_anchor_external_product_id: 'ext_e649b5a54d96e3b38d327e46',
      merge_bucket: 'db_identity_ready_public_live_blocked',
      title: 'Advanced Snail Peptide Eye Cream',
    },
  ],
  hold_pairs: [
    { brand: 'Klairs', channel: 'Wishtrend', merge_bucket: 'anchor_missing' },
    { brand: 'Anua', channel: 'Blooming Koco', merge_bucket: 'no_verified_merge_path' },
    { brand: 'LANEIGE US', channel: 'Sephora', merge_bucket: 'no_verified_merge_path' },
  ],
});

const BAD_QA_PATTERNS = [
  /are you sure you want to quit\??/i,
  /booking request will be made/i,
  /forgot your password/i,
  /regimen guide/i,
  /how to build a skincare/i,
  /customer service/i,
];

const GALLERY_BLOAT_THRESHOLD = 40;
const GALLERY_BLOAT_DUP_RATIO = 1.4;
const CURRENT_ISSUES = Object.freeze({
  cosrx_public_live_timeout:
    'Representative Soko Glam x COSRX public get_pdp_v2 probes timed out on 2026-05-04; catalog serving dry-run built public docs but index.enabled=false, so public live promotion remains blocked.',
});

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return '';
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return '';
  return String(value).trim();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function safeHostFromUrl(value) {
  const raw = normalizeText(value);
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickFirstString(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function increment(map, key, amount = 1) {
  const normalized = normalizeText(key) || 'unknown';
  map[normalized] = (map[normalized] || 0) + amount;
}

function unique(array) {
  return Array.from(new Set(asArray(array).filter(Boolean)));
}

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let idx = 0; idx < text.length; idx += 1) {
    const char = text[idx];
    const next = text[idx + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        idx += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') idx += 1;
      row.push(field);
      field = '';
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows.shift().map((value) => normalizeText(value));
  return rows.map((values) => {
    const out = {};
    headers.forEach((header, index) => {
      out[header] = normalizeText(values[index] || '');
    });
    return out;
  });
}

function readCsv(filePath) {
  return parseCsv(fs.readFileSync(filePath, 'utf8'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function normalizeDomainStatus(host, officialHost, shadowHosts = []) {
  if (!host) return 'unknown';
  if (host === officialHost) return 'strict';
  if (shadowHosts.includes(host)) return 'shadow';
  return 'unknown';
}

function extractCoverageCounts(row) {
  const snapshot = ensureObject(row.seed_data?.snapshot);
  const detailsSections = [
    ...asArray(row.seed_data?.pdp_details_sections),
    ...asArray(snapshot.pdp_details_sections),
    ...asArray(row.seed_data?.details_sections),
    ...asArray(snapshot.details_sections),
  ];
  const faqItems = [
    ...asArray(row.seed_data?.pdp_faq_items),
    ...asArray(snapshot.pdp_faq_items),
    ...asArray(row.seed_data?.faq_items),
    ...asArray(snapshot.faq_items),
  ];
  const howTo = pickFirstString(
    row.seed_data?.pdp_how_to_use_raw,
    snapshot.pdp_how_to_use_raw,
    row.seed_data?.how_to_use_raw,
    snapshot.how_to_use_raw,
  );
  const inci = pickFirstString(
    row.seed_data?.pdp_ingredients_raw,
    snapshot.pdp_ingredients_raw,
    row.seed_data?.ingredients_raw,
    snapshot.ingredients_raw,
    row.seed_data?.raw_ingredient_text_clean,
    snapshot.raw_ingredient_text_clean,
  );
  const active = pickFirstString(
    row.seed_data?.pdp_active_ingredients_raw,
    snapshot.pdp_active_ingredients_raw,
    row.seed_data?.active_ingredients,
    snapshot.active_ingredients,
  );
  return {
    details_sections_count: detailsSections.length,
    faq_count: faqItems.length,
    how_to_chars: howTo.length,
    inci_chars: inci.length,
    active_chars: active.length,
  };
}

function extractReviewSummary(row) {
  const snapshot = ensureObject(row.seed_data?.snapshot);
  const reviewSummary = ensureObject(row.seed_data?.review_summary || snapshot.review_summary);
  const reviewCount = Number(reviewSummary.review_count || reviewSummary.total_reviews || 0) || 0;
  const rating = Number(reviewSummary.rating || reviewSummary.average_rating || 0) || 0;
  const chartCount = Math.max(
    asArray(reviewSummary.star_distribution).length,
    asArray(reviewSummary.rating_distribution).length,
  );
  return {
    review_count: reviewCount,
    rating,
    chart_bucket_count: chartCount,
  };
}

function extractFaqText(row) {
  const snapshot = ensureObject(row.seed_data?.snapshot);
  const items = [
    ...asArray(row.seed_data?.pdp_faq_items),
    ...asArray(snapshot.pdp_faq_items),
    ...asArray(row.seed_data?.faq_items),
    ...asArray(snapshot.faq_items),
  ];
  return items
    .map((item) =>
      [item?.question, item?.title, item?.heading, item?.answer, item?.content]
        .map((value) => normalizeText(value))
        .filter(Boolean)
        .join(' '),
    )
    .filter(Boolean);
}

function hasBadQa(row) {
  const texts = extractFaqText(row);
  return texts.some((text) => BAD_QA_PATTERNS.some((pattern) => pattern.test(text)));
}

function normalizeImageAssetKey(url) {
  const text = normalizeText(url);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let pathname = parsed.pathname;
    pathname = pathname.replace(/_(\d{2,4})x(\d{0,4})?(?=\.[a-z0-9]+$)/i, '');
    pathname = pathname.replace(/_(small|medium|large|grande|compact|thumb)(?=\.[a-z0-9]+$)/i, '');
    return `${host}${pathname}`.toLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

function computeGalleryHealth(row) {
  const snapshot = ensureObject(row.seed_data?.snapshot);
  const imageUrls = unique([
    row.image_url,
    row.seed_data?.image_url,
    snapshot.image_url,
    ...asArray(row.seed_data?.image_urls),
    ...asArray(snapshot.image_urls),
  ].map((value) => normalizeText(value)).filter(Boolean));
  const normalizedKeys = imageUrls.map(normalizeImageAssetKey).filter(Boolean);
  const uniqueKeys = unique(normalizedKeys);
  const duplicateRatio = uniqueKeys.length ? imageUrls.length / uniqueKeys.length : 1;
  return {
    image_count: imageUrls.length,
    unique_image_count: uniqueKeys.length,
    duplicate_ratio: Number(duplicateRatio.toFixed(2)),
    gallery_bloat:
      imageUrls.length > GALLERY_BLOAT_THRESHOLD ||
      (imageUrls.length >= 12 && duplicateRatio >= GALLERY_BLOAT_DUP_RATIO),
  };
}

function extractVariantSignal(row) {
  const snapshot = ensureObject(row.seed_data?.snapshot);
  const variants = unique([
    ...asArray(snapshot.variants),
    ...asArray(row.seed_data?.variants),
  ].filter(Boolean));
  const labels = [];
  for (const variant of variants) {
    const optionValue = pickFirstString(
      variant.option_value,
      variant.value,
      variant.title,
      ...(asArray(variant.options).map((option) => option?.value || option?.label || option?.name)),
    );
    if (optionValue) labels.push(optionValue);
  }
  const sizeEvidence = pickFirstString(
    row.seed_data?.size_detail_label,
    snapshot.size_detail_label,
    row.seed_data?.net_content,
    snapshot.net_content,
    row.seed_data?.size,
    snapshot.size,
    row.seed_data?.net_size,
    snapshot.net_size,
    row.seed_data?.volume,
    snapshot.volume,
  );
  const hasPlaceholder = labels.some((value) => /^(default|default title|single|option)$/i.test(normalizeText(value)));
  const displayable = labels.some((value) => !/^(default|default title|single|option)$/i.test(normalizeText(value))) || Boolean(sizeEvidence);
  return {
    variant_count: variants.length,
    variant_labels: unique(labels),
    size_evidence: sizeEvidence || null,
    displayable,
    placeholder_only: !displayable && (hasPlaceholder || variants.length > 0),
  };
}

function extractBrandLabel(row) {
  const snapshot = ensureObject(row.seed_data?.snapshot);
  return pickFirstString(
    row.seed_data?.brand,
    snapshot.brand,
    row.brand,
  );
}

function extractProductIntelState(row, kbByProductId) {
  const kbRow = kbByProductId.get(row.external_product_id) || null;
  const analysis = ensureObject(kbRow?.analysis);
  const bundle =
    ensureObject(analysis.product_intel_v1) ||
    ensureObject(analysis.product_intel) ||
    ensureObject(analysis.bundle);
  const contractVersion = pickFirstString(bundle.contract_version);
  const qualityState = pickFirstString(
    bundle?.quality_gate?.state,
    bundle?.meta?.quality_state,
    kbRow?.metadata?.quality_state,
  );
  const reviewed = Boolean(
    kbRow &&
      (kbRow.metadata?.human_reviewed === true ||
        kbRow.metadata?.review_status === 'pass' ||
        kbRow.metadata?.review_status === 'rewrite' ||
        qualityState === 'reviewed' ||
        qualityState === 'verified' ||
        qualityState === 'ready'),
  );
  const displayable = Boolean(kbRow && contractVersion === 'pivota.product_intel.v1');
  return {
    kb_exists: Boolean(kbRow),
    displayable,
    reviewed,
    quality_state: qualityState || null,
  };
}

function buildBlockingReasons(row, context) {
  const reasons = [];
  if (context.currency_mismatch) reasons.push('currency_mismatch');
  if (!context.variant.displayable) reasons.push('missing_variant');
  if (!context.review.review_count) reasons.push('missing_reviews');
  if (!context.coverage.how_to_chars) reasons.push('missing_how_to');
  if (!context.coverage.inci_chars) reasons.push('missing_ingredients');
  if (!context.product_intel.displayable || !context.product_intel.reviewed) reasons.push('missing_insights');
  if (context.bad_qa) reasons.push('bad_qa');
  if (context.gallery.gallery_bloat) reasons.push('gallery_bloat');
  if (!context.identity.product_line_id) reasons.push('identity_missing');
  return reasons;
}

function chooseQualityBucket(blockingReasons, context) {
  const hardStops = new Set(['currency_mismatch', 'bad_qa', 'gallery_bloat']);
  const hardStop = blockingReasons.some((reason) => hardStops.has(reason));
  const softBlockers = blockingReasons.filter((reason) => reason !== 'identity_missing');
  const partialEvidenceScore =
    Number(Boolean(context.review.review_count)) +
    Number(Boolean(context.coverage.inci_chars)) +
    Number(Boolean(context.coverage.how_to_chars)) +
    Number(Boolean(context.coverage.details_sections_count)) +
    Number(Boolean(context.product_intel.displayable && context.product_intel.reviewed));
  const conversionReady = softBlockers.length === 0;
  if (conversionReady) return { pdp_quality_bucket: 'ready', conversion_ready: true };
  if (!hardStop && softBlockers.length <= 2 && partialEvidenceScore >= 3) {
    return { pdp_quality_bucket: 'thin', conversion_ready: false };
  }
  return { pdp_quality_bucket: 'not_conversion_ready', conversion_ready: false };
}

function pairKey(brand, channel) {
  return `${normalizeLower(brand)}::${normalizeLower(channel)}`;
}

function buildMergeTrackContext() {
  const mergedPairs = new Set(
    KNOWN_MERGE_TRACKS.merged_live_verified_pairs.map((row) => pairKey(row.brand, row.channel)),
  );
  const blockedByProductId = new Map();
  const blockedOfficialByProductId = new Map();
  for (const row of KNOWN_MERGE_TRACKS.blocked_public_live_rows) {
    blockedByProductId.set(row.channel_external_product_id, row);
    blockedOfficialByProductId.set(row.official_anchor_external_product_id, row);
  }
  const holdPairs = new Map();
  for (const row of KNOWN_MERGE_TRACKS.hold_pairs) {
    holdPairs.set(pairKey(row.brand, row.channel), row.merge_bucket);
  }
  return { mergedPairs, blockedByProductId, blockedOfficialByProductId, holdPairs };
}

function determineMergeBucket(row, mapping, mergeContext, productRowsByLineId) {
  const brandLabel = mapping.brand_label;
  const channelLabel = mapping.channel_label;
  const lineId = normalizeText(row.identity.product_line_id);
  if (mapping.seed_type === 'channel') {
    const blocked = mergeContext.blockedByProductId.get(row.external_product_id);
    if (blocked) return blocked.merge_bucket;
    if (brandLabel && channelLabel && mergeContext.mergedPairs.has(pairKey(brandLabel, channelLabel))) {
      return lineId ? 'merged_live_verified' : 'no_verified_merge_path';
    }
    if (brandLabel && channelLabel && mergeContext.holdPairs.has(pairKey(brandLabel, channelLabel))) {
      return mergeContext.holdPairs.get(pairKey(brandLabel, channelLabel));
    }
    if (lineId && productRowsByLineId.get(lineId)?.size > 1) return 'merged_live_verified';
    return 'no_verified_merge_path';
  }

  const blockedOfficial = mergeContext.blockedOfficialByProductId.get(row.external_product_id);
  if (blockedOfficial) return blockedOfficial.merge_bucket;
  if (!lineId) return 'single_seller_only';
  const siblingRows = Array.from(productRowsByLineId.get(lineId) || []);
  const hasChannelSibling = siblingRows.some((sibling) => sibling.mapping.seed_type === 'channel');
  if (hasChannelSibling) {
    const mergedChannel = siblingRows.find(
      (sibling) =>
        sibling.mapping.seed_type === 'channel' &&
        sibling.mapping.brand_label &&
        sibling.mapping.channel_label &&
        mergeContext.mergedPairs.has(pairKey(sibling.mapping.brand_label, sibling.mapping.channel_label)),
    );
    if (mergedChannel) return 'merged_live_verified';
    return 'db_identity_ready_public_live_blocked';
  }
  return 'single_seller_only';
}

function summarizeCommerceFacts(rows) {
  const total = rows.length || 1;
  const good = rows.filter(
    (row) => Number(row.price_amount || 0) > 0 && normalizeText(row.price_currency) && normalizeText(row.availability),
  ).length;
  if (good === 0) return 'missing';
  if (good / total >= 0.8) return 'present';
  return 'partial';
}

function summarizeCoverageQuality(rows) {
  const counts = {};
  for (const row of rows) increment(counts, row.pdp_quality_bucket);
  if ((counts.ready || 0) === rows.length && rows.length > 0) return 'ready';
  if ((counts.not_conversion_ready || 0) > 0) return 'not_conversion_ready';
  if ((counts.thin || 0) > 0) return 'thin';
  return 'missing';
}

function mapBrandScopeRow(item) {
  return {
    brand: item.brand,
    workflow_run_id: item.workflow_run_id,
    scanned: item.scanned,
    rows_with_identity: item.rows_with_identity,
    actionable_missing_identity: Number(item.actionable_missing_by_field?.identity || 0),
    actionable_missing_details: Number(item.actionable_missing_by_field?.details_sections || 0),
    actionable_missing_how_to: Number(item.actionable_missing_by_field?.how_to || 0),
    actionable_missing_inci: Number(item.actionable_missing_by_field?.inci || 0),
    sample_external_product_ids: asArray(item.samples).map((sample) => sample.external_product_id).join('|'),
    report_path: item.report_path,
  };
}

function buildDomainMappings(dtcRows, channelRows) {
  const dtcByOfficialHost = new Map();
  const dtcByShadowHost = new Map();
  const dtcByBrand = new Map();
  for (const row of dtcRows) {
    const brand = normalizeText(row.brand_name);
    const officialHost = safeHostFromUrl(row.official_site);
    const mappedRow = {
      baseline_type: 'dtc',
      brand_or_channel: brand,
      brand_label: brand,
      channel_label: null,
      official_host: officialHost,
      shadow_hosts: KNOWN_SHADOW_HOSTS[brand] || [],
      baseline_row: row,
    };
    if (officialHost) {
      dtcByOfficialHost.set(officialHost, mappedRow);
    }
    dtcByBrand.set(normalizeLower(brand), mappedRow);
    for (const shadowHost of KNOWN_SHADOW_HOSTS[brand] || []) {
      dtcByShadowHost.set(shadowHost, mappedRow);
    }
  }

  const channelsByHost = new Map();
  const channelsByName = new Map();
  for (const row of channelRows) {
    const channel = normalizeText(row.channel_name);
    const host = safeHostFromUrl(row.website);
    const mappedRow = {
      baseline_type: 'channel',
      brand_or_channel: channel,
      brand_label: null,
      channel_label: channel,
      official_host: host,
      shadow_hosts: [],
      baseline_row: row,
    };
    if (host) channelsByHost.set(host, mappedRow);
    channelsByName.set(normalizeLower(channel), mappedRow);
  }

  return { dtcByOfficialHost, dtcByShadowHost, dtcByBrand, channelsByHost, channelsByName };
}

function mapRowToBaseline(row, mappings) {
  const host = normalizeLower(row.domain);
  if (mappings.dtcByOfficialHost.has(host)) {
    const mapped = mappings.dtcByOfficialHost.get(host);
    return {
      ...mapped,
      coverage_status: 'strict_covered',
      official_host_status: 'strict',
    };
  }
  if (mappings.dtcByShadowHost.has(host)) {
    const mapped = mappings.dtcByShadowHost.get(host);
    return {
      ...mapped,
      coverage_status: 'shadow_covered',
      official_host_status: 'shadow',
    };
  }
  if (mappings.channelsByHost.has(host)) {
    const mapped = mappings.channelsByHost.get(host);
    return {
      ...mapped,
      coverage_status: 'strict_covered',
      official_host_status: 'strict',
      brand_label: extractBrandLabel(row) || null,
    };
  }
  return null;
}

function buildCoverageTable(dtcRows, channelRows, productRows, shadowAudit) {
  const productRowsByCoverageKey = new Map();
  for (const row of productRows) {
    const key = `${row.baseline_type}::${row.brand_or_channel}`;
    const current = productRowsByCoverageKey.get(key) || [];
    current.push(row);
    productRowsByCoverageKey.set(key, current);
  }

  const results = [];
  for (const row of dtcRows) {
    const key = `dtc::${normalizeText(row.brand_name)}`;
    const currentProductRows = productRowsByCoverageKey.get(key) || [];
    const auditRow = asArray(shadowAudit?.dtc?.rows).find(
      (item) => normalizeText(item.brand_name) === normalizeText(row.brand_name),
    );
    results.push({
      brand_or_channel: normalizeText(row.brand_name),
      baseline_type: 'dtc',
      coverage_status: auditRow?.covered
        ? 'strict_covered'
        : auditRow?.shadow_covered
          ? 'shadow_covered'
          : 'missing',
      active_seed_count: Number(auditRow?.active_seed_count || 0) + Number(auditRow?.shadow_active_seed_count || 0),
      official_host_status: auditRow?.covered ? 'strict' : auditRow?.shadow_covered ? 'shadow' : 'missing',
      commerce_facts_status:
        (Number(auditRow?.active_seed_count || 0) + Number(auditRow?.shadow_active_seed_count || 0)) > 0
          ? 'present'
          : 'missing',
      quality_bucket: currentProductRows.length ? summarizeCoverageQuality(currentProductRows) : 'missing',
      markets: unique([...(auditRow?.markets || []), ...(auditRow?.shadow_markets || [])]).join('|'),
      sample_external_product_ids: unique([
        ...(auditRow?.sample_external_product_ids || []),
        ...(auditRow?.shadow_sample_external_product_ids || []),
      ]).join('|'),
      priority_tier: normalizeText(row.priority_tier),
      transaction_ready: normalizeText(row.transaction_ready),
      validation_status: normalizeText(row.validation_status),
    });
  }

  for (const row of channelRows) {
    const key = `channel::${normalizeText(row.channel_name)}`;
    const currentProductRows = productRowsByCoverageKey.get(key) || [];
    const auditRow = asArray(shadowAudit?.channels?.rows).find(
      (item) => normalizeText(item.channel_name) === normalizeText(row.channel_name),
    );
    results.push({
      brand_or_channel: normalizeText(row.channel_name),
      baseline_type: 'channel',
      coverage_status: auditRow?.covered ? 'strict_covered' : 'missing',
      active_seed_count: Number(auditRow?.active_seed_count || 0),
      official_host_status: auditRow?.covered ? 'strict' : 'missing',
      commerce_facts_status: Number(auditRow?.active_seed_count || 0) > 0 ? 'present' : 'missing',
      quality_bucket: currentProductRows.length ? summarizeCoverageQuality(currentProductRows) : 'missing',
      markets: unique(auditRow?.markets || []).join('|'),
      sample_external_product_ids: unique(auditRow?.sample_external_product_ids || []).join('|'),
      priority_tier: normalizeText(row.priority_tier),
      transaction_ready: normalizeText(row.transaction_ready),
      validation_status: normalizeText(row.validation_status),
    });
  }

  return results;
}

function buildExceptionBoard(productRows, coverageTable, nonMergeConsolidation, currentIssues = {}) {
  const rows = [];
  for (const row of coverageTable) {
    if (row.coverage_status === 'shadow_covered') {
      rows.push({
        exception_type: 'shadow_host_canonical',
        scope: row.brand_or_channel,
        severity: 'review',
        details: `shadow_covered on non-strict host; active_seed_count=${row.active_seed_count}`,
        evidence: row.sample_external_product_ids,
      });
    }
  }

  for (const item of asArray(nonMergeConsolidation.non_merge_strict_quality)) {
    const missingFields = ensureObject(item.actionable_missing_by_field);
    const systemic = Object.entries(missingFields)
      .filter(([, count]) => Number(count || 0) > 0)
      .map(([field, count]) => `${field}:${count}`)
      .join(', ');
    if (systemic) {
      rows.push({
        exception_type: 'systemic_brand_quality_gap',
        scope: item.brand,
        severity: Number(missingFields.identity || 0) > 0 ? 'blocker' : 'review',
        details: systemic,
        evidence: asArray(item.samples)
          .map((sample) => sample.external_product_id)
          .join('|'),
      });
    }
  }

  for (const row of productRows) {
    if (row.blocking_reasons.includes('gallery_bloat')) {
      rows.push({
        exception_type: 'gallery_bloat',
        scope: row.external_product_id,
        severity: 'review',
        details: `${row.title} image_count=${row.image_count} duplicate_ratio=${row.image_duplicate_ratio}`,
        evidence: row.canonical_url,
      });
    }
    if (row.blocking_reasons.includes('bad_qa')) {
      rows.push({
        exception_type: 'bad_qa',
        scope: row.external_product_id,
        severity: 'blocker',
        details: `${row.title} has irrelevant or polluted Q&A`,
        evidence: row.canonical_url,
      });
    }
  }

  if (currentIssues.cosrx_public_live_timeout) {
    rows.push({
      exception_type: 'public_live_timeout',
      scope: 'COSRX x Soko Glam',
      severity: 'blocker',
      details: currentIssues.cosrx_public_live_timeout,
      evidence: 'public get_pdp_v2 probe 2026-05-04',
    });
  }

  return rows;
}

function normalizeHoldMergeBucket(status) {
  if (status === 'official_anchor_missing') return 'anchor_missing';
  return 'no_verified_merge_path';
}

function buildMergeBoardFromConsolidation(consolidation) {
  const mergeTracks = ensureObject(consolidation.merge_tracks);
  const rows = [];

  for (const item of asArray(mergeTracks.merged_live_verified)) {
    rows.push({
      brand: normalizeText(item.brand),
      channel: normalizeText(item.channel),
      channel_external_product_id: '',
      official_anchor_external_product_id: '',
      title: '',
      product_line_id: '',
      sellable_item_group_id: '',
      ready_for_override: false,
      merge_safe: true,
      merge_bucket: 'merged_live_verified',
      next_action: 'regression_verify_only',
    });
  }

  const blocked = ensureObject(mergeTracks.merge_safe_blocked_public_live);
  for (const item of asArray(blocked.rows)) {
    const mergeBucket =
      item.merge_status === 'official_anchor_identity_missing_in_db'
        ? 'anchor_missing'
        : normalizeText(item.merge_status);
    rows.push({
      brand: normalizeText(blocked.brand),
      channel: normalizeText(blocked.channel),
      channel_external_product_id: normalizeText(item.channel_external_product_id),
      official_anchor_external_product_id: normalizeText(item.official_anchor_external_product_id),
      title: normalizeText(item.channel_title),
      product_line_id: normalizeText(item.db_product_line_id),
      sellable_item_group_id: normalizeText(item.db_sellable_item_group_id),
      ready_for_override: mergeBucket === 'db_identity_ready_public_live_blocked',
      merge_safe: false,
      merge_bucket: mergeBucket,
      next_action:
        mergeBucket === 'db_identity_ready_public_live_blocked'
          ? 'catalog_serving_public_promote_then_live_verify'
          : 'official_anchor_identity_lift',
    });
  }

  for (const item of asArray(mergeTracks.anchor_missing_or_not_exact_hold)) {
    const mergeBucket = normalizeHoldMergeBucket(normalizeText(item.status));
    rows.push({
      brand: normalizeText(item.brand),
      channel: normalizeText(item.channel),
      channel_external_product_id: '',
      official_anchor_external_product_id: '',
      title: '',
      product_line_id: '',
      sellable_item_group_id: '',
      ready_for_override: false,
      merge_safe: false,
      merge_bucket: mergeBucket,
      next_action:
        mergeBucket === 'anchor_missing'
          ? 'build_official_anchor_first'
          : 'hold_until_verified_merge_path',
    });
  }

  return rows;
}

async function main() {
  const reportDir = argValue('report-dir') || DEFAULT_REPORT_DIR;
  const outDir = argValue('out-dir') || reportDir;
  const dtcCsvPath = argValue('dtc-csv') || DEFAULT_DTC_BASELINE_CSV;
  const channelCsvPath = argValue('channel-csv') || DEFAULT_CHANNEL_BASELINE_CSV;

  const dtcBaseline = readCsv(dtcCsvPath);
  const channelBaseline = readCsv(channelCsvPath);
  const consolidation = readJson(
    path.join(reportDir, 'kbeauty_remaining_merge_and_quality_consolidation_20260501.json'),
  );
  const strictAudit = readJson(
    path.join(reportDir, 'strict_pdp_quality_conversion_audit_20260503.json'),
  );
  const shadowAudit = readJson(
    path.join(reportDir, 'kbeauty_baseline_coverage_audit_shadow_20260501.json'),
  );

  const mappings = buildDomainMappings(dtcBaseline, channelBaseline);
  const mergeContext = buildMergeTrackContext();

  const strictRows = asArray(strictAudit.rows || strictAudit.products || strictAudit.audited_rows || []);
  const productRows = [];
  const productRowsByLineId = new Map();

  for (const row of strictRows) {
    const inferredBrandMapping = mappings.dtcByBrand.get(normalizeLower(row.brand || '')) || null;
    const mapped = {
      seed_data: {},
      external_product_id: row.external_product_id || row.product_id,
      title: row.title,
      domain:
        safeHostFromUrl(row.canonical_url || row.destination_url || row.domain) ||
        normalizeText(inferredBrandMapping?.official_host),
      market: 'US',
      price_amount: row.price_amount,
      price_currency: row.price_currency,
      availability: row.availability,
      canonical_url: row.canonical_url,
      destination_url: row.destination_url,
      image_url: row.image_url,
      identity: {
        product_line_id: row.product_line_id || null,
        sellable_item_group_id: row.sellable_item_group_id || null,
      },
      baseline_row: {},
    };
    const mapping = mapRowToBaseline(mapped, mappings);
    if (!mapping) continue;
    const record = {
      ...mapped,
      baseline_type: mapping.baseline_type,
      brand_or_channel: mapping.brand_or_channel,
      brand_label: mapping.brand_label,
      channel_label: mapping.channel_label,
      coverage_status: mapping.coverage_status,
      official_host_status: mapping.official_host_status,
      baseline_row: mapping.baseline_row,
      coverage: {
        details_sections_count: Number(row.supplemental_sections_count || 0),
        faq_count: Number(row.question_count || row.faq_count || 0),
        how_to_chars: Number(row.how_to_item_count || 0) > 0 ? 1 : 0,
        inci_chars: Number(row.ingredients_count || row.inci_count || 0) > 0 ? 1 : 0,
        active_chars: Number(row.active_ingredients_count || 0) > 0 ? 1 : 0,
      },
      review: {
        review_count: Number(row.review_count || row.reviews_count || 0),
        rating: Number(row.rating || 0),
        chart_bucket_count: row.review_chart_present || row.has_star_distribution ? 5 : 0,
      },
      gallery: {
        image_count: Number(row.gallery_count || 0),
        unique_image_count: Number(row.gallery_count || 0),
        duplicate_ratio: 1,
        gallery_bloat: false,
      },
      variant: {
        variant_count: Number(row.variant_count || 0),
        variant_labels: asArray(row.variant_labels).length
          ? asArray(row.variant_labels)
          : row.first_variant_label
            ? [row.first_variant_label]
            : [],
        size_evidence: row.first_variant_label || null,
        displayable: Boolean(row.variant_selector_present),
        placeholder_only: false,
      },
      product_intel: {
        kb_exists: Boolean(row.product_intel_present || row.insights_present),
        displayable: Boolean(row.product_intel_present || row.insights_present),
        reviewed: Boolean(row.product_intel_present || row.insights_present),
        quality_state: row.product_intel_present || row.insights_present ? 'ready' : null,
      },
      bad_qa: false,
      currency_mismatch: row.price_currency && row.price_currency !== 'USD',
    };
    const blockingReasons = unique(
      String(row.blockers || row.blocking_reasons || '')
        .split(/[|,]/)
        .map((value) => normalizeText(value))
        .filter(Boolean)
        .map((value) => {
          const lower = value.toLowerCase();
          if (lower.includes('variant')) return 'missing_variant';
          if (lower.includes('review')) return 'missing_reviews';
          if (lower.includes('currency')) return 'currency_mismatch';
          if (lower.includes('how_to')) return 'missing_how_to';
          if (lower.includes('ingredient')) return 'missing_ingredients';
          if (lower.includes('insight')) return 'missing_insights';
          if (lower.includes('identity')) return 'identity_missing';
          return value;
        }),
    );
      const quality = row.verdict
      ? {
          pdp_quality_bucket:
            row.verdict === 'ready'
              ? 'ready'
              : row.verdict === 'thin'
                ? 'thin'
                : 'not_conversion_ready',
          conversion_ready: row.verdict === 'ready',
        }
      : chooseQualityBucket(blockingReasons, record);
    record.blocking_reasons = blockingReasons;
    record.pdp_quality_bucket = quality.pdp_quality_bucket;
    record.conversion_ready = quality.conversion_ready;
    record.merge_bucket = 'single_seller_only';
    productRows.push(record);
    if (record.identity.product_line_id) {
      const key = record.identity.product_line_id;
      if (!productRowsByLineId.has(key)) productRowsByLineId.set(key, []);
      productRowsByLineId.get(key).push({ mapping, external_product_id: record.external_product_id });
    }
  }

  for (const item of asArray(consolidation.non_merge_strict_quality)) {
    for (const sample of asArray(item.samples)) {
      if (productRows.some((row) => row.external_product_id === sample.external_product_id)) continue;
      const mapped = {
        seed_data: {},
        external_product_id: sample.external_product_id,
        title: sample.title,
        domain: safeHostFromUrl(sample.canonical_url || sample.domain),
        market: 'US',
        price_amount: null,
        price_currency: '',
        availability: '',
        canonical_url: sample.canonical_url,
        destination_url: sample.canonical_url,
        image_url: '',
        identity: { product_line_id: null, sellable_item_group_id: null },
        baseline_row: {},
      };
      const mapping = mapRowToBaseline(mapped, mappings);
      if (!mapping) continue;
      const blockingReasons = unique(
        asArray(sample.actionable_fields).map((field) => {
          if (field === 'identity') return 'identity_missing';
          if (field === 'how_to') return 'missing_how_to';
          if (field === 'inci') return 'missing_ingredients';
          if (field === 'product_key_kb') return 'missing_insights';
          return '';
        }),
      );
      const quality = chooseQualityBucket(blockingReasons, {
        coverage: { details_sections_count: 0, how_to_chars: 0, inci_chars: 0 },
        review: { review_count: 0 },
        product_intel: { displayable: false, reviewed: false },
      });
      productRows.push({
        ...mapped,
        baseline_type: mapping.baseline_type,
        brand_or_channel: mapping.brand_or_channel,
        brand_label: mapping.brand_label,
        channel_label: mapping.channel_label,
        coverage_status: mapping.coverage_status,
        official_host_status: mapping.official_host_status,
        baseline_row: mapping.baseline_row,
        coverage: { details_sections_count: 0, faq_count: 0, how_to_chars: 0, inci_chars: 0, active_chars: 0 },
        review: { review_count: 0, rating: 0, chart_bucket_count: 0 },
        gallery: { image_count: 0, unique_image_count: 0, duplicate_ratio: 1, gallery_bloat: false },
        variant: { variant_count: 0, variant_labels: [], size_evidence: null, displayable: false, placeholder_only: false },
        product_intel: { kb_exists: false, displayable: false, reviewed: false, quality_state: null },
        bad_qa: false,
        currency_mismatch: false,
        blocking_reasons: blockingReasons,
        pdp_quality_bucket: quality.pdp_quality_bucket,
        conversion_ready: quality.conversion_ready,
        merge_bucket: 'single_seller_only',
      });
    }
  }

  for (const row of productRows) {
    row.merge_bucket = determineMergeBucket(
      { ...row, identity: row.identity },
      {
        seed_type: row.baseline_type,
        brand_label: row.brand_label,
        channel_label: row.channel_label,
      },
      mergeContext,
      productRowsByLineId,
    );
  }

  const coverageTable = buildCoverageTable(dtcBaseline, channelBaseline, productRows, shadowAudit);

  const mergeBoard = buildMergeBoardFromConsolidation(consolidation);

  const newCoverageBoard = [
    ...dtcBaseline
      .filter((row) => !coverageTable.find((item) => item.baseline_type === 'dtc' && item.brand_or_channel === normalizeText(row.brand_name) && item.coverage_status !== 'missing'))
      .map((row) => ({
        baseline_type: 'dtc',
        brand_or_channel: normalizeText(row.brand_name),
        official_host: safeHostFromUrl(row.official_site),
        priority_tier: normalizeText(row.priority_tier),
        transaction_ready: normalizeText(row.transaction_ready),
        validation_status: normalizeText(row.validation_status),
        next_action: 'officialness_validation_then_manifest',
      })),
    ...channelBaseline
      .filter((row) => !coverageTable.find((item) => item.baseline_type === 'channel' && item.brand_or_channel === normalizeText(row.channel_name) && item.coverage_status !== 'missing'))
      .map((row) => ({
        baseline_type: 'channel',
        brand_or_channel: normalizeText(row.channel_name),
        official_host: safeHostFromUrl(row.website),
        priority_tier: normalizeText(row.priority_tier),
        transaction_ready: normalizeText(row.transaction_ready),
        validation_status: normalizeText(row.validation_status),
        next_action: 'find_verified_merge_candidate_before_apply',
      })),
  ];

  const exceptionBoard = buildExceptionBoard(productRows, coverageTable, consolidation, CURRENT_ISSUES);

  const masterInventory = {
    generated_at: new Date().toISOString(),
    source_reports: {
      report_dir: reportDir,
      strict_conversion_audit: path.join(reportDir, 'strict_pdp_quality_conversion_audit_20260503.json'),
      consolidation: path.join(reportDir, 'kbeauty_remaining_merge_and_quality_consolidation_20260501.json'),
      shadow_coverage: path.join(reportDir, 'kbeauty_baseline_coverage_audit_shadow_20260501.json'),
    },
    baseline_summary: {
      dtc_strict_covered_brand_count: shadowAudit.dtc?.covered_brand_count || shadowAudit.dtc?.strict_covered_brand_count || null,
      dtc_shadow_only_brand_count: shadowAudit.dtc?.shadow_only_brand_count || null,
      dtc_strict_or_shadow_covered_brand_count: shadowAudit.dtc?.strict_or_shadow_covered_brand_count || null,
      dtc_true_missing_brand_count:
        dtcBaseline.length -
          Number(shadowAudit.dtc?.strict_or_shadow_covered_brand_count || 0) >=
        0
          ? dtcBaseline.length -
            Number(shadowAudit.dtc?.strict_or_shadow_covered_brand_count || 0)
          : null,
      channel_covered_channel_count: shadowAudit.channels?.covered_channel_count || null,
    },
    coverage_table: coverageTable,
    product_table: productRows.map((row) => ({
      external_product_id: row.external_product_id,
      brand: row.brand_label || extractBrandLabel(row) || '',
      brand_or_channel: row.brand_or_channel,
      channel: row.channel_label || '',
      seed_type: row.baseline_type,
      market: row.market,
      domain: row.domain,
      title: row.title,
      coverage_status: row.coverage_status,
      merge_bucket: row.merge_bucket,
      pdp_quality_bucket: row.pdp_quality_bucket,
      conversion_ready: row.conversion_ready,
      blocking_reasons: row.blocking_reasons,
      official_host_status: row.official_host_status,
      price_amount: row.price_amount,
      price_currency: row.price_currency,
      availability: row.availability,
      product_line_id: row.identity?.product_line_id || null,
      sellable_item_group_id: row.identity?.sellable_item_group_id || null,
      review_count: row.review.review_count,
      review_chart_bucket_count: row.review.chart_bucket_count,
      variant_count: row.variant.variant_count,
      variant_displayable: row.variant.displayable,
      size_evidence: row.variant.size_evidence,
      details_sections_count: row.coverage.details_sections_count,
      faq_count: row.coverage.faq_count,
      how_to_chars: row.coverage.how_to_chars,
      inci_chars: row.coverage.inci_chars,
      product_intel_ready: row.product_intel.displayable && row.product_intel.reviewed,
      image_count: row.gallery.image_count,
      unique_image_count: row.gallery.unique_image_count,
      image_duplicate_ratio: row.gallery.duplicate_ratio,
      canonical_url: row.canonical_url,
    })),
    merge_remediation_board: mergeBoard,
    pdp_quality_board: productRows.map((row) => ({
      external_product_id: row.external_product_id,
      brand_or_channel: row.brand_or_channel,
      brand: row.brand_label || extractBrandLabel(row) || '',
      title: row.title,
      seed_type: row.baseline_type,
      merge_bucket: row.merge_bucket,
      pdp_quality_bucket: row.pdp_quality_bucket,
      conversion_ready: row.conversion_ready,
      blocking_reasons: row.blocking_reasons,
      review_count: row.review.review_count,
      variant_displayable: row.variant.displayable,
      how_to_chars: row.coverage.how_to_chars,
      inci_chars: row.coverage.inci_chars,
      product_intel_ready: row.product_intel.displayable && row.product_intel.reviewed,
      bad_qa: row.bad_qa,
      gallery_bloat: row.gallery.gallery_bloat,
      currency_mismatch: row.currency_mismatch,
      product_line_id: row.identity?.product_line_id || null,
      sellable_item_group_id: row.identity?.sellable_item_group_id || null,
    })),
    new_coverage_board: newCoverageBoard,
    exception_board: exceptionBoard,
    non_merge_brand_rollup: asArray(consolidation.non_merge_strict_quality).map(mapBrandScopeRow),
  };

  ensureDir(outDir);
  const jsonPath = path.join(outDir, 'kbeauty_master_inventory_20260504.json');
  const coverageCsvPath = path.join(outDir, 'kbeauty_coverage_table_20260504.csv');
  const productCsvPath = path.join(outDir, 'kbeauty_product_table_20260504.csv');
  const mergeCsvPath = path.join(outDir, 'kbeauty_merge_remediation_board_20260504.csv');
  const qualityCsvPath = path.join(outDir, 'kbeauty_pdp_quality_board_20260504.csv');
  const newCoverageCsvPath = path.join(outDir, 'kbeauty_new_coverage_board_20260504.csv');
  const exceptionCsvPath = path.join(outDir, 'kbeauty_exception_board_20260504.csv');
  fs.writeFileSync(jsonPath, `${JSON.stringify(masterInventory, null, 2)}\n`, 'utf8');

  writeCsv(coverageCsvPath, masterInventory.coverage_table, [
    'brand_or_channel',
    'baseline_type',
    'coverage_status',
    'active_seed_count',
    'official_host_status',
    'commerce_facts_status',
    'quality_bucket',
    'markets',
    'sample_external_product_ids',
    'priority_tier',
    'transaction_ready',
    'validation_status',
  ]);
  writeCsv(productCsvPath, masterInventory.product_table.map((row) => ({
    ...row,
    blocking_reasons: row.blocking_reasons.join('|'),
  })), [
    'external_product_id',
    'brand',
    'brand_or_channel',
    'channel',
    'seed_type',
    'market',
    'domain',
    'title',
    'coverage_status',
    'merge_bucket',
    'pdp_quality_bucket',
    'conversion_ready',
    'blocking_reasons',
    'official_host_status',
    'price_amount',
    'price_currency',
    'availability',
    'product_line_id',
    'sellable_item_group_id',
    'review_count',
    'review_chart_bucket_count',
    'variant_count',
    'variant_displayable',
    'size_evidence',
    'details_sections_count',
    'faq_count',
    'how_to_chars',
    'inci_chars',
    'product_intel_ready',
    'image_count',
    'unique_image_count',
    'image_duplicate_ratio',
    'canonical_url',
  ]);
  writeCsv(mergeCsvPath, masterInventory.merge_remediation_board, [
    'brand',
    'channel',
    'channel_external_product_id',
    'official_anchor_external_product_id',
    'title',
    'merge_bucket',
    'next_action',
  ]);
  writeCsv(qualityCsvPath, masterInventory.pdp_quality_board.map((row) => ({
    ...row,
    blocking_reasons: row.blocking_reasons.join('|'),
  })), [
    'external_product_id',
    'brand_or_channel',
    'brand',
    'title',
    'seed_type',
    'merge_bucket',
    'pdp_quality_bucket',
    'conversion_ready',
    'blocking_reasons',
    'review_count',
    'variant_displayable',
    'how_to_chars',
    'inci_chars',
    'product_intel_ready',
    'bad_qa',
    'gallery_bloat',
    'currency_mismatch',
    'product_line_id',
    'sellable_item_group_id',
  ]);
  writeCsv(newCoverageCsvPath, masterInventory.new_coverage_board, [
    'baseline_type',
    'brand_or_channel',
    'official_host',
    'priority_tier',
    'transaction_ready',
    'validation_status',
    'next_action',
  ]);
  writeCsv(exceptionCsvPath, masterInventory.exception_board, [
    'exception_type',
    'scope',
    'severity',
    'details',
    'evidence',
  ]);

  process.stdout.write(
    `${JSON.stringify(
      {
        json: jsonPath,
        coverage_csv: coverageCsvPath,
        product_csv: productCsvPath,
        merge_csv: mergeCsvPath,
        quality_csv: qualityCsvPath,
        new_coverage_csv: newCoverageCsvPath,
        exception_csv: exceptionCsvPath,
        coverage_rows: masterInventory.coverage_table.length,
        product_rows: masterInventory.product_table.length,
        merge_rows: masterInventory.merge_remediation_board.length,
      },
      null,
      2,
    )}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  BAD_QA_PATTERNS,
  GALLERY_BLOAT_DUP_RATIO,
  GALLERY_BLOAT_THRESHOLD,
  KNOWN_MERGE_TRACKS,
  KNOWN_SHADOW_HOSTS,
  buildBlockingReasons,
  buildCoverageTable,
  buildMergeBoardFromConsolidation,
  buildDomainMappings,
  chooseQualityBucket,
  computeGalleryHealth,
  determineMergeBucket,
  extractReviewSummary,
  extractVariantSignal,
  hasBadQa,
  mapRowToBaseline,
  normalizeImageAssetKey,
  parseCsv,
  safeHostFromUrl,
};
