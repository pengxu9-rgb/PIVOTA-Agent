#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  stableExternalProductId,
  stableSeedId,
} = require(path.join(process.cwd(), 'scripts/build_aurora_external_seed_creation_manifest.cjs'));
const {
  buildCommerceFactsFromSeedRow,
  validateCommerceFactsGateForSeedRow,
} = require(path.join(process.cwd(), 'src/commerce/commerceFacts'));

const REPORT_DIR = path.join(
  process.cwd(),
  'reports/markato_expansion_status_20260524/wave18_direct_source_probe_20260525',
);
const SOURCE_DIR = path.join(REPORT_DIR, 'source_html');
const GENERATED_AT = new Date().toISOString();
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';
const STORE_BASE_URL = 'https://www.abyssianhaircare.com';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
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
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function stripHtml(value) {
  return decodeHtml(
    String(value || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(li|p|h[1-6]|div|button|span)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstMatch(value, regex) {
  const match = String(value || '').match(regex);
  return match ? decodeHtml(match[1]).trim() : '';
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

function readTextIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function readProductJsonFromHtml(html) {
  const bundleProduct = String(html || '').match(/_ABConfig\.product\s*=\s*(\{[\s\S]*?\});/);
  if (bundleProduct) {
    try {
      return JSON.parse(bundleProduct[1]);
    } catch {
      // Fall through to the escaped productData form.
    }
  }
  const escapedProduct = String(html || '').match(/productData:\s*"([\s\S]*?)"\s*,/);
  if (escapedProduct) {
    try {
      return JSON.parse(JSON.parse(`"${escapedProduct[1]}"`));
    } catch {
      return null;
    }
  }
  return null;
}

function extractAccordionSection(html, label) {
  const titleRegex = new RegExp(`<button[^>]*>\\s*${label}\\s*<`, 'i');
  const match = titleRegex.exec(html);
  if (!match) return '';
  const after = html.slice(match.index);
  const nextBlock = after.slice(1).search(/<div class=["']ib-border\b|<script\b/i);
  const block = nextBlock >= 0 ? after.slice(0, nextBlock + 1) : after;
  return stripHtml(block)
    .replace(new RegExp(`^${label}\\s*`, 'i'), '')
    .replace(/^\+\s*/, '')
    .trim();
}

function extractIngredientsText(html) {
  const match = String(html || '').match(
    /Full ingredients list[\s\S]{0,3000}?<span[^>]*id=["']ingredients["'][\s\S]*?>([\s\S]*?)<\/span>/i,
  );
  const raw = match ? stripHtml(match[1]) : extractAccordionSection(html, 'Ingredients');
  return raw
    .replace(/\*\s*NATURALLY[\s\S]*$/i, '')
    .replace(/\*\*\s*PLANT[\s\S]*$/i, '')
    .replace(/\* Naturally Occurring[\s\S]*$/i, '')
    .replace(/\bNATURALLY OCCURRING[\s\S]*$/i, '')
    .trim();
}

function ingredientNames(raw) {
  return String(raw || '')
    .split(/\s*,\s*/)
    .map((item) => text(item).replace(/\s+/g, ' '))
    .filter((item) => item.length >= 2)
    .filter((item) => !/^(ingredients|full ingredients list)$/i.test(item));
}

function productTypeForTitle(title) {
  const normalized = text(title).toLowerCase();
  if (normalized.includes('conditioner')) {
    return {
      product_type: 'Conditioner',
      category: 'Hair Care',
      category_path: ['beauty', 'haircare', 'conditioner'],
      catalog_category_path: 'beauty/haircare/conditioner',
    };
  }
  if (normalized.includes('dry shampoo')) {
    return {
      product_type: 'Dry Shampoo',
      category: 'Hair Care',
      category_path: ['beauty', 'haircare', 'dry-shampoo'],
      catalog_category_path: 'beauty/haircare/dry-shampoo',
    };
  }
  if (normalized.includes('shampoo')) {
    return {
      product_type: 'Shampoo',
      category: 'Hair Care',
      category_path: ['beauty', 'haircare', 'shampoo'],
      catalog_category_path: 'beauty/haircare/shampoo',
    };
  }
  if (normalized.includes('mask')) {
    return {
      product_type: 'Hair Mask',
      category: 'Hair Care',
      category_path: ['beauty', 'haircare', 'hair-mask'],
      catalog_category_path: 'beauty/haircare/hair-mask',
    };
  }
  if (normalized.includes('mist')) {
    return {
      product_type: 'Hair Mist',
      category: 'Hair Care',
      category_path: ['beauty', 'haircare', 'hair-mist'],
      catalog_category_path: 'beauty/haircare/hair-mist',
    };
  }
  if (normalized.includes('serum')) {
    return {
      product_type: 'Hair Serum',
      category: 'Hair Care',
      category_path: ['beauty', 'haircare', 'hair-serum'],
      catalog_category_path: 'beauty/haircare/hair-serum',
    };
  }
  if (normalized.includes('emulsion')) {
    return {
      product_type: 'Hair Treatment',
      category: 'Hair Care',
      category_path: ['beauty', 'haircare', 'treatment'],
      catalog_category_path: 'beauty/haircare/treatment',
    };
  }
  return {
    product_type: 'Hair Care',
    category: 'Hair Care',
    category_path: ['beauty', 'haircare'],
    catalog_category_path: 'beauty/haircare',
  };
}

function isLikelyProductImageUrl(value) {
  const url = normalizeUrl(value);
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.endsWith('.svg')) return false;
  if (/logo|icon|sprite|payment|placeholder|fragrance|review|before_and_after|claims|science|fact/.test(lower)) {
    return false;
  }
  return true;
}

function productImages(product) {
  const seen = new Set();
  const out = [];
  const add = (raw) => {
    const url = normalizeUrl(raw);
    if (!/^https?:\/\//i.test(url) || !isLikelyProductImageUrl(url)) return;
    const key = url.replace(/[?&](?:w|h|width|height|crop)=[^&]+/gi, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(url);
  };

  add(product?.featured_image);
  for (const variant of asArray(product?.variants)) {
    add(variant?.featured_image?.src);
    add(variant?.featured_media?.preview_image?.src);
  }
  for (const image of asArray(product?.images)) {
    add(image);
  }
  return out.slice(0, 8);
}

function normalizeVariant(product, variant, canonicalUrl, description, fallbackImage) {
  const price = Number(variant?.price ?? product?.price) / 100;
  const imageUrl =
    normalizeUrl(variant?.featured_image?.src || variant?.featured_media?.preview_image?.src) || fallbackImage || '';
  return {
    sku: text(variant?.sku || `SHOPIFY-${variant?.id || product?.id}`),
    variant_id: text(variant?.id || product?.id),
    url: canonicalUrl,
    option_name: text(asArray(product?.options)[0] || 'Title') || 'Title',
    option_value: text(variant?.title || variant?.public_title || 'Default Title'),
    price: Number.isFinite(price) ? String(price) : '',
    currency: 'USD',
    stock: variant?.available === false || product?.available === false ? 'Out of Stock' : 'In Stock',
    description,
    image_url: isLikelyProductImageUrl(imageUrl) ? imageUrl : fallbackImage || '',
    image_urls: [isLikelyProductImageUrl(imageUrl) ? imageUrl : fallbackImage || ''].filter(Boolean),
    images: [isLikelyProductImageUrl(imageUrl) ? imageUrl : fallbackImage || ''].filter(Boolean),
  };
}

function sourceContract(sourceUrl) {
  return {
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'wave18_abyssian_official_shopify_us_catalog_expansion',
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
    source_origin: 'official_shopify_us_pdp_html_embedded_product_json',
    source_quality_status: 'high',
    source_url: sourceUrl,
    reviewed_by: 'codex_wave18_abyssian',
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

function publicDescription(product, typeInfo, ingredients) {
  const preview = asArray(ingredients).slice(0, 5).join(', ');
  const ingredientSentence = preview ? ` Key listed ingredients include ${preview}.` : '';
  return (
    `${product.title} is an Abyssian ${typeInfo.product_type.toLowerCase()} for hair care routines, with a complete ingredient list and clear use directions.` +
    ingredientSentence
  );
}

function commerceFacts(row, displayRaw) {
  return buildCommerceFactsFromSeedRow(row, {
    sourceAuthority: 'official_shopify_us_pdp_html_embedded_product_json',
    capturedAt: GENERATED_AT,
    rawFacts: {
      regional_price: {
        display_raw: displayRaw,
        price_type: 'list',
        confidence: 'medium',
        market_switch_status: 'ok',
      },
    },
  });
}

function sourceWarningCodes(sourceText) {
  const warnings = [];
  if (/\b(?:repair|clinically|anti-inflammatory|anti-pollution)\b/i.test(sourceText)) {
    warnings.push('source_claim_terms_sanitized_from_public_description');
  }
  return warnings;
}

function buildCandidate(fileName) {
  const htmlPath = path.join(SOURCE_DIR, fileName);
  const html = readTextIfExists(htmlPath);
  const product = readProductJsonFromHtml(html);
  const canonicalUrl = normalizeUrl(
    firstMatch(html, /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i),
  );
  const title = text(product?.title || firstMatch(html, /property=["']og:title["']\s+content=["']([^"']+)["']/i));
  const typeInfo = productTypeForTitle(title);
  const shopifyCountry = firstMatch(html, /Shopify\.country\s*=\s*["']([^"']+)["']/i);
  const priceCurrency =
    firstMatch(html, /property=["']og:price:currency["']\s+content=["']([^"']+)["']/i) ||
    firstMatch(html, /Shopify\.currency\s*=\s*\{[^}]*["']active["']\s*:\s*["']([^"']+)["']/i);
  const displayRaw = firstMatch(html, /property=["']og:price:amount["']\s+content=["']([^"']+)["']/i);
  const benefitsRaw = extractAccordionSection(html, 'Benefits & Ingredients');
  const ingredientsRaw = extractIngredientsText(html);
  const ingredientList = ingredientNames(ingredientsRaw);
  const howToRaw = extractAccordionSection(html, 'How to Use');
  const sourceTextForClaims = [title, stripHtml(product?.description || ''), benefitsRaw, howToRaw].join(' ');
  const sourceTextForWarnings = [sourceTextForClaims, ingredientsRaw].join(' ');
  const price = Number(product?.price) / 100;
  const images = productImages(product || {});

  const auditBase = {
    file: fileName,
    target_url: canonicalUrl,
    html_path: path.relative(process.cwd(), htmlPath),
    title,
    price_currency: priceCurrency,
    shopify_country: shopifyCountry,
    has_product_json: Boolean(product),
    available: product?.available ?? null,
    variant_count: asArray(product?.variants).length,
    image_count: images.length,
    price: Number.isFinite(price) ? price : null,
    ingredients_raw_length: ingredientsRaw.length,
    ingredients_count: ingredientList.length,
    how_to_use_length: text(howToRaw).length,
    category_path: typeInfo.catalog_category_path,
  };

  const reasons = [];
  if (!canonicalUrl.startsWith(`${STORE_BASE_URL}/products/`)) reasons.push('not_official_product_pdp');
  if (!product) reasons.push('missing_embedded_product_json');
  if (shopifyCountry !== 'US') reasons.push('shopify_country_not_us');
  if (priceCurrency !== 'USD') reasons.push('price_not_usd');
  if (!(price > 0 && price < 150)) reasons.push('price_sanity_failed');
  if (product?.available !== true) reasons.push('not_available_or_missing_product_json');
  if (!images.length) reasons.push('missing_product_images');
  if (ingredientList.length < 8 || ingredientsRaw.length < 80) reasons.push('missing_full_ingredient_text');
  if (text(howToRaw).length < 40) reasons.push('missing_official_how_to');
  if (/\b(?:hair loss|hair growth|dandruff|eczema|acne|psoriasis|healing|antibacterial)\b/i.test(sourceTextForClaims)) {
    reasons.push('regulatory_claim_terms_require_manual_review');
  }
  if (/conditioner/i.test(typeInfo.product_type) && /\b(?:lather|shampoo)\b/i.test(howToRaw)) {
    reasons.push('how_to_conflicts_with_product_type');
  }
  const warnings = sourceWarningCodes(sourceTextForWarnings);

  if (reasons.length) {
    return {
      audit: {
        ...auditBase,
        status: 'hold',
        reasons,
        warnings,
      },
      item: null,
    };
  }

  const externalProductId = stableExternalProductId(canonicalUrl);
  const seedId = stableSeedId(canonicalUrl);
  const description = publicDescription(product, typeInfo, ingredientList);
  const howToUse = text(howToRaw);
  const variants = asArray(product.variants)
    .filter((variant) => variant?.available !== false)
    .map((variant) => normalizeVariant(product, variant, canonicalUrl, description, images[0]))
    .filter((variant) => variant.sku || variant.variant_id);
  const primaryVariant = variants[0] || normalizeVariant(product, asArray(product.variants)[0] || {}, canonicalUrl, description, images[0]);
  const detailsSections = [
    {
      heading: 'How to Use',
      body: howToUse,
      source_kind: 'official_shopify_pdp_how_to_accordion',
    },
    {
      heading: 'Ingredients',
      body: ingredientList.join(', '),
      source_kind: 'official_shopify_pdp_ingredient_accordion',
    },
  ];
  const seedData = {
    brand: 'Abyssian',
    title: product.title,
    description,
    external_product_id: externalProductId,
    canonical_url: canonicalUrl,
    destination_url: canonicalUrl,
    price_amount: price,
    price_currency: 'USD',
    availability: 'in_stock',
    image_url: images[0],
    image_urls: images,
    images,
    variants: variants.length ? variants : [primaryVariant],
    category: typeInfo.category,
    category_path: typeInfo.category_path,
    catalog_category_path: typeInfo.catalog_category_path,
    product_kind: 'single_formula',
    product_type: typeInfo.product_type,
    pdp_description_raw: description,
    pdp_official_description_raw: description,
    pdp_source_description_raw: `${description} How to Use: ${howToUse} Ingredients: ${ingredientList.join(', ')}`,
    pdp_ingredients_raw: ingredientList.join(', '),
    raw_ingredient_text_clean: ingredientList.join(', '),
    ingredients_inci: ingredientList,
    inci_list: ingredientList,
    pdp_how_to_use_raw: howToUse,
    pdp_details_sections: detailsSections,
    ingredient_intel: {
      raw_ingredient_text_clean: ingredientList.join(', '),
      inci_raw: ingredientList.join(', '),
      inci_list: ingredientList,
      inci_normalized: ingredientList,
      source_kind: 'official_shopify_pdp_ingredient_accordion',
      source_url: canonicalUrl,
    },
    external_seed_snapshot_contract: sourceContract(canonicalUrl),
    pdp_field_quality_summary: qualitySummary(canonicalUrl),
    pdp_field_capture_status: {
      description_raw: 'captured',
      ingredients_raw: 'captured',
      how_to_use_raw: 'captured',
      details_sections: 'captured',
    },
    authority_source: {
      source_url: canonicalUrl,
      source_role: 'direct_official_pdp_html_embedded_product_json',
      official_description_raw: stripHtml(product.description || ''),
      official_benefits_source_raw: benefitsRaw,
      official_ingredients_source_raw: ingredientsRaw,
      matched_preferred_titles: [product.title],
    },
    source_validation: {
      source_type: 'brand_owned',
      source_host: 'abyssianhaircare.com',
      requires_multi_offer_merge_validation: false,
    },
    search_aliases: [product.title, `Abyssian ${product.title}`, `Abyssian ${typeInfo.product_type}`],
  };
  seedData.snapshot = {
    source: 'wave18_abyssian_official_shopify_us_seed_creation_manifest',
    extracted_at: GENERATED_AT,
    canonical_url: canonicalUrl,
    destination_url: canonicalUrl,
    title: product.title,
    description,
    image_url: images[0],
    image_urls: images,
    images,
    variants: variants.length ? variants : [primaryVariant],
    shopify_product_id: product.id,
    shopify_handle: product.handle,
    shopify_country: shopifyCountry,
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
  };

  const row = {
    ingredient_id: null,
    ingredient_name: null,
    seed_id: seedId,
    brand: 'Abyssian',
    market: 'US',
    tool: 'creator_agents',
    status: 'active',
    domain: 'abyssianhaircare.com',
    external_product_id: externalProductId,
    canonical_url: canonicalUrl,
    destination_url: canonicalUrl,
    title: product.title,
    image_url: images[0],
    price_amount: price,
    price_currency: 'USD',
    availability: 'in_stock',
    attached_product_key: null,
    requires_seed_correction: false,
    seed_data: seedData,
  };

  const facts = commerceFacts(row, displayRaw || price.toFixed(2));
  row.seed_data.commerce_facts_v1 = facts;
  row.seed_data.snapshot.commerce_facts_v1 = facts;
  const gate = validateCommerceFactsGateForSeedRow(row);
  row.seed_data.commerce_facts_gate = gate;
  row.seed_data.snapshot.commerce_facts_gate = gate;

  const item = {
    ingredient_id: null,
    ingredient_name: null,
    target_brand: 'Abyssian',
    target_url: canonicalUrl,
    extract_status: 'official_shopify_us_pdp_ready',
    market: 'US',
    source_domain: STORE_BASE_URL,
    source_role: 'direct_official_pdp_html_embedded_product_json',
    matched_preferred_titles: [product.title],
    seed_row: row,
    curation_decision: {
      decision: 'db_ready_candidate',
      reason_codes: ['official_usd_in_stock_pdp', 'source_backed_ingredients_and_how_to'],
    },
  };

  return {
    item,
    audit: {
      ...auditBase,
      title: row.title,
      seed_id: seedId,
      external_product_id: externalProductId,
      public_description_length: description.length,
      commerce_gate: gate,
      status: gate.status === 'pass' ? 'ready' : 'hold',
      reasons: gate.status === 'pass' ? [] : [`commerce_gate_hold:${asArray(gate.problems).join('|')}`],
      warnings,
    },
  };
}

function main() {
  const files = fs
    .readdirSync(SOURCE_DIR)
    .filter((file) => /^abyssian_.*\.html$/i.test(file))
    .sort();
  const built = files.map(buildCandidate);
  const auditRows = built.map((entry) => entry.audit);
  const finalItems = built
    .filter((entry) => entry.item && entry.audit.status === 'ready')
    .map((entry) => entry.item);
  const heldItems = auditRows.filter((row) => row.status !== 'ready');
  const manifest = {
    generated_at: GENERATED_AT,
    market: 'US',
    source: 'wave18_abyssian_official_shopify_us_source_probe',
    curation_policy:
      'Abyssian official Shopify US PDPs only: require Shopify country US, USD price, in-stock embedded product JSON, product imagery, explicit full ingredient text, and explicit how-to. Hold unavailable, 404, high-risk hair-loss/growth/dandruff/healing/acne/eczema rows, and conditioner how-to text that conflicts with conditioner use.',
    item_count: finalItems.length,
    held_item_count: heldItems.length,
    held_items: heldItems,
    items: finalItems,
  };
  const audit = {
    generated_at: GENERATED_AT,
    market: 'US',
    source: manifest.source,
    scanned: auditRows.length,
    ready_count: finalItems.length,
    held_count: heldItems.length,
    audit_rows: auditRows,
  };
  const manifestPath = path.join(REPORT_DIR, 'candidate_manifest.json');
  const dbReadyPath = path.join(REPORT_DIR, 'db_ready_candidate_manifest.json');
  const auditPath = path.join(REPORT_DIR, 'official_source_probe_audit.json');
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
        ready_titles: finalItems.map((item) => item.seed_row.title),
        held: heldItems.map((item) => ({
          file: item.file,
          title: item.title,
          reasons: item.reasons,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

main();
