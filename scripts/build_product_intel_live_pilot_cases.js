#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { query } = require('../src/db');
const { buildExternalSeedProduct } = require('../src/services/externalSeedProducts');
const {
  filterDisplayableMarketSignalBadges,
  hasDisplayableBadgeEvidence,
  normalizeCommunitySignals: normalizeEvidenceCommunitySignals,
  normalizeMarketSignalBadges: normalizeEvidenceMarketSignalBadges,
  normalizeReviewSummary: normalizeEvidenceReviewSummary,
} = require('../src/services/pivotaEvidenceSignals');
const {
  deriveReviewContractFromManualOverride,
  deriveReviewContractFromReportRow,
  isCoveredByReviewMode,
  normalizeReviewMode,
} = require('../src/services/pivotaProductIntelReviewPolicy');

function buildGatewayHeaders() {
  const apiKey = String(
    process.env.PIVOTA_BACKEND_AGENT_API_KEY ||
      process.env.SHOP_GATEWAY_AGENT_API_KEY ||
      process.env.PIVOTA_AGENT_API_KEY ||
      process.env.AGENT_API_KEY ||
      process.env.PIVOTA_API_KEY ||
      '',
  ).trim();
  const headers = {
    'content-type': 'application/json',
  };
  if (apiKey) {
    headers['X-Agent-API-Key'] = apiKey;
    headers['X-API-Key'] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function parseArgs(argv) {
  const out = {
    gatewayUrl: process.env.PIVOTA_GATEWAY_URL || 'https://agent.pivota.cc/api/gateway',
    productIds: [],
    queries: [],
    surface: '',
    pages: 0,
    frontendBaseUrl: 'https://agent.pivota.cc',
    frontendPaths: [],
    coveredReport: '',
    manualOverrides: '',
    coveredReviewMode: 'strict_human',
    limit: 10,
    perQuery: 12,
    seed: String(process.env.PRODUCT_INTEL_PILOT_SEED || '20260408'),
    out: '',
    requireBadgeEvidence: false,
    excludeCovered: false,
    candidatePoolMultiplier: 4,
    maxPerBrand: 3,
    maxPerCategory: 4,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--gateway-url' && next) {
      out.gatewayUrl = next;
      i += 1;
    } else if (token === '--product-ids' && next) {
      out.productIds = String(next)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
    } else if (token === '--queries' && next) {
      out.queries = String(next)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
    } else if (token === '--surface' && next) {
      out.surface = String(next).trim();
      i += 1;
    } else if (token === '--pages' && next) {
      out.pages = Math.max(0, Number(next) || 0);
      i += 1;
    } else if (token === '--frontend-base-url' && next) {
      out.frontendBaseUrl = String(next).trim().replace(/\/+$/, '');
      i += 1;
    } else if (token === '--frontend-paths' && next) {
      out.frontendPaths = String(next)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
    } else if (token === '--covered-report' && next) {
      out.coveredReport = next;
      i += 1;
    } else if (token === '--manual-overrides' && next) {
      out.manualOverrides = next;
      i += 1;
    } else if (token === '--covered-review-mode' && next) {
      out.coveredReviewMode = normalizeReviewMode(next);
      i += 1;
    } else if (token === '--limit' && next) {
      out.limit = Math.max(1, Number(next) || 10);
      i += 1;
    } else if (token === '--per-query' && next) {
      out.perQuery = Math.max(1, Number(next) || 12);
      i += 1;
    } else if (token === '--seed' && next) {
      out.seed = String(next);
      i += 1;
    } else if (token === '--out' && next) {
      out.out = next;
      i += 1;
    } else if (token === '--require-badge-evidence') {
      out.requireBadgeEvidence = true;
    } else if (token === '--exclude-covered') {
      out.excludeCovered = true;
    } else if (token === '--candidate-pool-multiplier' && next) {
      out.candidatePoolMultiplier = Math.max(1, Number(next) || 4);
      i += 1;
    } else if (token === '--max-per-brand' && next) {
      out.maxPerBrand = Math.max(0, Number(next) || 0);
      i += 1;
    } else if (token === '--max-per-category' && next) {
      out.maxPerCategory = Math.max(0, Number(next) || 0);
      i += 1;
    }
  }

  return out;
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function createSeededRandom(seedText) {
  let h = 2166136261 >>> 0;
  const seed = asString(seedText) || '20260408';
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function random() {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleWithoutReplacement(values, limit, seed) {
  const list = Array.from(new Set(asArray(values).map((item) => asString(item)).filter(Boolean)));
  if (list.length <= limit) return list;
  const random = createSeededRandom(seed);
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, limit);
}

async function loadCoveredProductIdSet(productIds, queryFn = query, reviewMode = 'strict_human') {
  const ids = Array.from(new Set(asArray(productIds).map((item) => asString(item)).filter(Boolean)));
  if (!ids.length || typeof queryFn !== 'function') return new Set();
  const keys = ids.map((id) => `product:${id}`);
  const normalizedMode = normalizeReviewMode(reviewMode);
  try {
    const res = await queryFn(
      `
        SELECT kb_key, source_meta
        FROM aurora_product_intel_kb
        WHERE kb_key = ANY($1::text[])
      `,
      [keys],
    );
    const rows = res && Array.isArray(res.rows) ? res.rows : [];
    return new Set(
      rows
        .filter((row) => isCoveredByReviewMode(row?.source_meta, normalizedMode))
        .map((row) => asString(row.kb_key).replace(/^product:/, ''))
        .filter(Boolean),
    );
  } catch (err) {
    const code = asString(err?.code);
    if (code === 'NO_DATABASE' || code === '42P01') return new Set();
    throw err;
  }
}

function loadCoveredProductIdSetFromReport(reportPath, reviewMode = 'strict_human') {
  if (!reportPath) return new Set();
  const normalizedMode = normalizeReviewMode(reviewMode);
  const reportPaths = String(reportPath)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item) => {
      const resolved = item;
      if (!resolved || !fs.existsSync(resolved)) return [];
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        const discovered = [];
        const queue = [resolved];
        while (queue.length) {
          const current = queue.shift();
          const entries = fs.readdirSync(current, { withFileTypes: true });
          for (const entry of entries) {
            const nextPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
              queue.push(nextPath);
            } else if (entry.isFile() && entry.name === 'compare_final_reviewed.json') {
              discovered.push(nextPath);
            }
          }
        }
        return discovered.sort();
      }
      return [resolved];
    });
  const rows = reportPaths.flatMap((currentReportPath) => {
    const report = readJson(currentReportPath);
    return asArray(report?.rows);
  });
  return new Set(
    rows
      .filter((row) => isCoveredByReviewMode(deriveReviewContractFromReportRow(row), normalizedMode))
      .map((row) =>
        asString(
          row?.selected?.bundle?.canonical_product_ref?.product_id ||
            row?.baseline?.canonical_product_ref?.product_id ||
            row?.canonical_product_ref?.product_id,
        ),
      )
      .filter(Boolean),
  );
}

