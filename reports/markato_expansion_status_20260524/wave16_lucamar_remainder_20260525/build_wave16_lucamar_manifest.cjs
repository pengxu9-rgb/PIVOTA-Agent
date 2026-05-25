#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  validateCommerceFactsGateForSeedRow,
} = require(path.join(process.cwd(), 'src/commerce/commerceFacts'));

const REPORT_DIR = path.join(
  process.cwd(),
  'reports/markato_expansion_status_20260524/wave16_lucamar_remainder_20260525',
);
const SOURCE_MANIFEST = path.join(REPORT_DIR, 'current_extractor_manifest_brand_owned.json');
const GENERATED_AT = new Date().toISOString();
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';

const TARGETS = {
  ext_c26547ca63d530592ed62d63: {
    product_type: 'Body Balm',
    category: 'Body Care',
    category_path: ['beauty', 'bodycare', 'body-balm'],
    catalog_category_path: 'beauty/bodycare/body-balm',
  },
  ext_0836525e72365da8ecbcc3b5: {
    product_type: 'Body Balm',
    category: 'Body Care',
    category_path: ['beauty', 'bodycare', 'body-balm'],
    catalog_category_path: 'beauty/bodycare/body-balm',
  },
  ext_edcf7e510314384ac432b385: {
    product_type: 'Body Balm',
    category: 'Body Care',
    category_path: ['beauty', 'bodycare', 'body-balm'],
    catalog_category_path: 'beauty/bodycare/body-balm',
  },
};

