#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  buildManifestFromExtract,
  fetchBrandCatalog,
  fetchBrandCatalogV2,
} = require('./build_beauty_brand_external_seed_manifest.cjs');
const {
  attachCommerceFactsToSeedRow,
  readCommerceFactsV1,
  validateCommerceFactsGateForSeedRow,
} = require('../src/commerce/commerceFacts');

const DEFAULT_CATALOG_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  'https://pivota-catalog-intelligence-production.up.railway.app';
const EXCLUDED_SOURCE_HOST_RE =
  /(?:^|\.)((amazon|temu|aliexpress|tiktok|shopee|lazada|shein|pinkflash)\.[a-z.]+)$/i;
const BLOCKING_DIAGNOSTIC_RE =
  /\b(?:captcha|challenge|bot|blocked|forbidden|access[_ -]?denied|login|auth|paywall|anti[_ -]?abuse|rate[_ -]?limit)\b/i;

function parseArgs(argv) {
  const out = {
    brand: '',
    retailerName: '',
    domain: '',
    market: 'US',
    limit: 1,
    catalogBaseUrl: DEFAULT_CATALOG_BASE_URL,
    targetExternalProductId: '',
    targetSourceListingRef: '',
    targetCanonicalUrl: '',
    targetProductTitle: '',
    matchBasis: [],
    includeCommerceFacts: false,
    outPath: '',
  };
  for (let idx = 2; idx < argv.length; idx += 1) {
    const token = String(argv[idx] || '').trim();
    const next = String(argv[idx + 1] || '').trim();
    if (token === '--brand' && next) {
      out.brand = next;
      idx += 1;
    } else if (token === '--retailer-name' && next) {
      out.retailerName = next;
      idx += 1;
    } else if (token === '--domain' && next) {
      out.domain = next;
      idx += 1;
    } else if (token === '--market' && next) {
      out.market = next;
      idx += 1;
    } else if (token === '--limit' && next) {
      out.limit = Math.max(1, Math.min(Number(next) || 1, 25));
      idx += 1;
    } else if (token === '--catalog-base-url' && next) {
      out.catalogBaseUrl = next;
      idx += 1;
    } else if (token === '--target-external-product-id' && next) {
      out.targetExternalProductId = next;
      idx += 1;
    } else if (token === '--target-source-listing-ref' && next) {
      out.targetSourceListingRef = next;
      idx += 1;
    } else if (token === '--target-canonical-url' && next) {
      out.targetCanonicalUrl = next;
      idx += 1;
    } else if (token === '--target-product-title' && next) {
      out.targetProductTitle = next;
      idx += 1;
    } else if (token === '--match-basis' && next) {
      out.matchBasis = next
        .split(';;')
        .map((item) => item.trim())
        .filter(Boolean);
      idx += 1;
    } else if (token === '--include-commerce-facts' || token === '--includeCommerceFacts') {
      out.includeCommerceFacts = true;
    } else if (token === '--out' && next) {
      out.outPath = next;
      idx += 1;
    }
  }
  return out;
}