function loadManualOverrideProductIdSet(manualOverridesPath, reviewMode = 'strict_human') {
  if (!manualOverridesPath || !fs.existsSync(manualOverridesPath)) return new Set();
  const overrides = readJson(manualOverridesPath);
  return new Set(
    Object.entries(overrides || {})
      .filter(([, value]) =>
        isCoveredByReviewMode(deriveReviewContractFromManualOverride(value), reviewMode),
      )
      .map(([key]) => {
        const match = String(key || '').match(/^(?:product:|live_)(ext_[A-Za-z0-9]+)/);
        return match ? match[1] : '';
      })
      .filter(Boolean),
  );
}

function normalizeBrandName(rawBrand) {
  if (!rawBrand) return '';
  if (typeof rawBrand === 'string') return rawBrand.trim();
  if (typeof rawBrand === 'object') {
    return asString(rawBrand.name || rawBrand.brand_name || rawBrand.brandName);
  }
  return '';
}

function findModule(modules, type) {
  return asArray(modules).find((module) => module && module.type === type) || null;
}

function normalizeReviewSummary(value) {
  return normalizeEvidenceReviewSummary(value) || undefined;
}

function normalizeCommunitySignals(value) {
  return normalizeEvidenceCommunitySignals(value) || undefined;
}

function normalizeMarketSignalBadges(value) {
  return normalizeEvidenceMarketSignalBadges(value);
}