const HOLD_IDS = {
  ext_74a7dddbe9cfad5b36ea4bc1: 'missing_explicit_official_how_to',
  ext_cfdd4c8d3521fe733d0fc75d: 'missing_explicit_official_how_to',
};

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

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
    .replace(/&[a-z0-9#]+;/gi, ' ');
}

function cleanText(value) {
  return text(decodeHtml(value));
}

function sectionBetween(description, startPattern, endPattern) {
  const normalized = String(description || '').replace(/\r\n/g, '\n');
  const start = normalized.search(startPattern);
  if (start < 0) return '';
  const afterStart = normalized.slice(start).replace(startPattern, '');
  const end = afterStart.search(endPattern);
  const raw = end >= 0 ? afterStart.slice(0, end) : afterStart;
  return cleanText(raw);
}

function extractIngredients(description) {
  return sectionBetween(
    description,
    /(?:^|\n)\s*ingredients?\s*[:：]?\s*/i,
    /(?:^|\n)\s*(?:daily ritual|directions?|how to use|proudly made|cruelty free|no artificial)\b/i,
  );
}

function extractHowTo(description) {
  return sectionBetween(
    description,
    /(?:^|\n)\s*daily ritual\s*[:：]?\s*/i,
    /(?:^|\n)\s*(?:proudly made|cruelty free|no artificial|humanely sourced)\b/i,
  );
}

function splitIngredients(raw) {
  return cleanText(raw)
    .split(/\s*,\s*/)
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter((item) => item.length >= 2)
    .filter((item) => !/^ingredients?$/i.test(item));
}

function snapshotContract(sourceUrl) {
  return {
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'wave16_lucamar_official_shopify_us_catalog_recovery',
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
    source_origin: 'official_shopify_us_catalog_pdp',
    source_quality_status: 'high',
    source_url: sourceUrl,
    reviewed_by: 'codex_wave16_lucamar',
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

function publicDescription(row, ingredientsInci) {
  const preview = ingredientsInci.slice(0, 5).join(', ');
  const formulaSentence = preview ? ` The official ingredient section includes ${preview}.` : '';
  return (
    `${row.title} is a source-backed Lucamar body balm from the brand-owned US-localized Shopify product feed.` +
    `${formulaSentence} Price, availability, imagery, ingredient text, and Daily Ritual instructions are captured from the official source.`
  );
}

function buildReviewedItem(item) {
  const row = JSON.parse(JSON.stringify(asObject(item.seed_row)));
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const target = TARGETS[row.external_product_id];
  const canonicalUrl = row.canonical_url || row.destination_url;
  const sourceDescription = cleanText(seedData.description || snapshot.description);
  const ingredientsRaw = extractIngredients(seedData.description || snapshot.description);
  const howToUse = extractHowTo(seedData.description || snapshot.description);
  const ingredientsInci = splitIngredients(ingredientsRaw);
  const sourceContract = snapshotContract(canonicalUrl);
  const quality = qualitySummary(canonicalUrl);
  const description = publicDescription(row, ingredientsInci);
  const detailsSections = [
    {
      heading: 'How to Use',
      body: howToUse,
      source_kind: 'official_shopify_product_description_daily_ritual',
    },
    {
      heading: 'Ingredients',
      body: ingredientsRaw,
      source_kind: 'official_shopify_product_description_ingredients',
    },
  ];
  const variants = asArray(seedData.variants || snapshot.variants).map((variant) => ({
    ...variant,
    description,
    image_urls: asArray(variant.image_urls || seedData.image_urls || snapshot.image_urls),
    images: asArray(variant.images || variant.image_urls || seedData.images || snapshot.images),
  }));
  const ingredientIntel = {
    raw_ingredient_text_clean: ingredientsRaw,
    inci_raw: ingredientsRaw,
    inci_list: ingredientsInci,
    inci_normalized: ingredientsInci,
    source_kind: 'official_shopify_product_description_ingredients',
    source_url: canonicalUrl,
  };
  const nextSeedData = {
    ...seedData,
    brand: 'Lucamar Skin Care',
    title: row.title,
    description,
    pdp_description_raw: description,
    pdp_official_description_raw: sourceDescription,
    pdp_source_description_raw: sourceDescription,
    pdp_ingredients_raw: ingredientsRaw,
    raw_ingredient_text_clean: ingredientsRaw,
    ingredients_inci: ingredientsInci,
    inci_list: ingredientsInci,
    pdp_how_to_use_raw: howToUse,
    pdp_details_sections: detailsSections,
    ingredient_intel: ingredientIntel,
    category: target.category,
    category_path: target.category_path,
    catalog_category_path: target.catalog_category_path,
    product_kind: 'single_formula',
    product_type: target.product_type,
    variants,
    external_seed_snapshot_contract: sourceContract,
    pdp_field_quality_summary: quality,
    pdp_field_capture_status: {
      description_raw: sourceDescription ? 'captured' : 'missing',
      ingredients_raw: ingredientsRaw ? 'captured' : 'missing',
      how_to_use_raw: howToUse ? 'captured' : 'missing',
      details_sections: detailsSections.length ? 'captured' : 'missing',
    },
    authority_source: {
      ...asObject(seedData.authority_source || snapshot.authority_source),
      source_url: canonicalUrl,
      source_role: 'direct_official_pdp_catalog_extract',
      official_description_raw: sourceDescription,
      matched_preferred_titles: [row.title],
    },
    source_validation: {
      source_type: 'brand_owned',
      source_host: 'lucamarskincare.com',
      requires_multi_offer_merge_validation: false,
    },
    search_aliases: [row.title, `Lucamar ${row.title}`, `Lucamar Skin Care ${row.title}`],
  };

  nextSeedData.snapshot = {
    ...snapshot,
    ...Object.fromEntries(
      [
        'brand',
        'title',
        'description',
        'external_product_id',
        'canonical_url',
        'destination_url',
        'price_amount',
        'price_currency',
        'availability',
        'image_url',
        'image_urls',
        'images',
        'variants',
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
        'commerce_facts_v1',
        'commerce_facts_gate',
      ].map((key) => [key, nextSeedData[key]]),
    ),
    source: 'wave16_lucamar_official_shopify_us_catalog_seed_creation_manifest',
    extracted_at: GENERATED_AT,
  };

  row.seed_data = nextSeedData;
  const gate = validateCommerceFactsGateForSeedRow(row);
  row.seed_data.commerce_facts_gate = gate;
  row.seed_data.snapshot.commerce_facts_gate = gate;

  return {
    ingredient_id: null,
    ingredient_name: null,
    target_brand: 'Lucamar Skin Care',
    target_url: canonicalUrl,
    extract_status: 'official_shopify_us_catalog_recovered_ready',
    market: 'US',
    source_domain: 'https://lucamarskincare.com',
    source_role: 'direct_official_pdp_catalog_extract',
    matched_preferred_titles: [row.title],
    seed_row: row,
    curation_decision: {
      decision: 'db_ready_candidate',
      reason_codes: ['official_dtc_in_stock_usd_commerce_gate_pass', 'source_backed_ingredients_and_how_to'],
    },
  };
}

function auditItem(item) {
  const row = asObject(item.seed_row);
  const seedData = asObject(row.seed_data);
  const reasons = [];
  const warnings = [];
  if (!row.title) reasons.push('missing_title');
  if (!/^https:\/\/lucamarskincare\.com\/products\//i.test(row.canonical_url)) {
    reasons.push('canonical_url_not_official_pdp');
  }
  if (row.price_currency !== 'USD') reasons.push('price_not_usd');
  if (!(Number(row.price_amount) > 0 && Number(row.price_amount) < 250)) reasons.push('price_sanity_failed');
  if (row.availability !== 'in_stock') reasons.push('not_in_stock');
  if (!row.image_url && !asArray(seedData.image_urls).length) reasons.push('missing_image');
  if (text(seedData.pdp_source_description_raw).length < 300) reasons.push('missing_source_backed_description');
  if (text(seedData.pdp_ingredients_raw).length < 80 || asArray(seedData.ingredients_inci).length < 6) {
    reasons.push('missing_source_backed_ingredients');
  }
  if (text(seedData.pdp_how_to_use_raw).length < 20) reasons.push('missing_source_backed_how_to_use');
  if (seedData.commerce_facts_gate?.status === 'hold') {
    reasons.push(`commerce_gate_hold:${asArray(seedData.commerce_facts_gate.problems).join('|')}`);
  }
  if (/\b(?:eczema|psoriasis|anti-inflammatory|skin conditions?|studies have shown)\b/i.test(text(seedData.pdp_source_description_raw))) {
    warnings.push('therapeutic_claim_terms_absent_from_public_description_or_not_promoted');
  }
  return {
    external_product_id: row.external_product_id,
    title: row.title,
    target_url: row.canonical_url,
    price: row.price_amount,
    currency: row.price_currency,
    availability: row.availability,
    image_count: asArray(seedData.image_urls).length,
    source_description_length: text(seedData.pdp_source_description_raw).length,
    public_description_length: text(seedData.description).length,
    ingredients_raw_length: text(seedData.pdp_ingredients_raw).length,
    ingredients_count: asArray(seedData.ingredients_inci).length,
    how_to_use_length: text(seedData.pdp_how_to_use_raw).length,
    commerce_gate: seedData.commerce_facts_gate,
    category_path: seedData.catalog_category_path,
    status: reasons.length ? 'hold' : 'ready',
    reasons,
    warnings,
  };
}

function main() {
  const sourceDoc = JSON.parse(fs.readFileSync(SOURCE_MANIFEST, 'utf8'));
  const sourceItems = asArray(sourceDoc.items);
  const readyItems = sourceItems
    .filter((item) => TARGETS[item?.seed_row?.external_product_id])
    .map(buildReviewedItem);
  const auditRows = readyItems.map(auditItem);
  const finalItems = readyItems.filter((item, idx) => auditRows[idx].status === 'ready');
  const heldFromReady = auditRows.filter((row) => row.status !== 'ready');
  const explicitHolds = sourceItems
    .filter((item) => HOLD_IDS[item?.seed_row?.external_product_id])
    .map((item) => ({
      external_product_id: item.seed_row.external_product_id,
      title: item.seed_row.title,
      target_url: item.seed_row.canonical_url,
      status: 'hold',
      reasons: [HOLD_IDS[item.seed_row.external_product_id]],
    }));
  const manifest = {
    generated_at: GENERATED_AT,
    market: 'US',
    source: 'wave16_lucamar_official_shopify_us_catalog_recovery',
    source_manifest_path: SOURCE_MANIFEST,
    curation_policy:
      'Lucamar official Shopify US-market catalog extract; promote only Baa Ram Ewe body balm PDPs with USD, in-stock commerce facts, official Ingredients, and explicit Daily Ritual how-to. Hold lip balm rows without explicit how-to and avoid new copy/therapeutic-risk rows.',
    item_count: finalItems.length,
    held_item_count: heldFromReady.length + explicitHolds.length,
    held_items: [...heldFromReady, ...explicitHolds],
    items: finalItems,
  };
  const audit = {
    generated_at: GENERATED_AT,
    market: 'US',
    source: manifest.source,
    scanned: readyItems.length + explicitHolds.length,
    ready_count: finalItems.length,
    held_count: heldFromReady.length + explicitHolds.length,
    audit_rows: [...auditRows, ...explicitHolds],
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
        ready_titles: finalItems.map((item) => item.seed_row.title),
        held_reasons: audit.held_items || audit.audit_rows.filter((row) => row.status === 'hold'),
      },
      null,
      2,
    )}\n`,
  );
}

main();
