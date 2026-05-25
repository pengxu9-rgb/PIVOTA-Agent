#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const {
  stableExternalProductId,
  stableSeedId,
} = require(path.join(process.cwd(), 'scripts/build_aurora_external_seed_creation_manifest.cjs'));
const { validateCommerceFactsGateForSeedRow } = require(path.join(
  process.cwd(),
  'src/commerce/commerceFacts',
));

const REPORT_DIR = path.join(
  process.cwd(),
  'reports/markato_expansion_status_20260524/wave15_7journeys_direct_pdp_20260525',
);
const STORE_BASE_URL = 'https://7journeys.com';
const MARKET_PREFIX = '/en-inteuusuk';
const STORE_API_URL = `${STORE_BASE_URL}${MARKET_PREFIX}/products.json?limit=250`;
const GENERATED_AT = new Date().toISOString();
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';

const TARGET_OVERRIDES = {
  '7-journeys-extra-soft-glow-renewal-moisturizer-50g': {
    product_type: 'Moisturizer',
    category: 'Skincare',
    category_path: ['beauty', 'skincare', 'moisturizer'],
    catalog_category_path: 'beauty/skincare/moisturizer',
  },
  '7-journeys-miracle-timeless-eye-cream-30g': {
    product_type: 'Eye Cream',
    category: 'Skincare',
    category_path: ['beauty', 'skincare', 'eye-cream'],
    catalog_category_path: 'beauty/skincare/eye-cream',
  },
  '7-journeys-anatctic-timeless-serum-45ml': {
    product_type: 'Face Serum',
    category: 'Skincare',
    category_path: ['beauty', 'skincare', 'serum'],
    catalog_category_path: 'beauty/skincare/serum',
  },
  '7-journeys-glow-renewal-serum-45ml': {
    product_type: 'Face Serum',
    category: 'Skincare',
    category_path: ['beauty', 'skincare', 'serum'],
    catalog_category_path: 'beauty/skincare/serum',
  },
  '7journeys-miracle-glow-serum-mask-10-sheets': {
    product_type: 'Sheet Mask',
    category: 'Skincare',
    category_path: ['beauty', 'skincare', 'mask'],
    catalog_category_path: 'beauty/skincare/mask',
  },
};

