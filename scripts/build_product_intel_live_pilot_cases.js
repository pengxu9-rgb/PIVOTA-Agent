#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { closePool, query } = require('../src/db');
const { buildExternalSeedProduct } = require('../src/services/externalSeedProducts');
const {
  summarizePdpIdentityCoverageByBrand,
  _internals: pdpIdentityInternals = {},
} = require('../src/services/pdpIdentityGraph');
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

const pdpIdentityFetchBackfillProducts =
  typeof pdpIdentityInternals.fetchBackfillProducts === 'function'
    ? pdpIdentityInternals.fetchBackfillProducts
    : null;

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
    identityBrands: [],
    supplementalProductIds: [],
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
    identityTopBrands: 0,
    identityPerBrandLimit: 3,
    identityMinSourceRows: 1,
    identityMinReviewRatio: 0,
    identityBeautyOnly: false,
    out: '',
    requireBadgeEvidence: false,
    excludeCovered: false,
    candidatePoolMultiplier: 4,
    maxPerBrand: 3,
    maxPerCategory: 4,
    fetchSourceReviews: String(process.env.PIVOTA_INSIGHTS_FETCH_SOURCE_REVIEWS || '').trim() === '1',
    fetchSourceFacts: String(process.env.PIVOTA_INSIGHTS_FETCH_SOURCE_FACTS || '').trim() === '1',
    sourceReviewTimeoutMs: Math.max(1000, Number(process.env.PIVOTA_INSIGHTS_SOURCE_REVIEW_TIMEOUT_MS || 15000) || 15000),
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
    } else if (token === '--product-refs' && next) {
      out.productIds = out.productIds.concat(
        String(next)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      );
      i += 1;
    } else if (token === '--identity-brands' && next) {
      out.identityBrands = String(next)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
    } else if (token === '--supplemental-product-ids' && next) {
      out.supplementalProductIds = String(next)
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
    } else if (token === '--identity-top-brands' && next) {
      out.identityTopBrands = Math.max(0, Number(next) || 0);
      i += 1;
    } else if (token === '--identity-per-brand-limit' && next) {
      out.identityPerBrandLimit = Math.max(0, Number(next) || 0);
      i += 1;
    } else if (token === '--identity-min-source-rows' && next) {
      out.identityMinSourceRows = Math.max(0, Number(next) || 0);
      i += 1;
    } else if (token === '--identity-min-review-ratio' && next) {
      out.identityMinReviewRatio = Number(next) || 0;
      i += 1;
    } else if (token === '--identity-beauty-only') {
      out.identityBeautyOnly = true;
    } else if (token === '--identity-include-non-beauty') {
      out.identityBeautyOnly = false;
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
    } else if (token === '--fetch-source-reviews') {
      out.fetchSourceReviews = true;
    } else if (token === '--no-fetch-source-reviews') {
      out.fetchSourceReviews = false;
    } else if (token === '--fetch-source-facts') {
      out.fetchSourceFacts = true;
    } else if (token === '--no-fetch-source-facts') {
      out.fetchSourceFacts = false;
    } else if (token === '--source-review-timeout-ms' && next) {
      out.sourceReviewTimeoutMs = Math.max(1000, Number(next) || out.sourceReviewTimeoutMs);
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

function parseProductRefInput(value) {
  const raw = asString(value);
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const productId = asString(parsed.product_id || parsed.productId);
      const merchantId = asString(parsed.merchant_id || parsed.merchantId);
      if (!productId) return null;
      return {
        product_id: productId,
        ...(merchantId ? { merchant_id: merchantId } : {}),
      };
    } catch {
      return null;
    }
  }
  const [left, ...rest] = raw.split(':');
  if (rest.length > 0) {
    const merchantId = asString(left);
    const productId = asString(rest.join(':'));
    if (!productId) return null;
    return {
      product_id: productId,
      ...(merchantId ? { merchant_id: merchantId } : {}),
    };
  }
  return { product_id: raw };
}

