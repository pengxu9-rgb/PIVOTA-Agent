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
  'reports/markato_expansion_status_20260524/wave19_direct_source_probe_20260525',
);
const SOURCE_DIR = path.join(REPORT_DIR, 'source_html');
const GENERATED_AT = new Date().toISOString();
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';

const MANUAL_HOW_TO = {
  daeby_cleanser_country_us:
    'Work into a lather. Massage onto face and neck. Rinse away with lukewarm water. Use daily - morning and night.',
  daeby_gentle_scrub_country_us:
    'Apply 1-2 pumps to damp skin. Massage gently in circles. Rinse thoroughly. Use 2-3 times per week.',
};

const TARGETS = [
  {
    file: 'aetas_serum_country_us.html',
    brand: 'Aetās',
    domain: 'aetasofficial.com',
    sourceBaseUrl: 'https://aetasofficial.com',
    ready: true,
    productType: 'Face Serum',
    category: 'Skincare',
    categoryPath: ['beauty', 'skincare', 'treat', 'serum'],
    catalogCategoryPath: 'beauty/skincare/treat/serum',
    productFamily: 'single_formula',
    sourceKind: 'aetas_shopify_country_us',
  },
  {
    file: 'aetas_cleanser_country_us.html',
    brand: 'Aetās',
    domain: 'aetasofficial.com',
    sourceBaseUrl: 'https://aetasofficial.com',
    ready: false,
    productType: 'Oil Cleanser',
    category: 'Skincare',
    categoryPath: ['beauty', 'skincare', 'cleanse', 'cleanser'],
    catalogCategoryPath: 'beauty/skincare/cleanse/cleanser',
    productFamily: 'single_formula',
    sourceKind: 'aetas_shopify_country_us',
  },
  {
    file: 'aetas_lotion_country_us.html',
    brand: 'Aetās',
    domain: 'aetasofficial.com',
    sourceBaseUrl: 'https://aetasofficial.com',
    ready: false,
    productType: 'Toner Lotion',
    category: 'Skincare',
    categoryPath: ['beauty', 'skincare', 'tone', 'toner'],
    catalogCategoryPath: 'beauty/skincare/tone/toner',
    productFamily: 'single_formula',
    sourceKind: 'aetas_shopify_country_us',
  },
  {
    file: 'aetas_moisturizer_country_us.html',
    brand: 'Aetās',
    domain: 'aetasofficial.com',
    sourceBaseUrl: 'https://aetasofficial.com',
    ready: false,
    productType: 'Moisturizer',
    category: 'Skincare',
    categoryPath: ['beauty', 'skincare', 'moisturize', 'moisturizer'],
    catalogCategoryPath: 'beauty/skincare/moisturize/moisturizer',
    productFamily: 'single_formula',
    sourceKind: 'aetas_shopify_country_us',
  },
  {
    file: 'daeby_cleanser_country_us.html',
    brand: 'DAEBY',
    domain: 'daebyskin.com',
    sourceBaseUrl: 'https://www.daebyskin.com',
    ready: true,
    productType: 'Cleanser',
    category: 'Skincare',
    categoryPath: ['beauty', 'skincare', 'cleanse', 'cleanser'],
    catalogCategoryPath: 'beauty/skincare/cleanse/cleanser',
    productFamily: 'single_formula',
    sourceKind: 'daeby_shopify_country_us',
    howToSourceKind: 'official_pdp_image_ocr_how_to',
  },
  {
    file: 'daeby_gentle_scrub_country_us.html',
    brand: 'DAEBY',
    domain: 'daebyskin.com',
    sourceBaseUrl: 'https://www.daebyskin.com',
    ready: true,
    productType: 'Facial Scrub',
    category: 'Skincare',
    categoryPath: ['beauty', 'skincare', 'exfoliate', 'face-scrub'],
    catalogCategoryPath: 'beauty/skincare/exfoliate/face-scrub',
    productFamily: 'single_formula',
    sourceKind: 'daeby_shopify_country_us',
    howToSourceKind: 'official_pdp_image_ocr_how_to',
  },
  {
    file: 'daeby_bathroom_basics_country_us.html',
    brand: 'DAEBY',
    domain: 'daebyskin.com',
    sourceBaseUrl: 'https://www.daebyskin.com',
    ready: false,
    productType: 'Set',
    category: 'Skincare Set',
    categoryPath: ['beauty', 'skincare', 'sets'],
    catalogCategoryPath: 'beauty/skincare/sets',
    productFamily: 'set_or_collection',
    sourceKind: 'daeby_shopify_country_us',
  },
  {
    file: 'daeby_skincare_essentials_country_us.html',
    brand: 'DAEBY',
    domain: 'daebyskin.com',
    sourceBaseUrl: 'https://www.daebyskin.com',
    ready: false,
    productType: 'Set',
    category: 'Skincare Set',
    categoryPath: ['beauty', 'skincare', 'sets'],
    catalogCategoryPath: 'beauty/skincare/sets',
    productFamily: 'set_or_collection',
    sourceKind: 'daeby_shopify_country_us',
  },
  {
    file: 'seresilk_pure_silk_exfoliator_country_us.html',
    brand: 'Seresilk',
    domain: 'seresilk.com.au',
    sourceBaseUrl: 'https://seresilk.com.au',
    ready: true,
    productType: 'Skincare Tool',
    category: 'Beauty Tool',
    categoryPath: ['beauty', 'skincare', 'tools', 'exfoliator'],
    catalogCategoryPath: 'beauty/skincare/tools/exfoliator',
    productFamily: 'accessory',
    sourceKind: 'seresilk_shopify_country_us',
  },
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function normalizeUrl(value, baseUrl) {
  const raw = text(value);
  if (!raw || /^https:files\//i.test(raw)) return '';
  try {
    const parsed = new URL(raw.startsWith('//') ? `https:${raw}` : raw, baseUrl);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return raw;
  }
}

function appendCountryUs(value, baseUrl) {
  const url = normalizeUrl(value, baseUrl);
  if (!url) return '';
  const parsed = new URL(url);
  parsed.searchParams.set('country', 'US');
  return parsed.toString();
}

function parseJsonMaybe(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseProductJsonLd(html) {
  const blocks = [...String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    const parsed = parseJsonMaybe(block[1].trim());
    const candidates = [];
    if (Array.isArray(parsed)) candidates.push(...parsed);
    else if (parsed && typeof parsed === 'object') {
      candidates.push(parsed);
      if (Array.isArray(parsed['@graph'])) candidates.push(...parsed['@graph']);
    }
    const product = candidates.find((item) => {
      const type = item && item['@type'];
      return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
    });
    if (product) return product;
  }
  return {};
}

function parseMetaProduct(html) {
  const match = String(html || '').match(/var meta = ([\s\S]*?);\s*$/m);
  const parsed = match ? parseJsonMaybe(match[1]) : null;
  return parsed?.product || {};
}

function parseProductVariants(html) {
  const match = String(html || '').match(/"productVariants":(\[[\s\S]*?\])\s*,\s*"products"/);
  const parsed = match ? parseJsonMaybe(match[1]) : null;
  return Array.isArray(parsed) ? parsed : [];
}

function parseOffers(productLd) {
  const offers = productLd?.offers;
  if (Array.isArray(offers)) return offers;
  return offers && typeof offers === 'object' ? [offers] : [];
}

function isInStock(value) {
  return /in\s*stock|instock|available/i.test(String(value || ''));
}

function isOutOfStock(value) {
  return /out\s*of\s*stock|outofstock|sold\s*out|unavailable/i.test(String(value || ''));
}

function isLikelyProductImageUrl(value) {
  const lower = String(value || '').toLowerCase();
  if (!/^https?:\/\//.test(lower)) return false;
  if (lower.endsWith('.svg')) return false;
  if (/logo|icon|sprite|payment|placeholder|review|instagram|facebook|award|badge|clinical|test|how_to_use/.test(lower)) {
    return false;
  }
  return true;
}

function collectImages(html, productLd, productVariants, baseUrl) {
  const seen = new Set();
  const out = [];
  const add = (raw) => {
    const url = normalizeUrl(raw, baseUrl);
    if (!isLikelyProductImageUrl(url)) return;
    const key = url.replace(/[?&](?:w|h|width|height|crop)=[^&]+/gi, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(url);
  };

  add(firstMatch(html, /property=["']og:image:secure_url["']\s+content=["']([^"']+)["']/i));
  add(firstMatch(html, /property=["']og:image["']\s+content=["']([^"']+)["']/i));
  for (const image of asArray(productLd?.image)) add(image);
  if (typeof productLd?.image === 'string') add(productLd.image);
  for (const variant of productVariants) add(variant?.image?.src);
  for (const match of String(html || '').matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    const fragment = match[0];
    if (!/product|serum|cleanser|scrub|exfoliator|daily-cleanser|gentle-scrub|silk/i.test(fragment)) continue;
    add(match[1]);
  }
  return out.slice(0, 10);
}

function extractAetasAccordionSection(html, label) {
  const titleRegex = new RegExp(`<h2[^>]*>\\s*${escapeRegExp(label)}\\s*<\\/h2>`, 'i');
  const titleMatch = titleRegex.exec(html);
  if (!titleMatch) return '';
  const after = html.slice(titleMatch.index);
  const contentMatch = after.match(/<div class=["']accordion__content rte["'][^>]*>([\s\S]*?)<\/div>\s*<\/details>/i);
  return contentMatch ? stripHtml(contentMatch[1]) : '';
}

function extractSeresilkTabs(html) {
  const tabStart = String(html || '').indexOf('product-tabs__tab-buttons');
  const mobileStart = String(html || '').indexOf('product-tabs__mobile-accordions', tabStart);
  if (tabStart < 0 || mobileStart < 0) return {};
  const slice = html.slice(tabStart, mobileStart);
  const labelBlockEnd = slice.indexOf('product-tabs__tab-list-wrapper');
  const labelBlock = labelBlockEnd > 0 ? slice.slice(0, labelBlockEnd) : slice;
  const labels = [...labelBlock.matchAll(/<span[^>]*class=["']ff-heading fs-body-100["'][^>]*>([\s\S]*?)<\/span>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter(Boolean);
  const bodies = [...slice.matchAll(/<div class=["']product-tabs__tab-text ff-body fs-body-75 rte["']>\s*([\s\S]*?)\s*<\/div>/gi)].map(
    (match) => stripHtml(match[1]),
  );
  const out = {};
  labels.forEach((label, idx) => {
    if (bodies[idx]) out[label] = bodies[idx];
  });
  return out;
}

function extractDaebyAccordionSection(html, label) {
  const labelPattern = escapeRegExp(label);
  const regex = new RegExp(
    `<summary[^>]*>\\s*<p>\\s*${labelPattern}\\s*<\\/p>[\\s\\S]*?<div class=["']content wysiwyg["']>([\\s\\S]*?)<\\/div>\\s*<\\/details>`,
    'i',
  );
  const match = String(html || '').match(regex);
  return match ? stripHtml(match[1]) : '';
}

function extractionForTarget(target, html) {
  if (target.sourceKind.startsWith('aetas_')) {
    return {
      descriptionRaw: stripHtml(parseProductJsonLd(html)?.description || firstMatch(html, /name=["']description["']\s+content=["']([^"']+)["']/i)),
      howToRaw: extractAetasAccordionSection(html, 'Usage'),
      ingredientsRaw: extractAetasAccordionSection(html, 'Ingredients'),
      ingredientSourceKind: 'official_shopify_pdp_ingredient_accordion',
      howToSourceKind: 'official_shopify_pdp_usage_accordion',
    };
  }
  if (target.sourceKind.startsWith('seresilk_')) {
    const tabs = extractSeresilkTabs(html);
    const heroIngredient = tabs['Hero ingredient'] || tabs['Hero ingredients'] || '';
    const ingredient = tabs.Ingredient || tabs.Ingredients || '';
    return {
      descriptionRaw: tabs.Description || stripHtml(parseProductJsonLd(html)?.description || ''),
      howToRaw: tabs['How to use'] || '',
      ingredientsRaw:
        target.productFamily === 'accessory'
          ? text([heroIngredient, ingredient].filter(Boolean).join(' '))
          : ingredient,
      ingredientSourceKind:
        target.productFamily === 'accessory'
          ? 'official_shopify_pdp_materials_tab'
          : 'official_shopify_pdp_ingredient_tab',
      howToSourceKind: 'official_shopify_pdp_how_to_tab',
    };
  }
  if (target.sourceKind.startsWith('daeby_')) {
    const key = path.basename(target.file, '.html');
    const productLd = parseProductJsonLd(html);
    return {
      descriptionRaw: stripHtml(productLd?.description || firstMatch(html, /name=["']description["']\s+content=["']([^"']+)["']/i)),
      howToRaw: MANUAL_HOW_TO[key] || '',
      ingredientsRaw: extractDaebyAccordionSection(html, 'Ingredients'),
      ingredientSourceKind: 'official_shopify_pdp_ingredient_accordion',
      howToSourceKind: target.howToSourceKind || 'official_shopify_pdp_how_to',
    };
  }
  return { descriptionRaw: '', howToRaw: '', ingredientsRaw: '', ingredientSourceKind: '', howToSourceKind: '' };
}

function ingredientDeck(raw) {
  return text(String(raw || '').split(/\bIngredients explained\s*:/i)[0]);
}

function ingredientNames(raw) {
  return ingredientDeck(raw)
    .replace(/\bThe Serum\s+\S+\s*/gi, '')
    .split(/\s*,\s*/)
    .map((item) => text(item).replace(/\.+$/g, ''))
    .filter((item) => item.length >= 2)
    .filter((item) => !/^(ingredients|full ingredients list|the serum)$/i.test(item));
}

function sourceContract(sourceUrl, sourceName) {
  return {
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: sourceName,
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'replace_not_merge',
    source_url: sourceUrl,
    updated_at: GENERATED_AT,
  };
}

function qualitySummary(sourceUrl, target, accessory = false) {
  const base = {
    source_origin: 'official_shopify_country_us_pdp_html',
    source_quality_status: 'high',
    source_url: sourceUrl,
    reviewed_by: 'codex_wave19_direct_source',
    reviewed_at: GENERATED_AT,
  };
  const ingredientBase = accessory
    ? {
        ...base,
        source_quality_status: 'reviewed_not_applicable',
        not_applicable_reason: 'reviewed_skincare_tool_not_formula',
      }
    : base;
  return {
    description_raw: base,
    ingredients_raw: ingredientBase,
    ingredients_inci: ingredientBase,
    how_to_use_raw: { ...base, source_origin: target.howToSourceKind || base.source_origin },
    details_sections: base,
    category: base,
    product_type: base,
    image_assets: base,
  };
}

function publicDescription(target, title, ingredients) {
  if (target.productFamily === 'accessory') {
    return `${title} is a Seresilk reusable silk skincare exfoliator with source-backed use directions and material details. INCI is not applicable because this reviewed item is a skincare tool, not a formula.`;
  }
  const preview = asArray(ingredients).slice(0, 5).join(', ');
  const ingredientSentence = preview ? ` Key listed ingredients include ${preview}.` : '';
  const article = /^[aeiou]/i.test(text(target.brand)) ? 'an' : 'a';
  return `${title} is ${article} ${target.brand} ${target.productType.toLowerCase()} with source-backed use directions and a complete ingredient list.${ingredientSentence}`;
}

function sourceWarningCodes(sourceText) {
  const warnings = [];
  if (/\b(?:clinical|clinically|dermatologically|fine lines?|collagen|healing|repair|anti-aging|anti wrinkle|anti-wrinkle)\b/i.test(sourceText)) {
    warnings.push('source_claim_terms_sanitized_from_public_description');
  }
  return warnings;
}

function normalizeVariants(productLd, productVariants, metaProduct, target, sourceUrl, description, fallbackImage) {
  const offers = parseOffers(productLd);
  if (offers.length) {
    return offers.map((offer, idx) => {
      const variantFromRuntime =
        productVariants.find((variant) => text(variant?.sku) && text(variant.sku) === text(offer.sku)) ||
        productVariants[idx] ||
        {};
      const metaVariant =
        asArray(metaProduct?.variants).find((variant) => text(variant?.sku) && text(variant.sku) === text(offer.sku)) ||
        asArray(metaProduct?.variants)[idx] ||
        {};
      const price = Number(offer.price || variantFromRuntime?.price?.amount);
      const imageUrl = normalizeUrl(variantFromRuntime?.image?.src || fallbackImage, target.sourceBaseUrl);
      return {
        sku: text(offer.sku || variantFromRuntime?.sku || metaVariant?.sku || `SHOPIFY-${variantFromRuntime?.id || metaVariant?.id || idx + 1}`),
        variant_id: text(String(variantFromRuntime?.id || metaVariant?.id || offer.sku || idx + 1)),
        url: appendCountryUs(offer.url || sourceUrl, target.sourceBaseUrl),
        option_name: target.brand === 'Aetās' ? 'Skin Undertone' : 'Title',
        option_value: text(variantFromRuntime?.title || metaVariant?.public_title || metaVariant?.name || 'Default Title'),
        ...(target.brand === 'Aetās' ? { axis_kind: 'shade' } : {}),
        price: Number.isFinite(price) ? String(price) : '',
        currency: 'USD',
        stock: isOutOfStock(offer.availability) ? 'Out of Stock' : 'In Stock',
        description,
        image_url: imageUrl || fallbackImage || '',
        image_urls: [imageUrl || fallbackImage || ''].filter(Boolean),
        images: [imageUrl || fallbackImage || ''].filter(Boolean),
      };
    });
  }
  return productVariants.map((variant, idx) => {
    const price = Number(variant?.price?.amount);
    const imageUrl = normalizeUrl(variant?.image?.src || fallbackImage, target.sourceBaseUrl);
    return {
      sku: text(variant?.sku || `SHOPIFY-${variant?.id || idx + 1}`),
      variant_id: text(String(variant?.id || idx + 1)),
      url: sourceUrl,
      option_name: target.brand === 'Aetās' ? 'Skin Undertone' : 'Title',
      option_value: text(variant?.title || 'Default Title'),
      ...(target.brand === 'Aetās' ? { axis_kind: 'shade' } : {}),
      price: Number.isFinite(price) ? String(price) : '',
      currency: 'USD',
      stock: 'In Stock',
      description,
      image_url: imageUrl || fallbackImage || '',
      image_urls: [imageUrl || fallbackImage || ''].filter(Boolean),
      images: [imageUrl || fallbackImage || ''].filter(Boolean),
    };
  });
}

function commerceFacts(row, displayRaw, sourceAuthority) {
  return buildCommerceFactsFromSeedRow(row, {
    sourceAuthority,
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

function buildCandidate(target) {
  const htmlPath = path.join(SOURCE_DIR, target.file);
  const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
  const productLd = parseProductJsonLd(html);
  const productVariants = parseProductVariants(html);
  const metaProduct = parseMetaProduct(html);
  const canonicalUrl = normalizeUrl(
    firstMatch(html, /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i) ||
      productLd?.url ||
      firstMatch(html, /property=["']og:url["']\s+content=["']([^"']+)["']/i),
    target.sourceBaseUrl,
  );
  const sourceUrl = canonicalUrl ? appendCountryUs(canonicalUrl, target.sourceBaseUrl) : '';
  const title = text(productLd?.name || firstMatch(html, /property=["']og:title["']\s+content=["']([^"']+)["']/i));
  const shopifyCountry = firstMatch(html, /Shopify\.country\s*=\s*["']([^"']+)["']/i);
  const priceCurrency =
    firstMatch(html, /property=["']og:price:currency["']\s+content=["']([^"']+)["']/i) ||
    firstMatch(html, /Shopify\.currency\s*=\s*\{[^}]*["']active["']\s*:\s*["']([^"']+)["']/i);
  const offers = parseOffers(productLd);
  const offerCurrencies = offers.map((offer) => text(offer.priceCurrency)).filter(Boolean);
  const availabilityValues = offers.map((offer) => text(offer.availability)).filter(Boolean);
  const available = availabilityValues.length ? availabilityValues.some(isInStock) && !availabilityValues.every(isOutOfStock) : true;
  const price =
    Number(offers.find((offer) => Number.isFinite(Number(offer.price)))?.price) ||
    Number(firstMatch(html, /property=["']og:price:amount["']\s+content=["']([^"']+)["']/i)) ||
    Number(productVariants.find((variant) => Number.isFinite(Number(variant?.price?.amount)))?.price?.amount);
  const displayRaw = firstMatch(html, /property=["']og:price:amount["']\s+content=["']([^"']+)["']/i) || String(price || '');
  const images = collectImages(html, productLd, productVariants, target.sourceBaseUrl);
  const extracted = extractionForTarget(target, html);
  const isAccessory = target.productFamily === 'accessory';
  const ingredientsRaw = isAccessory ? text(extracted.ingredientsRaw) : ingredientDeck(extracted.ingredientsRaw);
  const ingredientList = isAccessory ? [] : ingredientNames(ingredientsRaw);
  const description = publicDescription(target, title, ingredientList);
  const sourceTextForWarnings = [title, extracted.descriptionRaw, extracted.howToRaw, extracted.ingredientsRaw].join(' ');

  const auditBase = {
    file: target.file,
    target_url: sourceUrl,
    html_path: path.relative(process.cwd(), htmlPath),
    brand: target.brand,
    title,
    price_currency: priceCurrency,
    offer_currencies: offerCurrencies,
    shopify_country: shopifyCountry,
    availability_values: availabilityValues,
    available,
    has_product_json_ld: Boolean(productLd?.name),
    variant_count: Math.max(productVariants.length, offers.length),
    image_count: images.length,
    price: Number.isFinite(price) ? price : null,
    product_family: target.productFamily,
    ingredients_raw_length: ingredientsRaw.length,
    ingredients_count: ingredientList.length,
    how_to_use_length: text(extracted.howToRaw).length,
    category_path: target.catalogCategoryPath,
  };

  const reasons = [];
  if (!sourceUrl) reasons.push('missing_official_product_url');
  if (!canonicalUrl || !canonicalUrl.startsWith(target.sourceBaseUrl)) reasons.push('not_official_product_pdp');
  if (shopifyCountry !== 'US') reasons.push('shopify_country_not_us');
  if (priceCurrency !== 'USD' && !offerCurrencies.includes('USD')) reasons.push('price_not_usd');
  if (!(price > 0 && price < 250)) reasons.push('price_sanity_failed');
  if (!available) reasons.push('out_of_stock_or_unavailable');
  if (!images.length) reasons.push('missing_product_images');
  if (!text(extracted.howToRaw) || text(extracted.howToRaw).length < 40) reasons.push('missing_official_how_to');
  if (target.productFamily === 'set_or_collection') reasons.push('set_or_collection_hold');
  if (!isAccessory && (ingredientList.length < 8 || ingredientsRaw.length < 80)) reasons.push('missing_full_ingredient_text');
  if (isAccessory && !/\bsilk\b/i.test(ingredientsRaw)) reasons.push('missing_accessory_material_source');
  if (!target.ready) reasons.push('manual_candidate_hold');

  const warnings = sourceWarningCodes(sourceTextForWarnings);

  if (reasons.length) {
    return {
      audit: {
        ...auditBase,
        status: 'hold',
        reasons: [...new Set(reasons)],
        warnings,
      },
      item: null,
    };
  }

  const externalProductId = stableExternalProductId(sourceUrl);
  const seedId = stableSeedId(sourceUrl);
  const variants = normalizeVariants(productLd, productVariants, metaProduct, target, sourceUrl, description, images[0]).filter(
    (variant) => variant.stock !== 'Out of Stock' && (variant.sku || variant.variant_id),
  );
  const primaryVariant = variants[0] || {
    sku: text(offers[0]?.sku || metaProduct?.variants?.[0]?.sku || `SHOPIFY-${metaProduct?.id || externalProductId}`),
    variant_id: text(String(metaProduct?.variants?.[0]?.id || offers[0]?.sku || externalProductId)),
    url: sourceUrl,
    option_name: 'Title',
    option_value: 'Default Title',
    price: String(price),
    currency: 'USD',
    stock: 'In Stock',
    description,
    image_url: images[0],
    image_urls: [images[0]].filter(Boolean),
    images: [images[0]].filter(Boolean),
  };
  const howToUse = text(extracted.howToRaw);
  const materialOrIngredientsBody = isAccessory
    ? 'INCI not applicable. Material source: Pure, raw and unrefined silk / silk cocoon.'
    : ingredientList.join(', ');
  const detailsSections = [
    {
      heading: 'How to Use',
      body: howToUse,
      source_kind: extracted.howToSourceKind,
    },
    {
      heading: isAccessory ? 'Materials' : 'Ingredients',
      body: materialOrIngredientsBody,
      source_kind: extracted.ingredientSourceKind,
    },
  ];

  const ingredientIntel = isAccessory
    ? {
        not_applicable: true,
        inci_applicability: {
          status: 'not_applicable',
          reason: 'reviewed_skincare_tool_not_formula',
        },
        not_applicable_reason: 'reviewed_skincare_tool_not_formula',
        source_kind: extracted.ingredientSourceKind,
        source_url: sourceUrl,
      }
    : {
        raw_ingredient_text_clean: ingredientList.join(', '),
        inci_raw: ingredientList.join(', '),
        inci_list: ingredientList,
        inci_normalized: ingredientList,
        source_kind: extracted.ingredientSourceKind,
        source_url: sourceUrl,
      };

  const seedData = {
    brand: target.brand,
    title,
    description,
    external_product_id: externalProductId,
    canonical_url: sourceUrl,
    destination_url: sourceUrl,
    price_amount: price,
    price_currency: 'USD',
    availability: 'in_stock',
    image_url: images[0],
    image_urls: images,
    images,
    variants: variants.length ? variants : [primaryVariant],
    category: target.category,
    category_path: target.categoryPath,
    catalog_category_path: target.catalogCategoryPath,
    product_kind: target.productFamily,
    product_family: target.productFamily,
    product_type: target.productType,
    pdp_description_raw: description,
    pdp_official_description_raw: description,
    pdp_source_description_raw: `${description} How to Use: ${howToUse} ${
      isAccessory ? 'Materials' : 'Ingredients'
    }: ${materialOrIngredientsBody}`,
    pdp_ingredients_raw: materialOrIngredientsBody,
    raw_ingredient_text_clean: isAccessory ? '' : ingredientList.join(', '),
    ingredients_inci: ingredientList,
    inci_list: ingredientList,
    pdp_how_to_use_raw: howToUse,
    pdp_details_sections: detailsSections,
    ingredient_intel: ingredientIntel,
    external_seed_snapshot_contract: sourceContract(sourceUrl, `wave19_${target.sourceKind}_seed_creation_manifest`),
    pdp_field_quality_summary: qualitySummary(sourceUrl, target, isAccessory),
    pdp_field_capture_status: {
      description_raw: 'captured',
      ingredients_raw: isAccessory ? 'not_applicable' : 'captured',
      how_to_use_raw: 'captured',
      details_sections: 'captured',
    },
    authority_source: {
      source_url: sourceUrl,
      official_canonical_url: canonicalUrl,
      source_role: 'direct_official_pdp_html',
      official_description_raw: extracted.descriptionRaw,
      official_ingredients_source_raw: extracted.ingredientsRaw,
      official_how_to_source_raw: howToUse,
      matched_preferred_titles: [title],
    },
    source_validation: {
      source_type: 'brand_owned',
      source_host: target.domain,
      requires_multi_offer_merge_validation: false,
    },
    search_aliases: [title, `${target.brand} ${title}`, `${target.brand} ${target.productType}`],
  };
  if (isAccessory) {
    seedData.ingredient_remediation_v1 = {
      action: 'mark_inci_not_applicable',
      source_quality_status: 'reviewed_not_applicable',
      reason: 'reviewed_skincare_tool_not_formula',
    };
  }
  seedData.snapshot = {
    source: `wave19_${target.sourceKind}_official_seed_creation_manifest`,
    extracted_at: GENERATED_AT,
    canonical_url: sourceUrl,
    destination_url: sourceUrl,
    title,
    description,
    image_url: images[0],
    image_urls: images,
    images,
    variants: variants.length ? variants : [primaryVariant],
    shopify_country: shopifyCountry,
    product_family: target.productFamily,
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
        'product_family',
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
        'ingredient_remediation_v1',
        'external_seed_snapshot_contract',
        'pdp_field_quality_summary',
        'pdp_field_capture_status',
        'authority_source',
        'source_validation',
        'search_aliases',
      ]
        .filter((key) => seedData[key] !== undefined)
        .map((key) => [key, seedData[key]]),
    ),
  };

  const row = {
    ingredient_id: null,
    ingredient_name: null,
    seed_id: seedId,
    brand: target.brand,
    market: 'US',
    tool: 'creator_agents',
    status: 'active',
    domain: target.domain,
    external_product_id: externalProductId,
    canonical_url: sourceUrl,
    destination_url: sourceUrl,
    title,
    image_url: images[0],
    price_amount: price,
    price_currency: 'USD',
    availability: 'in_stock',
    attached_product_key: null,
    requires_seed_correction: false,
    seed_data: seedData,
  };

  const facts = commerceFacts(row, displayRaw || price.toFixed(2), `official_${target.sourceKind}_pdp_html`);
  row.seed_data.commerce_facts_v1 = facts;
  row.seed_data.snapshot.commerce_facts_v1 = facts;
  const gate = validateCommerceFactsGateForSeedRow(row);
  row.seed_data.commerce_facts_gate = gate;
  row.seed_data.snapshot.commerce_facts_gate = gate;

  const item = {
    ingredient_id: null,
    ingredient_name: null,
    target_brand: target.brand,
    target_url: sourceUrl,
    extract_status: 'official_shopify_us_pdp_ready',
    market: 'US',
    source_domain: target.domain,
    source_role: 'direct_official_pdp_html',
    matched_preferred_titles: [title],
    seed_row: row,
    curation_decision: {
      decision: 'db_ready_candidate',
      reason_codes: [
        'official_usd_in_stock_pdp',
        isAccessory ? 'reviewed_accessory_inci_not_applicable' : 'source_backed_ingredients_and_how_to',
      ],
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
  const built = TARGETS.map(buildCandidate);
  const auditRows = built.map((entry) => entry.audit);
  const finalItems = built
    .filter((entry) => entry.item && entry.audit.status === 'ready')
    .map((entry) => entry.item);
  const heldItems = auditRows.filter((row) => row.status !== 'ready');
  const manifest = {
    generated_at: GENERATED_AT,
    market: 'US',
    source: 'wave19_direct_official_shopify_country_us_source_probe',
    curation_policy:
      'Direct official PDPs only: require Shopify country US, USD offer, in-stock schema offer, usable product imagery, explicit source-backed how-to, and full INCI for formulas. Reviewed accessory/tool rows may mark INCI not applicable only with material evidence and product_family=accessory. Hold sets, out-of-stock rows, duplicate/already-covered rows, non-US currency, and image-only how-to unless OCR has been manually reviewed from official PDP images.',
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
        ready_titles: finalItems.map((item) => `${item.seed_row.brand}: ${item.seed_row.title}`),
        held: heldItems.map((item) => ({
          file: item.file,
          brand: item.brand,
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