function mergeLists(...values) {
  return Array.from(
    new Set(
      values
        .flatMap((value) => asArray(value))
        .map((item) => asString(item))
        .filter(Boolean),
    ),
  );
}

function extractDetailsText(detailsModule, pattern) {
  const sections = asArray(detailsModule?.data?.sections);
  for (const section of sections) {
    const heading = asString(section?.heading || section?.title);
    if (!pattern.test(heading)) continue;
    return asString(section?.body || section?.text || section?.content);
  }
  return '';
}

function extractCanonicalProduct(response) {
  const canonicalModule = findModule(response?.modules, 'canonical');
  return canonicalModule?.data?.pdp_payload?.product || canonicalModule?.data?.product || null;
}

function extractReviewsPreviewSummary(response) {
  const reviewsPreviewModule = findModule(response?.modules, 'reviews_preview');
  const data = reviewsPreviewModule?.data || null;
  if (!data || typeof data !== 'object') return undefined;
  const summary = normalizeReviewSummary({
    rating: data.rating,
    review_count: data.review_count ?? data.reviewCount,
    scale: data.scale,
  });
  if (!summary) return undefined;
  const rating = Number(summary.rating || 0) || 0;
  const reviewCount = Number(summary.review_count || 0) || 0;
  if (rating <= 0 && reviewCount <= 0) return undefined;
  return summary;
}

function buildPilotCaseFromSearchCandidate(candidate) {
  const row = candidate && typeof candidate === 'object' ? candidate : {};
  const merchantId = asString(row.merchant_id || row.merchantId);
  const productId = asString(row.product_id || row.id);
  if (!productId) return null;

  const categoryTags = asArray(row.visible_attributes?.product_category)
    .map((item) => asString(item))
    .filter(Boolean);
  const tags = mergeLists(row.tags, categoryTags);
  const reviewSummary = normalizeReviewSummary({
    rating:
      row.rating ??
      row.rating_value ??
      row.signals?.rating ??
      row.social_proof?.rating ??
      row.attributes?.social_proof?.rating,
    review_count:
      row.review_count ??
      row.reviewCount ??
      row.signals?.review_count ??
      row.social_proof?.review_count ??
      row.attributes?.social_proof?.review_count,
  });

  return {
    case_id: `live_${productId}`,
    notes: `Live pilot case sampled from public search results (${asString(row.brand || row.vendor || row.merchant_name) || 'unknown brand'}).`,
    canonical_product_ref: {
      merchant_id: merchantId || 'unknown',
      product_id: productId,
    },
    product: {
      merchant_id: merchantId || 'unknown',
      product_id: productId,
      brand: asString(row.brand || row.vendor || row.merchant_name),
      title: asString(row.title || row.name),
      category: asString(row.category || row.product_type),
      description: asString(row.description_text || row.description),
      tags,
      review_summary: reviewSummary,
    },
  };
}