function normalizeProductRefInputs(values) {
  const refs = [];
  const seen = new Set();
  for (const value of asArray(values)) {
    const ref = parseProductRefInput(value);
    if (!ref?.product_id) continue;
    const key = `${asString(ref.merchant_id)}:${ref.product_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function productRefByProductId(values) {
  const out = new Map();
  for (const ref of normalizeProductRefInputs(values)) {
    if (!ref?.product_id || !ref?.merchant_id) continue;
    out.set(ref.product_id, {
      merchant_id: ref.merchant_id,
      product_id: ref.product_id,
    });
  }
  return out;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toList(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeProductIntelDescription(value) {
  const text = asString(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/…$|\.\.\.$/.test(text)) return '';
  if (
    /\b(?:a|an|the|and|or|of|in|to|with|without|while|featuring|including|into|for|from|by|as|that|visible|support|supports|target|targets|provide|provides|deliver|delivers|improve|improves|reduce|reduces|calm|calms|derived|based|skin|ski)$/i.test(
      text.replace(/[.!?;,:\s]+$/g, ''),
    )
  ) {
    return '';
  }
  return text;
}

function isNoisyProductIntelDescription(value) {
  const text = normalizeProductIntelDescription(value);
  if (!text) return true;
  if (text.length > 900) return true;
  if (/^(?:details|description|overview|benefits|key features|key benefits)\b/i.test(text)) {
    return true;
  }
  if (/\b(?:Details Benefits|Details Key Features|Read More|Read more|Shade Finder Quiz)\b/i.test(text)) {
    return true;
  }
  return false;
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
        const match = String(key || '').match(/^(?:product:|live_)([^:\s]+)/);
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

function extractStructuredModuleText(module) {
  const data = module?.data && typeof module.data === 'object' ? module.data : {};
  const direct = asString(data.raw_text || data.rawText || data.text || data.body || data.content);
  if (direct) return direct;
  const items = [
    ...asArray(data.steps),
    ...asArray(data.items),
    ...asArray(data.ingredients_inci),
    ...asArray(data.ingredients),
  ]
    .map((item) => asString(item?.inci || item?.name || item?.text || item))
    .filter(Boolean);
  return items.join(' ');
}

function extractCanonicalPayload(response) {
  const canonicalModule = findModule(response?.modules, 'canonical');
  return canonicalModule?.data?.pdp_payload || null;
}

function extractCanonicalProduct(response) {
  const canonicalModule = findModule(response?.modules, 'canonical');
  return extractCanonicalPayload(response)?.product || canonicalModule?.data?.product || null;
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

function parseReviewNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(/[, ]+/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function buildReviewBackedCommunitySignals(reviewSummary, fallback = {}) {
  const summary = normalizeReviewSummary(reviewSummary);
  const rating = Number(summary?.rating || 0);
  const reviewCount = Number(summary?.review_count || 0);
  if (!Number.isFinite(rating) || !Number.isFinite(reviewCount) || rating < 4.5 || reviewCount < 100) {
    return normalizeCommunitySignals(fallback);
  }
  const existing = fallback && typeof fallback === 'object' ? fallback : {};
  const existingCounts =
    existing.source_counts && typeof existing.source_counts === 'object' ? existing.source_counts : {};
  return {
    ...existing,
    status: 'available',
    source_counts: {
      ...existingCounts,
      reviews: Math.max(Number(existingCounts.reviews || 0) || 0, reviewCount),
    },
    last_refreshed_at: asString(existing.last_refreshed_at || existing.lastRefreshedAt) || new Date().toISOString(),
  };
}

function extractReviewSummaryFromTextBlock(block) {
  const text = asString(block).replace(/&quot;/g, '"');
  if (!text) return undefined;
  const ratingMatch =
    text.match(/["']reviewAverageValue["']\s*:\s*["']?([\d.]+)/i) ||
    text.match(/["']ratingValue["']\s*:\s*["']?([\d.]+)/i) ||
    text.match(/["']value["']\s*:\s*["']?([\d.]+)/i) ||
    text.match(/["']rating["']\s*:\s*["']?([\d.]+)/i) ||
    text.match(/["']average_rating["']\s*:\s*["']?([\d.]+)/i);
  const countMatch =
    text.match(/["']reviewCount["']\s*:\s*["']?([\d,]+)/i) ||
    text.match(/["']review_count["']\s*:\s*["']?([\d,]+)/i) ||
    text.match(/["']total_reviews["']\s*:\s*["']?([\d,]+)/i) ||
    text.match(/["']rating_count["']\s*:\s*["']?([\d,]+)/i) ||
    text.match(/["']ratingCount["']\s*:\s*["']?([\d,]+)/i);
  return normalizeReviewSummary({
    rating: parseReviewNumber(ratingMatch?.[1]),
    review_count: parseReviewNumber(countMatch?.[1]),
  });
}

function decodeHtmlEntities(value) {
  return asString(value)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtmlToText(value) {
  return decodeHtmlEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseJsonStringLiteral(value) {
  const raw = asString(value);
  if (!raw) return '';
  try {
    return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`);
  } catch {
    try {
      return JSON.parse(`"${raw}"`);
    } catch {
      return decodeHtmlEntities(raw);
    }
  }
}

