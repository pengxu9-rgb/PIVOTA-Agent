#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');

function parseArgs(argv) {
  const out = {
    gatewayUrl: process.env.PIVOTA_GATEWAY_URL || 'https://agent.pivota.cc/api/gateway',
    productIds: [],
    queries: [],
    limit: 10,
    perQuery: 12,
    seed: String(process.env.PRODUCT_INTEL_PILOT_SEED || '20260408'),
    out: '',
    requireBadgeEvidence: false,
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
  const source = value && typeof value === 'object' ? value : {};
  const rating = toFiniteNumber(
    source.rating ?? source.rating_value ?? source.average_rating ?? source.value,
  );
  const reviewCount = toFiniteNumber(
    source.review_count ?? source.reviewCount ?? source.count ?? source.total,
  );
  if (rating == null && reviewCount == null) return undefined;
  return {
    rating,
    review_count: reviewCount,
  };
}

function normalizeCommunitySignals(value) {
  const source = value && typeof value === 'object' ? value : {};
  const status = asString(source.status || source.state || source.availability);
  const sourceCounts =
    source.source_counts && typeof source.source_counts === 'object' ? source.source_counts : {};
  if (!status && !Object.keys(sourceCounts).length) return undefined;
  return {
    ...(status ? { status } : {}),
    ...(Object.keys(sourceCounts).length ? { source_counts: sourceCounts } : {}),
  };
}

function normalizeMarketSignalBadges(value) {
  return asArray(value)
    .map((item) => {
      const row = item && typeof item === 'object' ? item : null;
      const label = asString(row?.badge_label || row?.label || item);
      if (!label) return null;
      return {
        badge_type: asString(row?.badge_type || row?.type),
        badge_label: label,
      };
    })
    .filter(Boolean);
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
      review_summary:
        normalizeReviewSummary(seedProduct.review_summary) ||
        normalizeReviewSummary({
          rating: product.rating,
          review_count: product.review_count ?? product.reviewCount,
        }),
      ...(normalizeCommunitySignals(productIntel.community_signals) || seedProduct.community_signals
        ? {
            community_signals:
              normalizeCommunitySignals(productIntel.community_signals) || seedProduct.community_signals,
          }
        : {}),
      ...((normalizeMarketSignalBadges(productIntel.market_signal_badges) || seedProduct.market_signal_badges || [])
        .length
        ? {
            market_signal_badges:
              normalizeMarketSignalBadges(productIntel.market_signal_badges) || seedProduct.market_signal_badges,
          }
        : {}),
      ...(asString(productIntel.evidence_profile || seedProduct.evidence_profile)
        ? {
            evidence_profile: asString(productIntel.evidence_profile || seedProduct.evidence_profile),
          }
        : {}),
    },
  };
}

function hasBadgeEvidence(caseRow) {
  const product = caseRow?.product && typeof caseRow.product === 'object' ? caseRow.product : {};
  if (normalizeMarketSignalBadges(product.market_signal_badges).length > 0) return true;
  const review = normalizeReviewSummary(product.review_summary);
  if (Number(review?.rating || 0) >= 4.5 && Number(review?.review_count || 0) >= 100) return true;
  const community = normalizeCommunitySignals(product.community_signals);
  const sourceCounts = community?.source_counts || {};
  if (Number(sourceCounts.creator_mentions || 0) >= 8) return true;
  if (Number(sourceCounts.editorial || 0) >= 3) return true;
  if (Number(sourceCounts.media || 0) >= 3) return true;
  return false;
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
    headers: {
      'content-type': 'application/json',
    },
  });
  return asArray(response.data?.products);
}

async function fetchPdpResponse(gatewayUrl, productId) {
  const body = {
    operation: 'get_pdp_v2',
    payload: {
      product_ref: {
        product_id: productId,
      },
      include: ['canonical', 'product_details', 'ingredients_inci', 'product_intel', 'offers'],
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
    headers: {
      'content-type': 'application/json',
    },
  });
  return response.data;
}

async function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(__dirname, '..');
  let selectedIds = sampleWithoutReplacement(args.productIds, args.limit, args.seed);
  let seedCases = [];
  const queryErrors = [];

  if (!selectedIds.length && args.queries.length) {
    const candidates = [];
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
    const dedupedCases = candidates
      .map((row) => buildPilotCaseFromSearchCandidate(row))
      .filter(Boolean);
    const byProductId = new Map(dedupedCases.map((row) => [row.canonical_product_ref.product_id, row]));
    selectedIds = sampleWithoutReplacement(Array.from(byProductId.keys()), args.limit, args.seed);
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
      const row = buildPilotCaseFromPdpResponse(response, seedCase);
      if (row) cases.push(row);
    } catch (err) {
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

  const finalCases = args.requireBadgeEvidence ? cases.filter((row) => hasBadgeEvidence(row)) : cases;

  const outputPath = resolvePath(
    rootDir,
    args.out || `reports/product_intel_live_pilot_cases_${args.seed}.json`,
  );
  writeJson(outputPath, finalCases);

  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      requested: selectedIds.length,
      built: finalCases.filter((row) => !row.error).length,
      filtered_badge_cases: args.requireBadgeEvidence ? finalCases.length : undefined,
      out: outputPath,
      product_ids: selectedIds,
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
  hasBadgeEvidence,
  sampleWithoutReplacement,
};