function buildPilotCaseFromPdpResponse(response, seedCase) {
  const subject = response?.subject || {};
  const canonicalRef = subject?.canonical_product_ref || null;
  const product = extractCanonicalProduct(response);
  if (!product || !canonicalRef?.product_id) return null;

  const detailsModule = findModule(response?.modules, 'product_details');
  const ingredientsModule = findModule(response?.modules, 'ingredients_inci');
  const intelModule = findModule(response?.modules, 'product_intel');
  const productIntel = intelModule?.data || {};
  const reviewsPreviewSummary = extractReviewsPreviewSummary(response);
  const seedProduct = seedCase?.product && typeof seedCase.product === 'object' ? seedCase.product : {};

  const brand = normalizeBrandName(product.brand);
  const categoryPath = asArray(product.category_path).map((item) => asString(item)).filter(Boolean);
  const category = categoryPath.length ? categoryPath.join('/') : asString(product.category || product.product_type);
  const howToUse = extractDetailsText(detailsModule, /how to use|directions/i);
  const overview = extractDetailsText(detailsModule, /overview|details|description/i);
  const ingredients = asArray(
    ingredientsModule?.data?.ingredients_inci ||
      ingredientsModule?.data?.ingredients ||
      product.ingredients_inci ||
      product.ingredients,
  )
    .map((item) => asString(item?.inci || item))
    .filter(Boolean);
  const normalizedReviewSummary =
    normalizeReviewSummary(productIntel.review_summary) ||
    reviewsPreviewSummary ||
    normalizeReviewSummary(seedProduct.review_summary) ||
    normalizeReviewSummary({
      rating: product.rating,
      review_count: product.review_count ?? product.reviewCount,
    });
  const normalizedCommunitySignals =
    normalizeCommunitySignals(productIntel.community_signals) || seedProduct.community_signals;
  const displayableBadges = filterDisplayableMarketSignalBadges(
    [
      ...normalizeMarketSignalBadges(productIntel.market_signal_badges),
      ...normalizeMarketSignalBadges(seedProduct.market_signal_badges),
    ],
    {
      review_summary: normalizedReviewSummary,
      community_signals: normalizedCommunitySignals,
    },
  );

  return {
    case_id: `live_${canonicalRef.product_id}`,
    notes:
      seedCase?.notes ||
      `Live pilot case sampled from public /products listing (${brand || 'unknown brand'}).`,
    canonical_product_ref: canonicalRef,
    product: {
      merchant_id: canonicalRef.merchant_id,
      product_id: canonicalRef.product_id,
      brand: brand || asString(seedProduct.brand),
      title: asString(product.title || product.name) || asString(seedProduct.title),
      category: category || asString(seedProduct.category),
      description: asString(product.description || overview) || asString(seedProduct.description),
      tags: mergeLists(seedProduct.tags, categoryPath),
      texture: asString(product.texture),
      finish: asString(product.finish),
      ingredients_inci: ingredients,
      how_to_use: howToUse,
      review_summary: normalizedReviewSummary,
      ...(normalizedCommunitySignals ? { community_signals: normalizedCommunitySignals } : {}),
      ...(displayableBadges.length ? { market_signal_badges: displayableBadges } : {}),
      ...(asString(productIntel.evidence_profile || seedProduct.evidence_profile)
        ? {
            evidence_profile: asString(productIntel.evidence_profile || seedProduct.evidence_profile),
          }
        : {}),
    },
  };
}

function buildPilotCaseFromExternalSeedProduct(product, seedCase) {
  if (!product || typeof product !== 'object') return null;
  const productId = asString(product.id || product.product_id);
  if (!productId) return null;
  const seedProduct = seedCase?.product && typeof seedCase.product === 'object' ? seedCase.product : {};
  const brand = normalizeBrandName(product.brand) || asString(seedProduct.brand);
  const categoryPath = asArray(product.category_path).map((item) => asString(item)).filter(Boolean);
  const category = categoryPath.length ? categoryPath.join('/') : asString(product.category || product.product_type || seedProduct.category);
  const ingredients = asArray(product.ingredients_inci || product.ingredients)
    .map((item) => asString(item?.inci || item))
    .filter(Boolean);
  const normalizedReviewSummary =
    normalizeReviewSummary(product.review_summary) ||
    normalizeReviewSummary({
      rating: product.rating,
      review_count: product.review_count ?? product.reviewCount,
    }) ||
    normalizeReviewSummary(seedProduct.review_summary);
  const normalizedCommunitySignals = normalizeCommunitySignals(seedProduct.community_signals);
  const displayableBadges = filterDisplayableMarketSignalBadges(
    normalizeMarketSignalBadges(seedProduct.market_signal_badges),
    {
      review_summary: normalizedReviewSummary,
      community_signals: normalizedCommunitySignals,
    },
  );

  return {
    case_id: `live_${productId}`,
    notes:
      seedCase?.notes ||
      `Live pilot case sampled from external product seeds (${brand || 'unknown brand'}).`,
    canonical_product_ref: {
      merchant_id: asString(product.merchant_id || seedCase?.canonical_product_ref?.merchant_id || 'external_seed'),
      product_id: productId,
    },
    product: {
      merchant_id: asString(product.merchant_id || seedCase?.canonical_product_ref?.merchant_id || 'external_seed'),
      product_id: productId,
      brand,
      title: asString(product.title || product.name || seedProduct.title),
      category,
      description: asString(product.description || seedProduct.description),
      tags: mergeLists(seedProduct.tags, categoryPath, product.alias_tokens, product.ingredient_tokens),
      texture: asString(product.texture || seedProduct.texture),
      finish: asString(product.finish || seedProduct.finish),
      ingredients_inci: ingredients,
      how_to_use: asString(product.how_to_use || product.usage || seedProduct.how_to_use),
      review_summary: normalizedReviewSummary,
      ...(normalizedCommunitySignals ? { community_signals: normalizedCommunitySignals } : {}),
      ...(displayableBadges.length ? { market_signal_badges: displayableBadges } : {}),
      ...(asString(seedProduct.evidence_profile) ? { evidence_profile: asString(seedProduct.evidence_profile) } : {}),
    },
  };
}