function extractJsonStringProperty(source, propertyName) {
  const pattern = new RegExp(`"${propertyName}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i');
  const match = asString(source).match(pattern);
  return match ? parseJsonStringLiteral(match[1]) : '';
}

function extractJsonStringProperties(source, propertyName) {
  const pattern = new RegExp(`"${propertyName}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'gi');
  return Array.from(asString(source).matchAll(pattern))
    .map((match) => parseJsonStringLiteral(match[1]))
    .filter(Boolean);
}

function extractLikelyProductDescriptionHtml(source, propertyName) {
  const candidates = extractJsonStringProperties(source, propertyName)
    .map((value) => asString(value))
    .filter((value) => {
      const text = stripHtmlToText(value);
      if (text.length < 60) return false;
      return /<p\b|<br\b|full\s+ingredients?|key\s+ingredients?|how\s+to\s+use|directions|benefits?/i.test(value);
    });
  candidates.sort((left, right) => {
    const score = (value) => {
      let out = 0;
      if (/\bfull\s+ingredients?\b/i.test(value)) out += 10;
      if (/\bhow\s+to\s+use\b/i.test(value)) out += 3;
      if (/<p\b/i.test(value)) out += 2;
      out += Math.min(4, Math.floor(stripHtmlToText(value).length / 500));
      return out;
    };
    return score(right) - score(left);
  });
  return candidates[0] || '';
}

function extractHtmlAttributeValue(source, attrName) {
  const pattern = new RegExp(`${attrName}\\s*=\\s*["']([^"']*)["']`, 'i');
  const match = asString(source).match(pattern);
  return match ? decodeHtmlEntities(match[1]) : '';
}

function extractMetaDescription(source) {
  for (const match of asString(source).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const name = extractHtmlAttributeValue(tag, 'name').toLowerCase();
    const property = extractHtmlAttributeValue(tag, 'property').toLowerCase();
    if (
      name === 'description' ||
      property === 'og:description' ||
      property === 'twitter:description'
    ) {
      const content = cleanSourceDescription(extractHtmlAttributeValue(tag, 'content'));
      if (content) return content;
    }
  }
  return '';
}

function normalizeSourceFactText(value) {
  return stripHtmlToText(value)
    .replace(/\s+/g, ' ')
    .replace(/^OFFICIAL:\s*/i, '')
    .replace(/\bRead More\.?$/i, '')
    .trim();
}

function isUsableSourceDescription(value) {
  const text = normalizeSourceFactText(value);
  if (text.length < 40) return false;
  if (/…$|\.\.\.$/.test(text)) return false;
  if (/\b(?:ingredients?|how to use|other details|shipping|returns|secure checkout)\b/i.test(text.slice(0, 80))) {
    return false;
  }
  if (looksLikeDelimitedIngredientBlock(text)) return false;
  return true;
}

function stripLeadingDescriptionHeadings(value) {
  let text = asString(value);
  for (let i = 0; i < 4; i += 1) {
    const next = text
      .replace(/^(?:details|description|overview|benefits|key benefits|key features|features)\s*[:\-]?\s*/i, '')
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

function trimSourceDescriptionSections(value) {
  const text = stripLeadingDescriptionHeadings(value);
  const markerMatch = text.match(
    /\s(?:How to Use|Directions|Other Details|FAQ|Frequently Asked Questions|Results|Clinical Results|Key Features|Key Benefits|Benefits|How It Feels|When to Use|Effortless Skin Enhancement|Lightweight,\s*All-in-One Coverage|12 Versatile Shades|Shade Finder)\b/i,
  );
  const trimmed = markerMatch ? text.slice(0, markerMatch.index).trim() : text;
  if (trimmed.length <= 420) return trimmed;
  const sentenceEnd = trimmed.slice(0, 420).search(/[.!?](?=\s|$)(?!.*[.!?](?=\s|$))/);
  if (sentenceEnd >= 120) return trimmed.slice(0, sentenceEnd + 1).trim();
  const wordBoundary = trimmed.slice(0, 420).replace(/\s+\S*$/, '').trim();
  return wordBoundary || trimmed.slice(0, 420).trim();
}

function cleanSourceDescription(value) {
  const text = normalizeSourceFactText(value);
  if (!isUsableSourceDescription(text)) return '';
  const trimmed = trimSourceDescriptionSections(text);
  return isUsableSourceDescription(trimmed) ? trimmed : '';
}

function extractParagraphTextFromHtml(html) {
  const paragraphs = [];
  for (const match of asString(html).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = cleanSourceDescription(match[1]);
    if (text) paragraphs.push(text);
  }
  if (
    paragraphs.length >= 2 &&
    paragraphs[0].length <= 70 &&
    !/[.!?]$/.test(paragraphs[0])
  ) {
    const combined = cleanSourceDescription(`${paragraphs[0]} ${paragraphs[1]}`);
    if (combined) return combined;
  }
  const substantial = paragraphs.find((text) => text.length >= 60);
  if (substantial) return substantial;
  return paragraphs[0] || '';
}

function normalizeIngredientName(value) {
  let text = stripHtmlToText(value)
    .replace(/\s+/g, ' ')
    .replace(/\s+[-–—:]\s*\d+(?:\.\d+)?\s*(?:%|ppm)?\s*.*$/i, '')
    .replace(/\s+\d+(?:\.\d+)?\s*(?:%|ppm)\s*.*$/i, '')
    .trim();
  text = text.replace(/^[•*\-\s]+/, '').replace(/[.;,]+$/, '').trim();
  if (!text) return '';
  if (/^(?:key features|how it works|scent|size)\b/i.test(text)) return '';
  if (/\b(?:your|our|skin|order|checkout|glow|routine|texture|benefits?|results?|instantly|clinically|moisturiz(?:e|es|ing)|hydrate(?:s|d|ing)?|supports?|helps?|helping|contains?|formulated|wear|coverage|shades?|versatile|tint|lightweight|makeup|finder|spf|including|combine|fast-acting|growth factors?|sunburn|premature|aging|reflect|scatter|rays|protection|broad-spectrum|uva|uvb|effectively)\b/i.test(text)) {
    return '';
  }
  if (
    /^(?:ingredients?|key ingredients?|version|other details|description|how to use|directions|disclaimer|size|pH|never tested|free shipping)$/i.test(
      text,
    )
  ) {
    return '';
  }
  if (text.length > 120) return '';
  if (!/[a-z]/i.test(text)) return '';
  return text;
}

function pushIngredientName(out, value) {
  const name = normalizeIngredientName(value);
  if (!name) return;
  const key = name.toLowerCase();
  if (out.some((item) => item.toLowerCase() === key)) return;
  out.push(name);
}

function normalizeIngredientListForPilot(value) {
  const out = [];
  for (const item of asArray(value)) {
    pushIngredientName(out, item?.inci || item);
  }
  return out;
}

function findIngredientBlockStart(source) {
  const text = asString(source);
  const strongPatterns = [
    /\bfull\s+ingredients?\b/i,
    /\bingredients?\s+list\b/i,
    /\bINCI\b/i,
  ];
  for (const pattern of strongPatterns) {
    const match = text.match(pattern);
    if (match) return match.index + match[0].length;
  }
  const headingMatch = text.match(/(?:^|\n)\s*(?:ingredients?|key ingredients?)\b/i);
  if (headingMatch) return headingMatch.index + headingMatch[0].length;
  return -1;
}

function startsLikeIngredientList(value) {
  const first = trimToIngredientListStart(normalizeSourceFactText(value)).split(/,\s+/)[0] || '';
  return /^(?:water(?:\s|\(|$)|aqua(?:\s|\(|$)|eau(?:\s|\(|$)|zinc oxide\b|titanium dioxide\b|glycerin\b|butylene glycol\b|propanediol\b|niacinamide\b|alcohol denat\b|dimethicone\b|caprylic\/capric\b|coco-caprylate\b|isododecane\b|cyclopentasiloxane\b)/i.test(
    first.trim(),
  );
}

function trimToIngredientListStart(value) {
  const text = normalizeSourceFactText(value);
  const match = text.match(
    /\b(?:water(?:\s|\(|,)|aqua(?:\s|\(|,)|eau(?:\s|\(|,)|zinc oxide\b|titanium dioxide\b|glycerin\b|butylene glycol\b|propanediol\b|niacinamide\b|alcohol denat\b|dimethicone\b|caprylic\/capric\b|coco-caprylate\b|isododecane\b|cyclopentasiloxane\b)/i,
  );
  if (!match || match.index == null || match.index > 120) return text;
  return text.slice(match.index).trim();
}

function looksLikeDelimitedIngredientBlock(value) {
  const text = trimToIngredientListStart(value);
  if (text.length < 35 || text.length > 3000) return false;
  if ((text.match(/,/g) || []).length < 3) return false;
  if (!startsLikeIngredientList(text)) return false;
  if (looksLikeCorruptedIngredientBlock(text)) return false;
  if (
    !/\b(?:water|aqua|eau|glycerin|zinc oxide|titanium dioxide|niacinamide|butylene glycol|propanediol|caprylic|sodium|dimethicone|alcohol denat)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return !/\b(?:shipping|returns|shade finder|secure checkout|review|quiz)\b/i.test(text.slice(0, 120));
}

function looksLikeCorruptedIngredientBlock(value) {
  const text = normalizeSourceFactText(value);
  const corruptionSignals = [
    /\bDibuyiAdipate\b/i,
    /\bButylocty\b/i,
    /\bEthylhexy\/Trazone\b/i,
    /\bTerephthalyidene\b/i,
    /\bHydroxybenzovi\b/i,
    /\bCeteary Alcohol\b/i,
    /\bCapryivi\b/i,
    /\bPolvsilicone\b/i,
    /\bVitis-idata\b/i,
    /\bsisesquioxane\b/i,
    /\bMethyloropanedid\b/i,
    /\bAcryloyldimethyta\b/i,
    /\bCrosspoly mer\b/i,
    /\bEthyhexviglycerin\b/i,
    /\bPolvether\b/i,
    /\bPolyglycer\s+y\//i,
  ];
  return corruptionSignals.filter((pattern) => pattern.test(text)).length >= 2;
}

function extractDelimitedIngredientNames(value) {
  const text = trimToIngredientListStart(
    normalizeSourceFactText(value)
      .replace(/^(?:full\s+)?ingredients?\s*(?:list)?\s*[:\-]?\s*/i, '')
      .trim(),
  );
  if (!looksLikeDelimitedIngredientBlock(text)) return [];
  return text
    .split(/,\s+/)
    .map((item) => normalizeIngredientName(item))
    .filter(Boolean);
}

function extractIngredientNamesFromText(text) {
  const source = stripHtmlToText(text);
  if (!source) return [];
  const ingredientStart = findIngredientBlockStart(source);
  const scoped = ingredientStart >= 0 ? source.slice(ingredientStart) : source;
  const stopMatch = scoped.match(
    /\n\s*(?:Version|Other Details|How to Use|Directions|Disclaimer|FAQ|Frequently Asked Questions|Results|Free From)\b/i,
  );
  const ingredientBlock = stopMatch ? scoped.slice(0, stopMatch.index) : scoped;
  const delimitedOut = [];
  const lineOut = [];
  for (const line of ingredientBlock.split(/\n+/)) {
    const cleaned = line.replace(/^\s*(?:key\s+)?Ingredients?\s*/i, '').trim();
    if (!cleaned) continue;
    const delimitedItems = extractDelimitedIngredientNames(cleaned);
    for (const item of delimitedItems) {
      pushIngredientName(delimitedOut, item);
    }
    if (delimitedItems.length) continue;
    if (cleaned.includes(',')) continue;
    pushIngredientName(lineOut, cleaned);
  }
  return delimitedOut.length >= 3 ? delimitedOut : lineOut;
}

function extractIngredientNamesFromHtmlParagraphs(html) {
  const out = [];
  for (const match of asString(html).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    for (const item of extractDelimitedIngredientNames(match[1])) {
      pushIngredientName(out, item);
    }
  }
  return out;
}

function extractSourceIngredientsFromHtml(html, descriptionHtml = '') {
  const tableRows = [];
  const source = asString(html);
  for (const match of source.matchAll(/<tr\b[^>]*>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<td\b[^>]*>[\s\S]*?<\/td>\s*<\/tr>/gi)) {
    pushIngredientName(tableRows, match[1]);
  }
  if (tableRows.length >= 3) {
    return tableRows;
  }
  const paragraphRows = [];
  for (const item of extractIngredientNamesFromHtmlParagraphs(descriptionHtml)) {
    pushIngredientName(paragraphRows, item);
  }
  for (const item of extractIngredientNamesFromHtmlParagraphs(source)) {
    pushIngredientName(paragraphRows, item);
  }
  if (paragraphRows.length >= 3) {
    return paragraphRows;
  }
  const out = [...tableRows];
  for (const item of extractIngredientNamesFromText(descriptionHtml)) {
    pushIngredientName(out, item);
  }
  for (const item of extractIngredientNamesFromText(extractHtmlAttributeValue(source, 'data-description'))) {
    pushIngredientName(out, item);
  }
  return out;
}

function extractSourceHowToUseFromHtml(html) {
  const text = stripHtmlToText(html);
  if (!text) return '';
  const match = text.match(/\b(?:how to use|directions)\b\s+([\s\S]{20,600}?)(?:\n\s*(?:ingredients?|key ingredients?|other details|faq|frequently asked questions)\b|$)/i);
  const candidate = normalizeSourceFactText(match?.[1] || '');
  if (!candidate || !/\b(?:apply|use|massage|shake|layer|dispense|rinse|morning|night|daily)\b/i.test(candidate)) {
    return '';
  }
  return candidate.slice(0, 500);
}

function extractJsonLdProductDescriptions(html) {
  const out = [];
  for (const match of asString(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(decodeHtmlEntities(match[1]));
      const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (stack.length) {
        const item = stack.shift();
        if (!item || typeof item !== 'object') continue;
        if (Array.isArray(item)) {
          stack.push(...item);
          continue;
        }
        if (Array.isArray(item['@graph'])) stack.push(...item['@graph']);
        const type = item['@type'];
        const types = Array.isArray(type) ? type : [type];
        if (types.some((value) => asString(value).toLowerCase() === 'product')) {
          const description = cleanSourceDescription(item.description);
          if (description) out.push(description);
        }
      }
    } catch {
      // Ignore malformed inline JSON-LD blocks.
    }
  }
  return out;
}

function extractSourceProductFactsFromHtml(html) {
  const source = asString(html);
  if (!source) return {};
  const descriptionHtml =
    extractLikelyProductDescriptionHtml(source, 'descriptionHtml') ||
    extractJsonStringProperty(source, 'descriptionHtml');
  const productDescriptionHtml = extractLikelyProductDescriptionHtml(source, 'description');
  const descriptionCandidates = [
    extractParagraphTextFromHtml(descriptionHtml),
    cleanSourceDescription(extractHtmlAttributeValue(source, 'data-description')),
    ...extractJsonLdProductDescriptions(source),
    extractMetaDescription(source),
  ].filter(Boolean);
  const ingredients = extractSourceIngredientsFromHtml(
    source,
    [descriptionHtml, productDescriptionHtml].filter(Boolean).join('\n'),
  );
  const howToUse = extractSourceHowToUseFromHtml(source);
  return {
    ...(descriptionCandidates[0] ? { description: descriptionCandidates[0] } : {}),
    ...(ingredients.length ? { ingredients_inci: ingredients } : {}),
    ...(howToUse ? { how_to_use: howToUse } : {}),
  };
}

function extractSourceReviewSummaryFromHtml(html) {
  const source = asString(html).replace(/&quot;/g, '"');
  if (!source) return undefined;
  const candidates = [];
  const pushCandidate = (candidate) => {
    const normalized = normalizeReviewSummary(candidate);
    if (!normalized) return;
    const rating = Number(normalized.rating || 0);
    const reviewCount = Number(normalized.review_count || 0);
    if (rating <= 0 && reviewCount <= 0) return;
    candidates.push(normalized);
  };

  const okendoBlock = source.match(/okendoProduct\s*=\s*\{[\s\S]{0,2000}?\}/i)?.[0];
  pushCandidate(extractReviewSummaryFromTextBlock(okendoBlock));

  for (const match of source.matchAll(/MetafieldReviews\s*=\s*\{[\s\S]{0,1200}?\};/gi)) {
    pushCandidate(extractReviewSummaryFromTextBlock(match[0]));
  }

  for (const match of source.matchAll(/["']aggregateRating["']\s*:\s*\{[\s\S]{0,1600}?\}/gi)) {
    pushCandidate(extractReviewSummaryFromTextBlock(match[0]));
  }

  for (const match of source.matchAll(/["']reviewCount["']\s*:\s*["']?([\d,]+)["']?[\s\S]{0,320}?["']reviewAverageValue["']\s*:\s*["']?([\d.]+)/gi)) {
    pushCandidate({ review_count: parseReviewNumber(match[1]), rating: parseReviewNumber(match[2]) });
  }
  for (const match of source.matchAll(/["']reviewAverageValue["']\s*:\s*["']?([\d.]+)["']?[\s\S]{0,320}?["']reviewCount["']\s*:\s*["']?([\d,]+)/gi)) {
    pushCandidate({ rating: parseReviewNumber(match[1]), review_count: parseReviewNumber(match[2]) });
  }

  candidates.sort((left, right) => {
    const leftCount = Number(left.review_count || 0);
    const rightCount = Number(right.review_count || 0);
    if (leftCount !== rightCount) return rightCount - leftCount;
    return Number(right.rating || 0) - Number(left.rating || 0);
  });
  return candidates[0] || undefined;
}

function resolveCaseSourceUrl(row) {
  const product = row?.product && typeof row.product === 'object' ? row.product : {};
  return asString(
    product.source_url ||
      product.product_url ||
      product.canonical_url ||
      product.destination_url ||
      product.external_url ||
      product.url,
  );
}

async function fetchSourcePageEvidence(sourceUrl, { timeoutMs = 15000, httpClient = axios } = {}) {
  const url = asString(sourceUrl);
  if (!/^https?:\/\//i.test(url)) return {};
  const response = await httpClient.get(url, {
    timeout: Math.max(1000, Number(timeoutMs) || 15000),
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'Mozilla/5.0 PivotaInsightsReviewAudit/1.0',
    },
  });
  return {
    review_summary: extractSourceReviewSummaryFromHtml(response.data),
    facts: extractSourceProductFactsFromHtml(response.data),
  };
}

async function fetchSourceReviewSummary(sourceUrl, { timeoutMs = 15000, httpClient = axios } = {}) {
  const evidence = await fetchSourcePageEvidence(sourceUrl, { timeoutMs, httpClient });
  return evidence.review_summary;
}

async function fetchSourceProductFacts(sourceUrl, { timeoutMs = 15000, httpClient = axios } = {}) {
  const evidence = await fetchSourcePageEvidence(sourceUrl, { timeoutMs, httpClient });
  return evidence.facts;
}

function mergeSourceProductFactsIntoCase(row, facts, sourceUrl) {
  if (!row || typeof row !== 'object' || row.error) return row;
  const product = row.product && typeof row.product === 'object' ? row.product : {};
  const sourceFacts = facts && typeof facts === 'object' ? facts : {};
  const existingIngredients = normalizeIngredientListForPilot(product.ingredients_inci || product.ingredients);
  const sourceIngredients = normalizeIngredientListForPilot(sourceFacts.ingredients_inci || sourceFacts.ingredients);
  const nextProduct = { ...product };
  let changed = false;

  const sourceDescription = normalizeProductIntelDescription(sourceFacts.description);
  const existingDescription = normalizeProductIntelDescription(nextProduct.description);
  if (
    sourceDescription &&
    (!existingDescription ||
      (isNoisyProductIntelDescription(existingDescription) && sourceDescription.length < existingDescription.length))
  ) {
    nextProduct.description = sourceDescription;
    changed = true;
  }

  if (sourceIngredients.length >= 3 && sourceIngredients.length > existingIngredients.length) {
    nextProduct.ingredients_inci = sourceIngredients;
    changed = true;
  }

  const sourceHowToUse = asString(sourceFacts.how_to_use || sourceFacts.howToUse);
  if (!asString(nextProduct.how_to_use || nextProduct.howToUse) && sourceHowToUse) {
    nextProduct.how_to_use = sourceHowToUse;
    changed = true;
  }

  if (!changed) return row;
  return {
    ...row,
    product: {
      ...nextProduct,
      source_page_facts_url: sourceUrl,
    },
  };
}

function mergeSourceReviewSummaryIntoCase(row, sourceSummary, sourceUrl) {
  if (!row || typeof row !== 'object' || row.error) return row;
  const product = row.product && typeof row.product === 'object' ? row.product : {};
  const existingSummary = normalizeReviewSummary(product.review_summary);
  if (Number(existingSummary?.rating || 0) > 0 && Number(existingSummary?.review_count || 0) > 0) {
    return row;
  }
  if (!sourceSummary) return row;
  const communitySignals = buildReviewBackedCommunitySignals(
    sourceSummary,
    product.community_signals,
  );
  return {
    ...row,
    product: {
      ...product,
      review_summary: sourceSummary,
      ...(communitySignals ? { community_signals: communitySignals } : {}),
      review_source_url: sourceUrl,
    },
  };
}

async function enrichCaseWithSourcePageEvidence(row, {
  timeoutMs = 15000,
  includeReviews = false,
  includeFacts = false,
} = {}) {
  if (!row || typeof row !== 'object' || row.error) return row;
  if (!includeReviews && !includeFacts) return row;
  const sourceUrl = resolveCaseSourceUrl(row);
  if (!sourceUrl) return row;
  const evidence = await fetchSourcePageEvidence(sourceUrl, { timeoutMs });
  let next = row;
  if (includeFacts) {
    next = mergeSourceProductFactsIntoCase(next, evidence.facts, sourceUrl);
  }
  if (includeReviews) {
    next = mergeSourceReviewSummaryIntoCase(next, evidence.review_summary, sourceUrl);
  }
  return next;
}

async function enrichCaseWithSourceReviewSummary(row, { timeoutMs = 15000 } = {}) {
  return enrichCaseWithSourcePageEvidence(row, {
    timeoutMs,
    includeReviews: true,
    includeFacts: false,
  });
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

  const canonicalPayloadModules = asArray(extractCanonicalPayload(response)?.modules);
  const detailsModule =
    findModule(response?.modules, 'product_overview') ||
    findModule(canonicalPayloadModules, 'product_overview') ||
    findModule(response?.modules, 'supplemental_details') ||
    findModule(canonicalPayloadModules, 'supplemental_details');
  const ingredientsModule =
    findModule(response?.modules, 'ingredients_inci') ||
    findModule(canonicalPayloadModules, 'ingredients_inci');
  const howToUseModule =
    findModule(response?.modules, 'how_to_use') ||
    findModule(canonicalPayloadModules, 'how_to_use');
  const intelModule = findModule(response?.modules, 'product_intel');
  const productIntel = intelModule?.data || {};
  const reviewsPreviewSummary = extractReviewsPreviewSummary(response);
  const seedProduct = seedCase?.product && typeof seedCase.product === 'object' ? seedCase.product : {};

  const brand = normalizeBrandName(product.brand);
  const categoryPath = asArray(product.category_path).map((item) => asString(item)).filter(Boolean);
  const category = categoryPath.length ? categoryPath.join('/') : asString(product.category || product.product_type);
  const howToUse =
    extractStructuredModuleText(howToUseModule) ||
    extractDetailsText(detailsModule, /how to use|directions/i);
  const overview = extractDetailsText(detailsModule, /overview|details|description/i);
  const ingredients = asArray(
    ingredientsModule?.data?.items ||
      ingredientsModule?.data?.ingredients_inci ||
      ingredientsModule?.data?.ingredients ||
      product.ingredients_inci ||
      product.ingredients,
  );
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
  const sourceUrl =
    asString(product.source_url || product.product_url || product.canonical_url || product.url) ||
    asString(seedProduct.source_url || seedProduct.product_url || seedProduct.canonical_url || seedProduct.url);
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
      description:
        normalizeProductIntelDescription(product.description) ||
        normalizeProductIntelDescription(overview) ||
        normalizeProductIntelDescription(seedProduct.description),
      tags: mergeLists(seedProduct.tags, categoryPath),
      texture: asString(product.texture),
      finish: asString(product.finish),
      ingredients_inci: normalizeIngredientListForPilot(ingredients),
      how_to_use: howToUse,
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
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
  const sourceUrl = asString(
    product.source_url ||
      product.product_url ||
      product.canonical_url ||
      product.destination_url ||
      product.external_url ||
      product.url ||
      seedProduct.source_url ||
      seedProduct.product_url ||
      seedProduct.canonical_url ||
      seedProduct.url,
  );
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
      description:
        normalizeProductIntelDescription(product.description) ||
        normalizeProductIntelDescription(seedProduct.description),
      tags: mergeLists(seedProduct.tags, categoryPath, product.alias_tokens, product.ingredient_tokens),
      texture: asString(product.texture || seedProduct.texture),
      finish: asString(product.finish || seedProduct.finish),
      ingredients_inci: normalizeIngredientListForPilot(ingredients),
      how_to_use: asString(product.how_to_use || product.pdp_how_to_use_raw || product.usage || seedProduct.how_to_use),
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
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

async function loadExistingIdentityRefsForProductRefs(productRefs, queryFn = query) {
  const normalizedRefs = Array.from(new Set(toList(productRefs).map(asString).filter(Boolean)));
  if (!normalizedRefs.length || typeof queryFn !== 'function') return new Set();

  try {
    const response = await queryFn(
      `
        SELECT source_listing_ref
        FROM pdp_identity_listing
        WHERE source_listing_ref = ANY($1::text[])
      `,
      [normalizedRefs],
    );
    return new Set(
      toList(response?.rows).map((row) => asString(row?.source_listing_ref)).filter(Boolean),
    );
  } catch (err) {
    if (asString(err?.code) === '42P01' || asString(err?.code) === 'NO_DATABASE') {
      return new Set();
    }
    throw err;
  }
}

async function loadMissingIdentityCoverageProductIds({
  explicitBrands = [],
  topBrands = 0,
  perBrandLimit = 0,
  minSourceRows = 1,
  minReviewRatio = 0,
  beautyOnly = false,
  seed = '20260408',
  queryFn = query,
  summarizeFn = summarizePdpIdentityCoverageByBrand,
  fetchBackfillProductsFn = pdpIdentityFetchBackfillProducts,
} = {}) {
  if (typeof fetchBackfillProductsFn !== 'function') return [];
  const normalizedTopBrands = Math.max(0, Number(topBrands) || 0);
  const normalizedPerBrandLimit = Math.max(0, Number(perBrandLimit) || 0);
  const normalizedMinSourceRows = Math.max(0, Number(minSourceRows) || 0);
  const normalizedMinReviewRatio = Math.max(0, Math.min(1, Number(minReviewRatio) || 0));
  const brandSampleLimit = Math.min(
    2000,
    Math.max(200, normalizedPerBrandLimit * 100),
  );
  const summaryBrandLimit = Math.min(
    500,
    Math.max(120, normalizedTopBrands * 100),
  );
  if (normalizedTopBrands <= 0 && !toList(explicitBrands).length) return [];

  const targetBrands = new Set(
    toList(explicitBrands).map((item) => asString(item).toLowerCase()).filter(Boolean),
  );

  if (!targetBrands.size && normalizedTopBrands > 0 && typeof summarizeFn === 'function') {
    const coverageRows = await summarizeFn({
      limit: normalizedTopBrands,
      ...(summaryBrandLimit > normalizedTopBrands ? { limit: summaryBrandLimit } : {}),
      minSourceRows: normalizedMinSourceRows,
      beautyOnly,
      ...(typeof queryFn === 'function' ? { queryFn } : {}),
    });
    coverageRows
      .filter((row) => {
        const missingRows = toFiniteNumber(row?.missing_identity_rows) || 0;
        const reviewRatio = Number(row?.review_ratio || 0);
        return missingRows > 0 && reviewRatio >= normalizedMinReviewRatio;
      })
      .sort((left, right) => {
        const leftMissing = toFiniteNumber(left?.missing_identity_rows) || 0;
        const rightMissing = toFiniteNumber(right?.missing_identity_rows) || 0;
        if (leftMissing !== rightMissing) return rightMissing - leftMissing;
        return asString(left?.brand_norm).localeCompare(asString(right?.brand_norm));
      })
      .slice(0, normalizedTopBrands)
      .forEach((row) => {
        const brand = asString(row?.brand_norm).toLowerCase();
        if (brand) targetBrands.add(brand);
      });
  }

  if (!targetBrands.size || !normalizedPerBrandLimit) return [];

  const allCandidates = [];
  for (const brand of targetBrands) {
    const rows = await fetchBackfillProductsFn({
      brandFilter: brand,
      limit: brandSampleLimit,
      ...(typeof queryFn === 'function' ? { queryFn } : {}),
    });
    const sourceRefs = toList(rows)
      .map((row) =>
        asString(row?.merchant_id && row?.product_id ? `${row.merchant_id}:${row.product_id}` : ''),
      )
      .filter(Boolean);

    const existingRefs = await loadExistingIdentityRefsForProductRefs(sourceRefs, queryFn);
    const missing = toList(rows)
      .map((row) => ({
        sourceRef: asString(
          row?.merchant_id && row?.product_id ? `${row.merchant_id}:${row.product_id}` : '',
        ),
        productId: asString(row?.product_id),
      }))
      .filter((item) => item.productId && item.sourceRef && !existingRefs.has(item.sourceRef))
      .map((item) => item.productId);

    allCandidates.push(
      ...sampleWithoutReplacement(
        [...new Set(missing)],
        normalizedPerBrandLimit,
        `${seed}-identity-brand-${brand}`,
      ),
    );
  }

  return [...new Set(allCandidates)];
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

async function fetchPdpResponse(gatewayUrl, productId, productRef = null) {
  const normalizedRef = productRef && typeof productRef === 'object' && !Array.isArray(productRef)
    ? {
        ...(asString(productRef.merchant_id || productRef.merchantId)
          ? { merchant_id: asString(productRef.merchant_id || productRef.merchantId) }
          : {}),
        product_id: asString(productRef.product_id || productRef.productId || productId),
      }
    : { product_id: productId };
  const body = {
    operation: 'get_pdp_v2',
    payload: {
      product_ref: normalizedRef,
      include: ['canonical', 'product_overview', 'supplemental_details', 'ingredients_inci', 'product_intel', 'reviews_preview', 'offers'],
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
  const explicitProductRefs = normalizeProductRefInputs(args.productIds);
  const explicitProductRefById = productRefByProductId(args.productIds);
  let selectedIds = sampleWithoutReplacement(
    explicitProductRefs.map((ref) => ref.product_id),
    args.limit,
    args.seed,
  );
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

  const hasIdentitySignal = Boolean(
    args.supplementalProductIds.length ||
      args.identityBrands.length ||
      args.identityTopBrands > 0,
  );
  const supplementalProductRefs = normalizeProductRefInputs(args.supplementalProductIds);
  for (const ref of supplementalProductRefs) {
    if (ref?.product_id && ref?.merchant_id && !explicitProductRefById.has(ref.product_id)) {
      explicitProductRefById.set(ref.product_id, ref);
    }
  }
  let supplementalIds = supplementalProductRefs.map((ref) => ref.product_id);
  if (hasIdentitySignal) {
    const missingCoverageIds = await loadMissingIdentityCoverageProductIds({
      explicitBrands: args.identityBrands,
      topBrands: args.identityTopBrands,
      perBrandLimit: args.identityPerBrandLimit,
      minSourceRows: args.identityMinSourceRows,
      minReviewRatio: args.identityMinReviewRatio,
      beautyOnly: args.identityBeautyOnly === true,
      seed: args.seed,
      queryFn: query,
      summarizeFn: summarizePdpIdentityCoverageByBrand,
      fetchBackfillProductsFn: pdpIdentityFetchBackfillProducts,
    }).catch(() => []);
    supplementalIds = supplementalIds.concat(missingCoverageIds);
  }

  const selectionPoolLimit = Math.max(
    args.limit,
    Math.trunc(args.limit * args.candidatePoolMultiplier),
  );
  const mergedIds = Array.from(
    new Set([
      ...selectedIds,
      ...toList(supplementalIds).map((item) => asString(item)).filter(Boolean),
    ]),
  );

  if (mergedIds.length) {
    if (args.excludeCovered) {
      const poolCoveredIds = await loadCoveredProductIdSet(
        mergedIds,
        query,
        args.coveredReviewMode,
      ).catch(() => new Set());
      const allCovered = new Set([
        ...poolCoveredIds,
        ...reportCoveredProductIds,
        ...manualOverrideProductIds,
      ]);
      selectedIds = mergedIds.filter((id) => !allCovered.has(id));
      coveredProductIds = allCovered;
    } else {
      selectedIds = mergedIds;
    }
    selectedIds = sampleWithoutReplacement(selectedIds, selectionPoolLimit, args.seed);
  }

  if (!selectedIds.length) {
    throw new Error('missing_product_ids_or_queries');
  }

  const cases = [];
  for (const productId of selectedIds) {
    const seedCase = seedCases.find((row) => row?.canonical_product_ref?.product_id === productId) || null;
    const requestedProductRef = explicitProductRefById.get(productId) || null;
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchPdpResponse(args.gatewayUrl, productId, requestedProductRef);
      let row = buildPilotCaseFromPdpResponse(response, seedCase);
      if (!row) {
        // Fall back to external seed truth when invoke resolution is unavailable.
        // eslint-disable-next-line no-await-in-loop
        const externalSeedProduct = await fetchExternalSeedProduct(productId);
        row = buildPilotCaseFromExternalSeedProduct(externalSeedProduct, seedCase);
      }
      if (row) {
        if (args.fetchSourceReviews || args.fetchSourceFacts) {
          // eslint-disable-next-line no-await-in-loop
          row = await enrichCaseWithSourcePageEvidence(row, {
            timeoutMs: args.sourceReviewTimeoutMs,
            includeReviews: args.fetchSourceReviews,
            includeFacts: args.fetchSourceFacts,
          });
        }
        cases.push(row);
      } else {
        cases.push({
          ...(seedCase || {
            case_id: `live_${productId}`,
            canonical_product_ref: {
              merchant_id: asString(requestedProductRef?.merchant_id) || 'unknown',
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
          if (args.fetchSourceReviews || args.fetchSourceFacts) {
            // eslint-disable-next-line no-await-in-loop
            cases.push(
              await enrichCaseWithSourcePageEvidence(fallbackRow, {
                timeoutMs: args.sourceReviewTimeoutMs,
                includeReviews: args.fetchSourceReviews,
                includeFacts: args.fetchSourceFacts,
              }),
            );
          } else {
            cases.push(fallbackRow);
          }
          continue;
        }
      } catch {
        // Keep original fetch error below when the DB fallback also fails.
      }
      cases.push({
        ...(seedCase || {
          case_id: `live_${productId}`,
          canonical_product_ref: {
            merchant_id: asString(requestedProductRef?.merchant_id) || 'unknown',
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
      source_review_fetch: args.fetchSourceReviews,
      source_fact_fetch: args.fetchSourceFacts,
      out: outputPath,
      product_ids: finalCases.map((row) => row?.canonical_product_ref?.product_id).filter(Boolean),
      query_errors: queryErrors,
    })}\n`,
  );
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      if (process.exitCode && process.exitCode !== 0) {
        process.exit(process.exitCode);
      }
    });
}

module.exports = {
  buildPilotCaseFromPdpResponse,
  buildPilotCaseFromSearchCandidate,
  extractReviewsPreviewSummary,
  extractSourceProductFactsFromHtml,
  extractSourceReviewSummaryFromHtml,
  enrichCaseWithSourcePageEvidence,
  fetchSourceProductFacts,
  fetchSourceReviewSummary,
  fetchDiscoveryCandidates,
  fetchFrontendProductIds,
  fetchPdpResponse,
  fetchSearchCandidates,
  hasBadgeEvidence,
  loadCoveredProductIdSet,
  loadCoveredProductIdSetFromReport,
  loadManualOverrideProductIdSet,
  loadExistingIdentityRefsForProductRefs,
  loadMissingIdentityCoverageProductIds,
  parseArgs,
  parseProductRefInput,
  normalizeProductRefInputs,
  sampleWithoutReplacement,
  selectDiverseCases,
  extractProductIdsFromFrontendHtml,
  buildPilotCaseFromExternalSeedProduct,
  enrichCaseWithSourceReviewSummary,
  fetchExternalSeedProduct,
};