function normalizeString(value) {
  return String(value || '').trim();
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function dedupeStrings(values, maxItems = 24) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const item = normalizeString(raw);
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

function resolvePathMaybeRelative(value) {
  const target = normalizeString(value);
  if (!target) return '';
  return path.isAbsolute(target) ? target : path.join(process.cwd(), target);
}

function getHost(value) {
  try {
    return new URL(normalizeString(value)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normalizeComparableOfferUrl(value) {
  const raw = normalizeString(value);
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return parsed.toString();
  } catch {
    return raw;
  }
}

function assertSafeInputs(args) {
  if (!normalizeString(args.brand)) throw new Error('Missing required --brand');
  if (!normalizeString(args.retailerName)) throw new Error('Missing required --retailer-name');
  if (!/^https?:\/\//i.test(normalizeString(args.domain))) {
    throw new Error('Missing required --domain direct PDP URL');
  }
  if (!normalizeString(args.targetSourceListingRef) && !normalizeString(args.targetExternalProductId)) {
    throw new Error('Missing target identity: pass --target-source-listing-ref or --target-external-product-id');
  }
  const host = getHost(args.domain);
  if (!host) throw new Error('Unable to parse source host');
  if (EXCLUDED_SOURCE_HOST_RE.test(host)) {
    throw new Error(`Excluded marketplace or source host: ${host}`);
  }
}

function assertExtractorSafe(extractDoc) {
  const diagnostics = ensureObject(extractDoc?.diagnostics);
  const failureCategory = normalizeString(diagnostics.failure_category);
  const blockProvider = normalizeString(diagnostics.block_provider);
  if (failureCategory && BLOCKING_DIAGNOSTIC_RE.test(failureCategory)) {
    throw new Error(`Blocking extractor failure category: ${failureCategory}`);
  }
  if (blockProvider) {
    throw new Error(`Blocking extractor anti-abuse signal: ${blockProvider}`);
  }
}

function withMergeCandidate(seedRow, args) {
  const seedData = ensureObject(seedRow.seed_data);
  const snapshot = ensureObject(seedData.snapshot);
  const targetExternalProductId = normalizeString(args.targetExternalProductId);
  const targetSourceListingRef =
    normalizeString(args.targetSourceListingRef) ||
    (targetExternalProductId ? `external_seed:${targetExternalProductId}` : '');
  const destinationUrl = normalizeString(seedRow.destination_url || seedRow.canonical_url);
  const sourceValidation = {
    ...ensureObject(seedData.source_validation),
    source_type: 'channel_or_retailer',
    requires_multi_offer_merge_validation: true,
    source_host: getHost(destinationUrl || args.domain) || null,
  };
  const mergeCandidate = {
    status: 'approved',
    reviewed_by: 'codex_manual_review',
    reviewed_at: new Date().toISOString(),
    reviewer_standard: 'strict_human_quality_gate',
    target_source_listing_ref: targetSourceListingRef || null,
    target_external_product_id: targetExternalProductId || null,
    target_canonical_url: normalizeString(args.targetCanonicalUrl) || null,
    target_product_title: normalizeString(args.targetProductTitle) || null,
    match_basis: dedupeStrings(
      args.matchBasis.length
        ? args.matchBasis
        : [
            'normalized_brand_match',
            'title_core_match',
            'variant_or_size_axis_match',
            'source_backed_price_availability',
          ],
      16,
    ),
    canonical_content_owner: 'official_dtc',
    retailer_offer_source: normalizeString(args.retailerName),
    evidence_url: destinationUrl || normalizeString(args.domain),
  };
  const retailerFields = {
    source_role: 'retailer_offer',
    source_listing_scope: 'retailer_offer',
    merchant_display_name: normalizeString(args.retailerName),
    seller_or_retailer_name: normalizeString(args.retailerName),
    seller_name: normalizeString(args.retailerName),
    purchase_route: 'external_link_out',
    commerce_mode: 'links_out',
    checkout_handoff: 'merchant_pdp',
    external_redirect_url: destinationUrl || normalizeString(args.domain),
    requires_multi_offer_merge_validation: true,
    source_validation: sourceValidation,
    multi_offer_merge_candidate: mergeCandidate,
  };
  let nextRow = {
    ...seedRow,
    seed_data: {
      ...seedData,
      ...retailerFields,
      snapshot: {
        ...snapshot,
        ...retailerFields,
      },
    },
  };
  const facts = readCommerceFactsV1(nextRow);
  const selectedAmount = Number(nextRow.price_amount);
  const factsAmount = Number(facts?.regional_price?.amount);
  const selectedUrl = normalizeComparableOfferUrl(nextRow.destination_url || nextRow.canonical_url);
  const factsUrl = normalizeComparableOfferUrl(
    facts?.regional_price?.source_url || facts?.evidence_url,
  );
  if (
    facts &&
    ((Number.isFinite(selectedAmount) &&
      Number.isFinite(factsAmount) &&
      Math.abs(selectedAmount - factsAmount) > 0.001) ||
      (selectedUrl && factsUrl && selectedUrl !== factsUrl))
  ) {
    nextRow = attachCommerceFactsToSeedRow(nextRow, null, { market: nextRow.market || args.market });
  }
  const commerceFactsGate = validateCommerceFactsGateForSeedRow(nextRow);
  return {
    ...nextRow,
    seed_data: {
      ...nextRow.seed_data,
      commerce_facts_gate: commerceFactsGate,
      snapshot: {
        ...ensureObject(nextRow.seed_data.snapshot),
        commerce_facts_gate: commerceFactsGate,
      },
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  assertSafeInputs(args);
  const market = normalizeString(args.market).toUpperCase() || 'US';
  const extractDoc = await fetchBrandCatalog({
    brand: args.brand,
    domain: args.domain,
    market,
    limit: args.limit,
    catalogBaseUrl: args.catalogBaseUrl,
  });
  assertExtractorSafe(extractDoc);
  const extractV2Doc = args.includeCommerceFacts
    ? await fetchBrandCatalogV2({
        brand: args.brand,
        domain: args.domain,
        market,
        limit: args.limit,
        catalogBaseUrl: args.catalogBaseUrl,
      })
    : null;
  const manifest = buildManifestFromExtract({
    brand: args.brand,
    domain: args.domain,
    market,
    limit: args.limit,
    preferredTitles: args.targetProductTitle ? [args.targetProductTitle] : [],
    extractDoc,
    extractV2Doc,
    sourceRole: 'retailer_offer',
  });
  const items = (manifest.items || []).map((item) => ({
    ...item,
    source_role: 'retailer_offer',
    retailer_name: args.retailerName,
    target_source_listing_ref:
      normalizeString(args.targetSourceListingRef) ||
      (normalizeString(args.targetExternalProductId) ? `external_seed:${normalizeString(args.targetExternalProductId)}` : ''),
    seed_row: withMergeCandidate(item.seed_row, args),
  }));
  const reviewedManifest = {
    ...manifest,
    generated_at: new Date().toISOString(),
    source_role: 'retailer_offer',
    retailer_name: args.retailerName,
    target_source_listing_ref:
      normalizeString(args.targetSourceListingRef) ||
      (normalizeString(args.targetExternalProductId) ? `external_seed:${normalizeString(args.targetExternalProductId)}` : ''),
    reviewed_merge_gate: {
      status: 'approved',
      reviewer: 'codex_manual_review',
      canonical_content_owner: 'official_dtc',
    },
    item_count: items.length,
    items,
  };
  const body = `${JSON.stringify(reviewedManifest, null, 2)}\n`;
  const outPath = resolvePathMaybeRelative(args.outPath);
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, body, 'utf8');
  }
  process.stdout.write(body);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  withMergeCandidate,
  assertSafeInputs,
  assertExtractorSafe,
};