async function fetchExternalSeedProduct(productId) {
  const normalizedId = asString(productId);
  if (!normalizedId) return null;
  const res = await query(
    `
      SELECT
        id,
        external_product_id,
        destination_url,
        canonical_url,
        domain,
        title,
        image_url,
        price_amount,
        price_currency,
        availability,
        seed_data,
        status,
        attached_product_key,
        created_at,
        updated_at
      FROM external_product_seeds
      WHERE status = 'active'
        AND attached_product_key IS NULL
        AND (
          id::text = $1
          OR external_product_id = $1
          OR coalesce(seed_data->>'external_product_id', '') = $1
          OR coalesce(seed_data->>'product_id', '') = $1
          OR coalesce(seed_data->'snapshot'->>'product_id', '') = $1
        )
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `,
    [normalizedId],
  );
  const row = res?.rows && res.rows[0] ? res.rows[0] : null;
  if (!row) return null;
  return buildExternalSeedProduct(row);
}

function hasBadgeEvidence(caseRow) {
  const product = caseRow?.product && typeof caseRow.product === 'object' ? caseRow.product : {};
  return hasDisplayableBadgeEvidence({
    market_signal_badges: normalizeMarketSignalBadges(product.market_signal_badges),
    review_summary: normalizeReviewSummary(product.review_summary),
    community_signals: normalizeCommunitySignals(product.community_signals),
  });
}

function selectDiverseCases(cases, { limit, seed, maxPerBrand, maxPerCategory }) {
  const rows = asArray(cases).filter((row) => row && !row.error);
  if (!rows.length) return [];
  const shuffled = sampleWithoutReplacement(rows.map((row) => JSON.stringify(row)), rows.length, seed)
    .map((item) => JSON.parse(item));
  const selected = [];
  const brandCounts = new Map();
  const categoryCounts = new Map();

  for (const row of shuffled) {
    if (selected.length >= limit) break;
    const product = row.product && typeof row.product === 'object' ? row.product : {};
    const brandKey = asString(product.brand).toLowerCase();
    const categoryKey = asString(product.category).toLowerCase();
    if (maxPerBrand > 0 && brandKey && (brandCounts.get(brandKey) || 0) >= maxPerBrand) continue;
    if (maxPerCategory > 0 && categoryKey && (categoryCounts.get(categoryKey) || 0) >= maxPerCategory) continue;
    selected.push(row);
    if (brandKey) brandCounts.set(brandKey, (brandCounts.get(brandKey) || 0) + 1);
    if (categoryKey) categoryCounts.set(categoryKey, (categoryCounts.get(categoryKey) || 0) + 1);
  }

  return selected;
}

async function fetchSearchCandidates(gatewayUrl, query, limit) {
  const body = {
    operation: 'find_products_multi',
    payload: {
      search: {
        query,
        limit,
        in_stock_only: true,
      },
    },
    metadata: {
      source: 'product_intel_live_pilot_builder',
    },
  };

  const response = await axios.post(gatewayUrl, body, {
    timeout: 30000,
    headers: buildGatewayHeaders(),
  });
  return asArray(response.data?.products);
}

async function fetchDiscoveryCandidates(gatewayUrl, surface, page, limit) {
  const body = {
    operation: 'get_discovery_feed',
    payload: {
      surface,
      page,
      limit,
      response_detail: 'card',
      context: {
        locale: 'en-US',
      },
    },
    metadata: {
      source: 'product_intel_live_pilot_builder',
    },
  };

  const response = await axios.post(gatewayUrl, body, {
    timeout: 30000,
    headers: buildGatewayHeaders(),
  });
  return asArray(response.data?.products);
}

