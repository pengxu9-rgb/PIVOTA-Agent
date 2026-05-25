#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  collectImageUrls,
  mapVariants,
  normalizeAvailability,
  parsePrice,
  stableExternalProductId,
  stableSeedId,
} = require(path.join(process.cwd(), 'scripts/build_aurora_external_seed_creation_manifest.cjs'));
const {
  attachCommerceFactsToSeedRow,
  validateCommerceFactsGateForSeedRow,
} = require(path.join(process.cwd(), 'src/commerce/commerceFacts'));

const REPORT_DIR = path.join(
  process.cwd(),
  'reports/markato_expansion_status_20260524/wave12_apiceuticals_batch_20260525',
);
const EXTRACT_DIR = path.join(REPORT_DIR, 'extracts');
const GENERATED_AT = new Date().toISOString();

const READY_TARGETS = [
  {
    file: 'conditioner.extract.json',
    target_url: 'https://www.apiceuticals.com/shop/propowax-antioxidant-conditioner/',
    title: 'PROPOWAX\u2122 Antioxidant Conditioner 300ml',
    category: 'Haircare',
    category_path: ['beauty', 'haircare', 'conditioner'],
    catalog_category_path: 'beauty/haircare/conditioner',
    product_type: 'Conditioner',
  },
  {
    file: 'shower_gel.extract.json',
    target_url: 'https://www.apiceuticals.com/shop/propowax-antioxidant-shower-gel/',
    title: 'PROPOWAX\u2122 Antioxidant Shower Gel 300ml',
    category: 'Bodycare',
    category_path: ['beauty', 'bodycare', 'body wash'],
    catalog_category_path: 'beauty/bodycare/body-wash',
    product_type: 'Body Wash',
  },
  {
    file: 'body_lotion.extract.json',
    target_url: 'https://www.apiceuticals.com/shop/propowax-antioxidant-body-lotion/',
    title: 'PROPOWAX\u2122 Antioxidant Body Lotion 300ml',
    category: 'Bodycare',
    category_path: ['beauty', 'bodycare', 'body lotion'],
    catalog_category_path: 'beauty/bodycare/body-lotion',
    product_type: 'Body Lotion',
  },
  {
    file: 'dry_oil.extract.json',
    target_url: 'https://www.apiceuticals.com/shop/propowax-antioxidant-dry-oil/',
    title: 'PROPOWAX\u2122 Antioxidant Dry Oil 100ml',
    category: 'Bodycare',
    category_path: ['beauty', 'bodycare', 'body oil'],
    catalog_category_path: 'beauty/bodycare/body-oil',
    product_type: 'Dry Oil',
  },
];