function text(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&#39;|&apos;/gi, "'")
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&#8216;|&lsquo;/gi, "'")
    .replace(/&#8220;|&ldquo;/gi, '"')
    .replace(/&#8221;|&rdquo;/gi, '"')
    .replace(/&#8211;|&ndash;/gi, '-')
    .replace(/&#8212;|&mdash;/gi, '-')
    .replace(/&#36;/g, '$')
    .replace(/&[a-z0-9#]+;/gi, ' ');
}

function stripHtml(value) {
  return text(
    decodeHtml(
      String(value || '')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
        .replace(/<\/li>\s*<li[^>]*>/gi, '\n')
        .replace(/<\/?[^>]+>/g, ' '),
    ),
  );
}

function cleanDescription(value) {
  return stripHtml(value)
    .replace(/\s*Quantity\s+.*$/i, '')
    .replace(/\s*Add to cart\s+.*$/i, '')
    .trim();
}

function normalizeUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw.startsWith('//') ? `https:${raw}` : raw, STORE_BASE_URL);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return raw;
  }
}

function productImages(product) {
  const out = [];
  const seen = new Set();
  for (const image of asArray(product.images)) {
    const url = normalizeUrl(image.src || image);
    if (!/^https?:\/\//i.test(url)) continue;
    if (/placeholder|logo|icon|sprite|payment/i.test(url)) continue;
    const key = url.replace(/[?&](?:w|h|width|height)=[^&]+/gi, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out.slice(0, 12);
}

function splitIngredients(raw) {
  return text(raw)
    .replace(/(\d),(\d)(?=-[A-Za-z])/g, '$1__INCI_COMMA__$2')
    .replace(/\s*\*\s*$/g, '')
    .split(/\s*,\s*/)
    .map((item) =>
      item
        .replace(/__INCI_COMMA__/g, ',')
        .replace(/^[*+\s]+/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((item) => item.length >= 2)
    .filter((item) => !/^ingredients?$/i.test(item));
}

function ingredientPreview(ingredients, limit = 5) {
  return asArray(ingredients).slice(0, limit).join(', ');
}

function productTypeFromTitle(title) {
  const normalized = text(title).toLowerCase();
  if (/\beye cream\b/.test(normalized)) return TARGET_OVERRIDES['7-journeys-miracle-timeless-eye-cream-30g'];
  if (/\bmask\b/.test(normalized)) return TARGET_OVERRIDES['7journeys-miracle-glow-serum-mask-10-sheets'];
  if (/\bmoisturizer\b/.test(normalized)) return TARGET_OVERRIDES['7-journeys-extra-soft-glow-renewal-moisturizer-50g'];
  return TARGET_OVERRIDES['7-journeys-glow-renewal-serum-45ml'];
}

function publicDescriptionForProduct(product, target, ingredientsInci) {
  const productType = text(target.product_type).toLowerCase() || 'skincare product';
  const formulaPreview = ingredientPreview(ingredientsInci);
  const formulaSentence = formulaPreview
    ? ` The source ingredient list includes ${formulaPreview}.`
    : '';
  return (
    `7Journeys ${text(product.title)} is a source-backed ${productType} from the brand-owned US-localized product page.` +
    `${formulaSentence} Price, availability, images, use instructions, details, and formula fields were captured from the same source page.`
  );
}

function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        timeout: 30000,
        headers: {
          accept: 'text/html,application/json',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location &&
            redirectsLeft > 0
          ) {
            const nextUrl = new URL(response.headers.location, url).toString();
            fetchText(nextUrl, redirectsLeft - 1).then(resolve, reject);
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode} from ${url}: ${body.slice(0, 240)}`));
            return;
          }
          resolve(body);
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error(`timeout fetching ${url}`)));
    request.on('error', reject);
  });
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function parseJsonLdProduct(html, handle) {
  const scripts = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      scripts.push(JSON.parse(raw));
    } catch {
      // Ignore malformed analytics JSON-LD blocks; Shopify keeps a clean product block.
    }
  }
  return (
    scripts.find((entry) => text(entry?.['@type']).toLowerCase() === 'product' && text(entry?.url).includes(handle)) ||
    scripts.find((entry) => text(entry?.['@type']).toLowerCase() === 'product') ||
    null
  );
}

function accordionText(html, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<summary[^>]*>\\s*${escaped}\\s*[\\s\\S]*?<\\/summary>\\s*<div class=["']details-content["']>([\\s\\S]*?)<\\/details>`,
    'i',
  );
  const match = html.match(pattern);
  return match ? stripHtml(match[1]) : '';
}

function parsePrice(product, jsonLd) {
  const candidates = [
    asArray(product.variants)[0]?.price,
    product.price,
    jsonLd?.offers?.price,
  ];
  for (const candidate of candidates) {
    const amount = Number(String(candidate || '').replace(/[^0-9.]/g, ''));
    if (Number.isFinite(amount) && amount > 0 && amount < 250) return amount;
  }
  return null;
}

function availabilityFrom(product, jsonLd) {
  const offerAvailability = text(jsonLd?.offers?.availability).toLowerCase();
  if (offerAvailability.includes('instock')) return 'in_stock';
  if (asArray(product.variants).some((variant) => variant.available === true)) return 'in_stock';
  return 'out_of_stock';
}

function commerceFacts(row, displayRaw) {
  return {
    contract_version: 'commerce_facts.v1',
    market_id: 'US',
    country: 'US',
    currency_target: 'USD',
    source_authority: 'official_shopify_us_localized_pdp',
    captured_at: GENERATED_AT,
    evidence_url: row.canonical_url,
    sellable_region: {
      status: 'ok',
      countries: ['US'],
      evidence_source: 'shopify_localized_storefront_us_market',
      confidence: 'medium',
      checked_at: GENERATED_AT,
      reason_codes: ['localized_us_storefront_url', 'usd_price_observed', 'apple_pay_currency_usd'],
      evidence_url: row.canonical_url,
    },
    regional_price: {
      amount: row.price_amount,
      currency: row.price_currency,
      display_raw: displayRaw || `$${Number(row.price_amount).toFixed(2)}`,
      price_type: 'list',
      compare_at_amount: null,
      compare_at_currency: null,
      compare_at_display_raw: null,
      tax_included: 'unknown',
      confidence: 'high',
      market_switch_status: 'ok',
      observed_currency: row.price_currency,
      source_url: row.canonical_url,
      captured_at: GENERATED_AT,
    },
    availability: {
      status: row.availability,
      source: 'official_shopify_us_localized_pdp',
      confidence: row.availability === 'in_stock' ? 'high' : 'medium',
      captured_at: GENERATED_AT,
    },
    shipping: {
      status: 'unknown',
      source: 'official_shopify_us_localized_pdp',
      confidence: 'medium',
      reason_codes: ['checkout_not_queried'],
      checked_at: GENERATED_AT,
    },
    promotions: [],
    returns: {
      status: 'unknown',
      source: 'official_shopify_us_localized_pdp',
      confidence: 'unknown',
      reason_codes: ['external_returns_not_extracted'],
      checked_at: GENERATED_AT,
    },
  };
}

function snapshotContract(sourceUrl) {
  return {
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'wave15_7journeys_shopify_us_localized_recovery',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'replace_not_merge',
    source_url: sourceUrl,
    updated_at: GENERATED_AT,
  };
}

function qualitySummary(sourceUrl) {
  const base = {
    source_origin: 'official_shopify_us_localized_pdp',
    source_quality_status: 'high',
    source_url: sourceUrl,
    reviewed_by: 'codex_wave15_7journeys',
    reviewed_at: GENERATED_AT,
  };
  return {
    description_raw: base,
    ingredients_raw: base,
    ingredients_inci: base,
    how_to_use_raw: base,
    details_sections: base,
    category: base,
    product_type: base,
    image_assets: base,
  };
}

async function seedRowForProduct(product) {
  const handle = text(product.handle);
  const target = TARGET_OVERRIDES[handle] || productTypeFromTitle(product.title);
  const canonicalUrl = `${STORE_BASE_URL}${MARKET_PREFIX}/products/${handle}`;
  const html = await fetchText(canonicalUrl);
  const jsonLd = parseJsonLdProduct(html, handle);
  const title = text(jsonLd?.name || product.title);
  const officialDescriptionRaw = cleanDescription(jsonLd?.description || product.body_html);
  const ingredientsRaw = accordionText(html, 'Ingredients');
  const howToUse = accordionText(html, 'How to Use');
  const details = accordionText(html, 'Details');
  const ingredientsInci = splitIngredients(ingredientsRaw);
  const price = parsePrice(product, jsonLd);
  const currency = 'USD';
  const availability = availabilityFrom(product, jsonLd);
  const images = productImages(product);
  const externalProductId = stableExternalProductId(canonicalUrl);
  const seedId = stableSeedId(canonicalUrl);
  const description = publicDescriptionForProduct({ ...product, title }, target, ingredientsInci);
  const variant = asArray(product.variants)[0] || {};
  const displayRaw = price == null ? '' : `$${price.toFixed(2)}`;
  const sourceContract = snapshotContract(canonicalUrl);
  const quality = qualitySummary(canonicalUrl);
  const variantPayload = {
    sku: text(variant.sku) || `7J-${handle}`,
    variant_id: text(variant.id) || `7j-${handle}`,
    url: canonicalUrl,
    option_name: 'Size',
    option_value: text(variant.option1) && text(variant.option1) !== 'Default Title' ? text(variant.option1) : 'Default',
    price: price == null ? '' : price.toFixed(2),
    currency,
    stock: availability === 'in_stock' ? 'In Stock' : 'Out of Stock',
    description,
    image_url: images[0] || '',
    image_urls: images,
    images,
  };
  const ingredientIntel = {
    raw_ingredient_text_clean: ingredientsRaw,
    inci_raw: ingredientsRaw,
    inci_list: ingredientsInci,
    inci_normalized: ingredientsInci,
    source_kind: 'official_shopify_pdp_accordion',
    source_url: canonicalUrl,
  };
  const detailsSections = [
    howToUse
      ? {
          heading: 'How to Use',
          body: howToUse,
          source_kind: 'official_shopify_pdp_accordion',
        }
      : null,
    details
      ? {
          heading: 'Details',
          body: details,
          source_kind: 'official_shopify_pdp_accordion',
        }
      : null,
    ingredientsRaw
      ? {
          heading: 'Ingredients',
          body: ingredientsRaw,
          source_kind: 'official_shopify_pdp_accordion',
        }
      : null,
  ].filter(Boolean);

  const seedData = {
    brand: '7Journeys',
    title,
    description,
    external_product_id: externalProductId,
    canonical_url: canonicalUrl,
    destination_url: canonicalUrl,
    price_amount: price,
    price_currency: currency,
    availability,
    image_url: images[0] || undefined,
    image_urls: images,
    images,
    variants: [variantPayload],
    category: target.category,
    category_path: target.category_path,
    catalog_category_path: target.catalog_category_path,
    product_kind: 'single_formula',
    product_type: target.product_type,
    pdp_description_raw: description,
    pdp_official_description_raw: officialDescriptionRaw,
    pdp_source_description_raw: officialDescriptionRaw,
    pdp_ingredients_raw: ingredientsRaw,
    raw_ingredient_text_clean: ingredientsRaw,
    ingredients_inci: ingredientsInci,
    inci_list: ingredientsInci,
    pdp_how_to_use_raw: howToUse,
    pdp_details_sections: detailsSections,
    ingredient_intel: ingredientIntel,
    external_seed_snapshot_contract: sourceContract,
    pdp_field_quality_summary: quality,
    pdp_field_capture_status: {
      description_raw: officialDescriptionRaw ? 'captured' : 'missing',
      ingredients_raw: ingredientsRaw ? 'captured' : 'missing',
      how_to_use_raw: howToUse ? 'captured' : 'missing',
      details_sections: detailsSections.length ? 'captured' : 'missing',
    },
    authority_source: {
      source_url: canonicalUrl,
      source_role: 'direct_official_pdp',
      source_api_url: STORE_API_URL,
      official_description_raw: officialDescriptionRaw,
      matched_preferred_titles: [title],
    },
    source_validation: {
      source_type: 'brand_owned',
      source_host: '7journeys.com',
      requires_multi_offer_merge_validation: false,
    },
    search_aliases: [title, `7Journeys ${title}`, `7 Journeys ${title}`],
  };

  seedData.snapshot = {
    source: 'official_shopify_us_localized_seed_creation_manifest',
    extracted_at: GENERATED_AT,
    canonical_url: canonicalUrl,
    destination_url: canonicalUrl,
    title,
    description,
    image_url: images[0] || '',
    image_urls: images,
    images,
    variants: [variantPayload],
    ...Object.fromEntries(
      [
        'brand',
        'external_product_id',
        'price_amount',
        'price_currency',
        'availability',
        'category',
        'category_path',
        'catalog_category_path',
        'product_kind',
        'product_type',
        'pdp_description_raw',
        'pdp_official_description_raw',
        'pdp_source_description_raw',
        'pdp_ingredients_raw',
        'raw_ingredient_text_clean',
        'ingredients_inci',
        'inci_list',
        'pdp_how_to_use_raw',
        'pdp_details_sections',
        'ingredient_intel',
        'external_seed_snapshot_contract',
        'pdp_field_quality_summary',
        'pdp_field_capture_status',
        'authority_source',
        'source_validation',
        'search_aliases',
      ].map((key) => [key, seedData[key]]),
    ),
    shopify_product_id: product.id,
    shopify_handle: handle,
  };

  const row = {
    ingredient_id: null,
    ingredient_name: null,
    seed_id: seedId,
    brand: '7Journeys',
    market: 'US',
    tool: 'creator_agents',
    status: 'active',
    domain: '7journeys.com',
    external_product_id: externalProductId,
    canonical_url: canonicalUrl,
    destination_url: canonicalUrl,
    title,
    image_url: images[0] || null,
    price_amount: price,
    price_currency: currency,
    availability,
    attached_product_key: null,
    requires_seed_correction: false,
    seed_data: seedData,
  };

  const facts = commerceFacts(row, displayRaw);
  row.seed_data.commerce_facts_v1 = facts;
  row.seed_data.snapshot.commerce_facts_v1 = facts;
  const gate = validateCommerceFactsGateForSeedRow(row);
  row.seed_data.commerce_facts_gate = gate;
  row.seed_data.snapshot.commerce_facts_gate = gate;

  return {
    row,
    audit: {
      handle,
      target_url: canonicalUrl,
      title: row.title,
      price,
      currency,
      availability,
      image_count: images.length,
      description_length: description.length,
      official_description_length: officialDescriptionRaw.length,
      ingredients_count: ingredientsInci.length,
      ingredients_raw_length: ingredientsRaw.length,
      how_to_use_length: howToUse.length,
      details_length: details.length,
      commerce_gate: gate,
      category_path: target.catalog_category_path,
    },
  };
}

function auditCandidate(candidate) {
  const reasons = [];
  const warnings = [];
  const { audit, row } = candidate;
  if (!row.title) reasons.push('missing_title');
  if (!/^https:\/\/7journeys\.com\/en-inteuusuk\/products\//i.test(row.canonical_url)) {
    reasons.push('canonical_url_not_us_localized_official_pdp');
  }
  if (row.price_currency !== 'USD') reasons.push('price_not_usd');
  if (!(Number(row.price_amount) > 0 && Number(row.price_amount) < 250)) reasons.push('price_sanity_failed');
  if (row.availability !== 'in_stock') reasons.push('not_in_stock');
  if (audit.image_count < 1) reasons.push('missing_image');
  if (audit.official_description_length < 300) reasons.push('missing_source_backed_description');
  if (audit.ingredients_raw_length < 40 || audit.ingredients_count < 5) reasons.push('missing_source_backed_ingredients');
  if (audit.how_to_use_length < 20) reasons.push('missing_source_backed_how_to_use');
  if (audit.commerce_gate.status === 'hold') reasons.push(`commerce_gate_hold:${audit.commerce_gate.problems.join('|')}`);
  if (/\b(?:anti[-\s]?aging|firming|glow|brighten|wrinkles?|peptides?)\b/i.test(row.title)) {
    warnings.push('official_title_contains_cosmetic_claim_language_reviewed_as_cosmetic_not_therapeutic');
  }
  return {
    ...audit,
    status: reasons.length ? 'hold' : 'ready',
    reasons,
    warnings,
  };
}

async function main() {
  const doc = await fetchJson(STORE_API_URL);
  const products = asArray(doc.products).filter((product) => text(product.vendor).toLowerCase() === '7 journeys');
  const items = [];
  const heldItems = [];
  const auditRows = [];

  for (const product of products) {
    const candidate = await seedRowForProduct(product);
    const audit = auditCandidate(candidate);
    auditRows.push(audit);
    if (audit.status !== 'ready') {
      heldItems.push(audit);
      continue;
    }
    items.push({
      ingredient_id: null,
      ingredient_name: null,
      target_brand: '7Journeys',
      target_url: candidate.row.canonical_url,
      extract_status: 'official_shopify_us_localized_recovered_ready',
      market: 'US',
      source_domain: 'https://7journeys.com',
      source_role: 'direct_official_pdp_shopify_us_localized',
      matched_preferred_titles: [candidate.row.title],
      seed_row: candidate.row,
    });
  }

  const manifest = {
    generated_at: GENERATED_AT,
    market: 'US',
    source: 'wave15_7journeys_official_shopify_us_localized_recovery',
    source_api_url: STORE_API_URL,
    curation_policy:
      '7Journeys US-localized official PDPs only: localized Shopify products.json plus direct PDP HTML, USD price, in-stock, product images, source-backed official description, ingredients, details, and use instructions.',
    item_count: items.length,
    held_item_count: heldItems.length,
    held_items: heldItems,
    items,
  };
  const audit = {
    generated_at: GENERATED_AT,
    market: 'US',
    source: manifest.source,
    scanned: auditRows.length,
    ready_count: items.length,
    held_count: heldItems.length,
    audit_rows: auditRows,
    held_items: heldItems,
  };

  const manifestPath = path.join(REPORT_DIR, 'candidate_manifest.json');
  const dbReadyPath = path.join(REPORT_DIR, 'db_ready_candidate_manifest.json');
  const auditPath = path.join(REPORT_DIR, 'official_shopify_extract_audit.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(dbReadyPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);

  process.stdout.write(
    `${JSON.stringify(
      {
        candidate_manifest: manifestPath,
        db_ready_candidate_manifest: dbReadyPath,
        extract_audit: auditPath,
        scanned: audit.scanned,
        ready_count: audit.ready_count,
        held_count: audit.held_count,
        ready_titles: items.map((item) => item.seed_row.title),
        held_reasons: heldItems.map((item) => ({ handle: item.handle, title: item.title, reasons: item.reasons })),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