function extractProductIdsFromFrontendHtml(html) {
  const ids = new Set();
  const source = asString(html);
  const pattern = /\/products\/([^"'?#\s<]+)/g;
  let match = pattern.exec(source);
  while (match) {
    const id = asString(match[1]);
    if (id) ids.add(id);
    match = pattern.exec(source);
  }
  return Array.from(ids);
}

async function fetchFrontendProductIds(baseUrl, pagePath) {
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}${pagePath.startsWith('/') ? pagePath : `/${pagePath}`}`;
  const response = await axios.get(url, {
    timeout: 30000,
    headers: {
      accept: 'text/html,application/xhtml+xml',
    },
  });
  return extractProductIdsFromFrontendHtml(response.data);
}

async function fetchPdpResponse(gatewayUrl, productId) {
  const body = {
    operation: 'get_pdp_v2',
    payload: {
      product_ref: {
        product_id: productId,
      },
      include: ['canonical', 'product_details', 'ingredients_inci', 'product_intel', 'reviews_preview', 'offers'],
      options: {
        debug: false,
      },
    },
    metadata: {
      source: 'product_intel_live_pilot_builder',
    },
  };

  const response = await axios.post(gatewayUrl, body, {
    timeout: 20000,
    headers: buildGatewayHeaders(),
  });
  return response.data;
}

async function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(__dirname, '..');
  let selectedIds = sampleWithoutReplacement(args.productIds, args.limit, args.seed);
  let seedCases = [];
  const queryErrors = [];
  let coveredProductIds = new Set();
  const coveredReportPath = resolvePath(rootDir, args.coveredReport);
  const reportCoveredProductIds = loadCoveredProductIdSetFromReport(
    coveredReportPath,
    args.coveredReviewMode,
  );
  const manualOverrideProductIds = loadManualOverrideProductIdSet(
    resolvePath(rootDir, args.manualOverrides),
    args.coveredReviewMode,
  );

  if (!selectedIds.length && (args.queries.length || (args.surface && args.pages > 0) || args.frontendPaths.length)) {
    const candidates = [];
    if (args.queries.length) {
      for (const query of args.queries) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const rows = await fetchSearchCandidates(args.gatewayUrl, query, args.perQuery);
          candidates.push(...rows);
        } catch (err) {
          queryErrors.push({
            query,
            error: asString(err?.message || err),
          });
        }
      }
    }
    if (args.surface && args.pages > 0) {
      for (let page = 1; page <= args.pages; page += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const rows = await fetchDiscoveryCandidates(args.gatewayUrl, args.surface, page, args.perQuery);
          candidates.push(...rows);
        } catch (err) {
          queryErrors.push({
            surface: args.surface,
            page,
            error: asString(err?.message || err),
          });
        }
      }
    }
    const frontendSeedCases = [];
    if (args.frontendPaths.length) {
      for (const pagePath of args.frontendPaths) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const ids = await fetchFrontendProductIds(args.frontendBaseUrl, pagePath);
          for (const productId of ids) {
            frontendSeedCases.push({
              case_id: `live_${productId}`,
              notes: `Live pilot case sampled from frontend route ${pagePath}.`,
              canonical_product_ref: {
                merchant_id: 'external_seed',
                product_id: productId,
              },
              product: {
                merchant_id: 'external_seed',
                product_id: productId,
              },
            });
          }
        } catch (err) {
          queryErrors.push({
            frontend_path: pagePath,
            error: asString(err?.message || err),
          });
        }
      }
    }
    const dedupedCases = [
      ...candidates.map((row) => buildPilotCaseFromSearchCandidate(row)).filter(Boolean),
      ...frontendSeedCases,
    ];
    const byProductId = new Map(dedupedCases.map((row) => [row.canonical_product_ref.product_id, row]));
    let candidateIds = Array.from(byProductId.keys());
    if (args.excludeCovered) {
      coveredProductIds = await loadCoveredProductIdSet(
        candidateIds,
        query,
        args.coveredReviewMode,
      ).catch(() => new Set());
      const allCovered = new Set([...coveredProductIds, ...reportCoveredProductIds, ...manualOverrideProductIds]);
      candidateIds = candidateIds.filter((id) => !allCovered.has(id));
      coveredProductIds = allCovered;
    }
    const candidatePoolLimit = Math.max(args.limit, Math.trunc(args.limit * args.candidatePoolMultiplier));
    selectedIds = sampleWithoutReplacement(candidateIds, candidatePoolLimit, args.seed);
    seedCases = selectedIds.map((id) => byProductId.get(id)).filter(Boolean);
  }

  if (!selectedIds.length) {
    throw new Error('missing_product_ids_or_queries');
  }

  const cases = [];
  for (const productId of selectedIds) {
    const seedCase = seedCases.find((row) => row?.canonical_product_ref?.product_id === productId) || null;
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchPdpResponse(args.gatewayUrl, productId);
      let row = buildPilotCaseFromPdpResponse(response, seedCase);
      if (!row) {
        // Fall back to external seed truth when invoke resolution is unavailable.
        // eslint-disable-next-line no-await-in-loop
        const externalSeedProduct = await fetchExternalSeedProduct(productId);
        row = buildPilotCaseFromExternalSeedProduct(externalSeedProduct, seedCase);
      }
      if (row) {
        cases.push(row);
      } else {
        cases.push({
          ...(seedCase || {
            case_id: `live_${productId}`,
            canonical_product_ref: {
              merchant_id: 'unknown',
              product_id: productId,
            },
          }),
          notes: `Pilot fetch returned no canonical product: ${productId}`,
          error: 'missing_canonical_product',
        });
      }
    } catch (err) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const externalSeedProduct = await fetchExternalSeedProduct(productId);
        const fallbackRow = buildPilotCaseFromExternalSeedProduct(externalSeedProduct, seedCase);
        if (fallbackRow) {
          cases.push(fallbackRow);
          continue;
        }
      } catch {
        // Keep original fetch error below when the DB fallback also fails.
      }
      cases.push({
        ...(seedCase || {
          case_id: `live_${productId}`,
          canonical_product_ref: {
            merchant_id: 'unknown',
            product_id: productId,
          },
        }),
        notes: `Pilot fetch failed: ${asString(err?.message || err)}`,
        error: asString(err?.message || err),
      });
    }
  }

  const eligibleCases = args.requireBadgeEvidence ? cases.filter((row) => hasBadgeEvidence(row)) : cases;
  const finalCases = selectDiverseCases(eligibleCases, {
    limit: args.limit,
    seed: args.seed,
    maxPerBrand: args.maxPerBrand,
    maxPerCategory: args.maxPerCategory,
  });

  const outputPath = resolvePath(
    rootDir,
    args.out || `reports/product_intel_live_pilot_cases_${args.seed}.json`,
  );
  writeJson(outputPath, finalCases);

  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      requested: selectedIds.length,
      built: cases.filter((row) => !row.error).length,
      selected: finalCases.length,
      filtered_badge_cases: args.requireBadgeEvidence ? eligibleCases.length : undefined,
      excluded_covered: args.excludeCovered ? coveredProductIds.size : 0,
      covered_review_mode: args.excludeCovered ? args.coveredReviewMode : undefined,
      out: outputPath,
      product_ids: finalCases.map((row) => row?.canonical_product_ref?.product_id).filter(Boolean),
      query_errors: queryErrors,
    })}\n`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildPilotCaseFromPdpResponse,
  buildPilotCaseFromSearchCandidate,
  extractReviewsPreviewSummary,
  fetchDiscoveryCandidates,
  fetchFrontendProductIds,
  fetchPdpResponse,
  fetchSearchCandidates,
  hasBadgeEvidence,
  loadCoveredProductIdSet,
  loadCoveredProductIdSetFromReport,
  loadManualOverrideProductIdSet,
  parseArgs,
  sampleWithoutReplacement,
  selectDiverseCases,
  extractProductIdsFromFrontendHtml,
  buildPilotCaseFromExternalSeedProduct,
  fetchExternalSeedProduct,
};