const HOLD_TARGETS = [
  {
    file: 'honey_balm.extract.json',
    target_url: 'https://www.apiceuticals.com/shop/propowax-antioxidant-honey-balm/',
    hold_reason: 'target_url_404_extractor_fell_back_to_blog',
  },
];

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function multiline(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeUrl(value) {
  const next = text(value);
  return /^https?:\/\//i.test(next) ? next : '';
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function cleanIngredientsRaw(value) {
  const withoutHtml = String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\bmpp-container-[^\s>'"]+(?:\s+mpp-container-[^\s>'"]+)*['"]?/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\r\n/g, '\n');
  const candidates = withoutHtml
    .split(/\n+|\u2713/)
    .map((part) =>
      part
        .replace(/\bINGREDIENTS\s*\/\s*INCI\s+LIST\b/gi, ' ')
        .replace(/\bDermatologically tested on Sensitive Skin\b/gi, ' ')
        .replace(/\bWithout\s+sles\/sls,\s*parabens,\s*silicones\s*&\s*sodium\s+chloride\b/gi, ' ')
        .replace(/\b\d{1,3}%\s+natural\s*&\s*organic\s+content\b/gi, ' ')
        .replace(/\b100%\s*Clean,\s*Sustainable,\s*Cruelty-free\s+Beauty\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((part) => {
      const commaCount = (part.match(/,/g) || []).length;
      return commaCount >= 4 && /[a-z]/i.test(part) && !/\b(?:how to use|shipping|returns|faq)\b/i.test(part);
    });
  const unique = [];
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!normalized) continue;
    if (unique.some((item) => item.normalized === normalized)) continue;
    unique.push({ value: candidate.replace(/\s+([,.;:!?])/g, '$1').trim(), normalized });
  }
  return (unique[0] && unique[0].value) || text(value);
}

function splitInci(raw) {
  return cleanIngredientsRaw(raw)
    .split(/\s*,\s*/)
    .map((item) => item.trim())
    .filter((item) => item.length > 1)
    .filter((item) => !/^(?:and|or|ingredients?|inci|list)$/i.test(item));
}

function cleanDetailsSections(product, cleanIngredients) {
  const details = asArray(product.details_sections);
  const wanted = new Set(['details', 'how to use', 'ingredients']);
  const out = [];
  for (const section of details) {
    const heading = text(section.heading);
    const key = heading.toLowerCase();
    if (!wanted.has(key)) continue;
    if (/\bverified review\b/i.test(text(section.body))) continue;
    const body =
      key === 'ingredients'
        ? cleanIngredients
        : key === 'how to use'
          ? multiline(product.how_to_use_raw)
          : multiline(product.description_raw);
    if (!body) continue;
    out.push({
      heading,
      body,
      source_kind: text(section.source_kind) || 'retail_pdp',
    });
  }
  return out;
}

function fieldReady(product) {
  const quality = asObject(product.field_quality_summary);
  const ingredientsQuality = text(quality.ingredients_raw && quality.ingredients_raw.source_quality_status);
  const howToQuality = text(quality.how_to_use_raw && quality.how_to_use_raw.source_quality_status);
  return {
    ingredients_source_quality: ingredientsQuality || 'unknown',
    how_to_source_quality: howToQuality || 'unknown',
    ingredients_ready: ['high', 'medium'].includes(ingredientsQuality),
    how_to_ready: ['high', 'medium'].includes(howToQuality),
  };
}

function buildRow(target, product, extractDoc) {
  const variant = asObject(asArray(product.variants)[0]);
  const canonicalUrl = normalizeUrl(product.url || product.canonical_url || variant.url || target.target_url);
  const destinationUrl = canonicalUrl;
  const imageUrls = collectImageUrls(product.image_urls, product.image_url, variant.image_urls, variant.image_url);
  const priceAmount = parsePrice(variant.price) ?? parsePrice(product.price_amount) ?? parsePrice(product.price);
  const priceCurrency = text(variant.currency || product.price_currency || product.currency || 'USD') || 'USD';
  const availability = normalizeAvailability(variant.stock || product.availability || 'in_stock') || 'in_stock';
  const externalProductId = stableExternalProductId(canonicalUrl);
  const seedId = stableSeedId(canonicalUrl);
  const cleanIngredients = cleanIngredientsRaw(product.ingredients_raw);
  const ingredientsInci = splitInci(cleanIngredients);
  const howToUse = multiline(product.how_to_use_raw);
  const description = multiline(product.description_raw || variant.description);
  const detailsSections = cleanDetailsSections(product, cleanIngredients);
  const searchAliases = [target.title, text(product.title)].filter(Boolean);
  const sourceHost = hostFromUrl(canonicalUrl);

  let row = {
    ingredient_id: null,
    ingredient_name: null,
    seed_id: seedId,
    brand: 'Apiceuticals',
    market: 'US',
    tool: 'creator_agents',
    status: 'active',
    domain: sourceHost || 'apiceuticals.com',
    external_product_id: externalProductId,
    canonical_url: canonicalUrl,
    destination_url: destinationUrl,
    title: target.title,
    image_url: imageUrls[0] || null,
    price_amount: priceAmount,
    price_currency: priceCurrency,
    availability,
    attached_product_key: null,
    requires_seed_correction: false,
    seed_data: {
      authority_source: {
        source_url: canonicalUrl,
        source_role: 'direct_official_pdp',
        matched_preferred_titles: [target.title],
      },
      availability,
      brand: 'Apiceuticals',
      canonical_url: canonicalUrl,
      catalog_category_path: target.catalog_category_path,
      category: target.category,
      category_path: target.category_path,
      description,
      destination_url: destinationUrl,
      external_product_id: externalProductId,
      faq_items: asArray(product.faq_items),
      field_capture_status: asObject(product.field_capture_status),
      image_url: imageUrls[0] || '',
      image_urls: imageUrls,
      images: imageUrls,
      inci_list: ingredientsInci,
      ingredients_inci: ingredientsInci,
      pdp_description_raw: description,
      pdp_details_sections: detailsSections,
      pdp_field_capture_status: asObject(product.field_capture_status),
      pdp_field_quality_summary: asObject(product.field_quality_summary),
      pdp_how_to_use_raw: howToUse,
      pdp_ingredients_raw: cleanIngredients,
      price_amount: priceAmount,
      price_currency: priceCurrency,
      product_kind: text(product.product_kind) || 'single_formula',
      product_type: target.product_type,
      product_volume: text(product.product_volume),
      raw_ingredient_text_clean: cleanIngredients,
      search_aliases: searchAliases,
      size_detail_label: text(product.size_detail_label),
      source_validation: {
        source_type: 'brand_owned',
        requires_multi_offer_merge_validation: false,
        source_host: sourceHost || 'apiceuticals.com',
      },
      title: target.title,
      variants: mapVariants({
        ...product,
        title: target.title,
      }),
      volume: text(product.volume),
    },
  };

  row.seed_data.snapshot = {
    source: 'catalog_intelligence_seed_creation_manifest',
    extracted_at: GENERATED_AT,
    canonical_url: canonicalUrl,
    destination_url: destinationUrl,
    title: target.title,
    description,
    image_url: imageUrls[0] || '',
    image_urls: imageUrls,
    images: imageUrls,
    variants: row.seed_data.variants,
    diagnostics: asObject(extractDoc.diagnostics),
    search_aliases: searchAliases,
    authority_source: row.seed_data.authority_source,
    source_validation: row.seed_data.source_validation,
    catalog_category_path: target.catalog_category_path,
    category: target.category,
    category_path: target.category_path,
    product_kind: row.seed_data.product_kind,
    product_type: target.product_type,
    product_volume: row.seed_data.product_volume,
    size_detail_label: row.seed_data.size_detail_label,
    volume: row.seed_data.volume,
    pdp_description_raw: description,
    pdp_details_sections: detailsSections,
    pdp_field_capture_status: row.seed_data.pdp_field_capture_status,
    pdp_field_quality_summary: row.seed_data.pdp_field_quality_summary,
    pdp_how_to_use_raw: howToUse,
    pdp_ingredients_raw: cleanIngredients,
    raw_ingredient_text_clean: cleanIngredients,
    ingredients_inci: ingredientsInci,
    inci_list: ingredientsInci,
    field_capture_status: row.seed_data.field_capture_status,
    faq_items: row.seed_data.faq_items,
  };

  row = attachCommerceFactsToSeedRow(row, null, {
    market: 'US',
    capturedAt: GENERATED_AT,
    sourceAuthority: 'catalog_extract_v2',
  });
  const commerceFactsGate = validateCommerceFactsGateForSeedRow(row);
  row.seed_data.commerce_facts_gate = commerceFactsGate;
  row.seed_data.snapshot.commerce_facts_gate = commerceFactsGate;
  return row;
}

function readExtract(file) {
  return JSON.parse(fs.readFileSync(path.join(EXTRACT_DIR, file), 'utf8'));
}

function auditTarget(target, extractDoc) {
  const product = asObject(asArray(extractDoc.products)[0]);
  const canonicalUrl = normalizeUrl(product.url || product.canonical_url || asObject(asArray(product.variants)[0]).url);
  const price = parsePrice(asObject(asArray(product.variants)[0]).price || product.price_amount || product.price);
  const currency = text(asObject(asArray(product.variants)[0]).currency || product.price_currency || product.currency || 'USD');
  const images = collectImageUrls(product.image_urls, product.image_url, asObject(asArray(product.variants)[0]).image_urls);
  const cleanIngredients = cleanIngredientsRaw(product.ingredients_raw);
  const ingredientCount = splitInci(cleanIngredients).length;
  const readiness = fieldReady(product);
  const reasons = [];
  if (canonicalUrl !== target.target_url) reasons.push('canonical_url_drift');
  if (!(price > 0) || currency !== 'USD') reasons.push('missing_usd_price');
  if (!images.length) reasons.push('missing_images');
  if (ingredientCount < 5 || !readiness.ingredients_ready) reasons.push('missing_source_backed_full_inci');
  if (!text(product.how_to_use_raw) || !readiness.how_to_ready) reasons.push('missing_source_backed_how_to');
  if (text(asObject(extractDoc.diagnostics).block_provider)) reasons.push('block_provider_present');
  if (text(asObject(extractDoc.diagnostics).failure_category)) reasons.push('failure_category_present');
  return {
    file: target.file,
    target_url: target.target_url,
    canonical_url: canonicalUrl,
    title: text(product.title),
    price,
    currency,
    availability: text(asObject(asArray(product.variants)[0]).stock || product.availability),
    image_count: images.length,
    ingredients_count: ingredientCount,
    ingredients_raw_len: cleanIngredients.length,
    how_to_len: text(product.how_to_use_raw).length,
    field_quality: readiness,
    diagnostics: asObject(extractDoc.diagnostics),
    status: reasons.length ? 'hold' : 'ready',
    reasons,
  };
}

function main() {
  const items = [];
  const audit_rows = [];
  const held_items = [];

  for (const target of READY_TARGETS) {
    const extractDoc = readExtract(target.file);
    const product = asObject(asArray(extractDoc.products)[0]);
    const audit = auditTarget(target, extractDoc);
    audit_rows.push(audit);
    if (audit.status !== 'ready') {
      held_items.push({ ...target, ...audit });
      continue;
    }
    const seedRow = buildRow(target, product, extractDoc);
    items.push({
      ingredient_id: null,
      ingredient_name: null,
      target_brand: 'Apiceuticals',
      target_url: target.target_url,
      extract_status: 'direct_pdp_recovered_ready',
      market: 'US',
      source_domain: 'https://www.apiceuticals.com',
      source_role: 'direct_official_pdp',
      seed_row: seedRow,
    });
  }

  for (const hold of HOLD_TARGETS) {
    const extractDoc = readExtract(hold.file);
    held_items.push({
      ...hold,
      ...auditTarget(hold, extractDoc),
      status: 'hold',
      reasons: [hold.hold_reason, ...auditTarget(hold, extractDoc).reasons],
    });
  }

  const manifest = {
    generated_at: GENERATED_AT,
    market: 'US',
    source: 'wave12_apiceuticals_direct_pdp_batch',
    curation_policy:
      'Single Apiceuticals SKUs only: official direct PDP, production extractor seed_page hit, USD price, in-stock, source-backed INCI/how-to, Honey Balm 404 fallback held.',
    source_extract_dir: EXTRACT_DIR,
    item_count: items.length,
    held_item_count: held_items.length,
    held_items,
    items,
  };
  const audit = {
    generated_at: GENERATED_AT,
    market: 'US',
    source: manifest.source,
    scanned: audit_rows.length + held_items.filter((item) => !audit_rows.some((row) => row.file === item.file)).length,
    ready_count: items.length,
    held_count: held_items.length,
    audit_rows,
    held_items,
  };

  fs.writeFileSync(path.join(REPORT_DIR, 'candidate_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(REPORT_DIR, 'extract_audit.json'), `${JSON.stringify(audit, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        candidate_manifest: path.join(REPORT_DIR, 'candidate_manifest.json'),
        extract_audit: path.join(REPORT_DIR, 'extract_audit.json'),
        item_count: manifest.item_count,
        held_item_count: manifest.held_item_count,
        ready_titles: items.map((item) => item.seed_row.title),
        held_reasons: held_items.map((item) => ({ file: item.file, reasons: item.reasons })),
      },
      null,
      2,
    )}\n`,
  );
}

main();
