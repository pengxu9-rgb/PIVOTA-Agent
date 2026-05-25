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
  'reports/markato_expansion_status_20260524/wave13_direct_pdp_recovery_20260525',
);
const ACCEPTED_DIR = path.join(REPORT_DIR, 'accepted_manifests');
const GENERATED_AT = new Date().toISOString();

const TARGETS = [
  {
    file: 'masami-shampoo.json',
    url: 'https://lovemasami.com/products/mekabu-shampoo',
    title: 'Mekabu Hydrating Shampoo',
    product_type: 'Shampoo',
    category: 'Haircare',
    category_path: ['beauty', 'haircare', 'shampoo'],
    catalog_category_path: 'beauty/haircare/shampoo',
  },
  {
    file: 'masami-conditioner.json',
    url: 'https://lovemasami.com/products/mekabu-conditioner',
    title: 'Mekabu Hydrating Conditioner',
    product_type: 'Conditioner',
    category: 'Haircare',
    category_path: ['beauty', 'haircare', 'conditioner'],
    catalog_category_path: 'beauty/haircare/conditioner',
  },
  {
    file: 'masami-serum.json',
    url: 'https://lovemasami.com/products/mekabu-serum',
    title: 'Mekabu Hydrating Shine Serum',
    product_type: 'Hair Serum',
    category: 'Haircare',
    category_path: ['beauty', 'haircare', 'serum'],
    catalog_category_path: 'beauty/haircare/hair-serum',
  },
  {
    file: 'masami-cream.json',
    url: 'https://lovemasami.com/products/mekabu-cream',
    title: 'Mekabu Hydrating Styling Cream',
    product_type: 'Styling Cream',
    category: 'Haircare',
    category_path: ['beauty', 'haircare', 'styling'],
    catalog_category_path: 'beauty/haircare/styling-cream',
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

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function cleanHtml(value, { commaBreaks = false } = {}) {
  const breakToken = commaBreaks ? ', ' : '\n';
  return decodeHtml(
    String(value || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, breakToken)
      .replace(/<\/p>\s*<p[^>]*>/gi, breakToken)
      .replace(/<\/?[^>]+>/g, ' '),
  )
    .replace(/\s*,\s*,+/g, ', ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*([.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeIngredientText(value) {
  return cleanHtml(value, { commaBreaks: true })
    .replace(/\bINGREDIENTS\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/,\s*$/, '')
    .trim();
}

function splitInci(raw) {
  return normalizeIngredientText(raw)
    .split(/\s*,\s*/)
    .map((item) => item.trim())
    .filter((item) => item.length > 1)
    .filter((item) => !/^(?:and|or|ingredients?|inci|list)$/i.test(item));
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: 25000,
        headers: {
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
          accept: 'text/html,application/xhtml+xml',
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          fetchHtml(next).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
          }
          resolve(body);
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`timeout fetching ${url}`));
    });
    req.on('error', reject);
  });
}

function extractAccordionBody(html, heading) {
  const upperHeading = heading.toUpperCase();
  const headingIndex = html.toUpperCase().indexOf(upperHeading);
  if (headingIndex === -1) return '';
  const bodyIndex = html.indexOf('data-accordion-body', headingIndex);
  if (bodyIndex === -1) return '';
  const divStart = html.lastIndexOf('<div', bodyIndex);
  if (divStart === -1) return '';
  const nextWrapper = html.indexOf('<div class="accordion__wrapper"', bodyIndex + 1);
  const divEnd = nextWrapper === -1 ? html.indexOf('</div>', bodyIndex) + '</div>'.length : nextWrapper;
  if (divEnd <= divStart) return '';
  return html.slice(divStart, divEnd);
}

function extractOfficialFields(html) {
  const ingredients = normalizeIngredientText(extractAccordionBody(html, 'INGREDIENTS'));
  const howToUse = multiline(cleanHtml(extractAccordionBody(html, 'HOW TO USE')));
  return {
    ingredients,
    inci_list: splitInci(ingredients),
    how_to_use: howToUse,
  };
}

function readAcceptedManifest(file) {
  return JSON.parse(fs.readFileSync(path.join(ACCEPTED_DIR, file), 'utf8'));
}

function normalizeUrl(value) {
  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    return text(value).replace(/\/$/, '');
  }
}

function sameUrl(a, b) {
  return normalizeUrl(a) === normalizeUrl(b);
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function firstItem(manifest) {
  return asObject(asArray(manifest.items)[0]);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyPriceNormalization(row, target) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const commerceFacts = asObject(seedData.commerce_facts_v1);
  const regionalPrice = asObject(commerceFacts.regional_price);
  const gate = asObject(seedData.commerce_facts_gate);
  const gateProblems = asArray(gate.problems).map(text).filter(Boolean);
  const canNormalize =
    regionalPrice.currency === 'USD' &&
    Number(regionalPrice.amount) > 0 &&
    regionalPrice.market_switch_status === 'ok' &&
    sameUrl(regionalPrice.source_url || commerceFacts.evidence_url, target.url) &&
    gateProblems.every((problem) => problem === 'market_currency_mismatch');

  if (!canNormalize) {
    return {
      ok: row.price_currency === 'USD',
      normalized: false,
      reason: row.price_currency === 'USD' ? null : 'no_source_backed_usd_price',
    };
  }

  const previous = {
    price_amount: row.price_amount,
    price_currency: row.price_currency,
  };
  row.price_amount = Number(regionalPrice.amount);
  row.price_currency = 'USD';
  seedData.price_amount = row.price_amount;
  seedData.price_currency = 'USD';
  snapshot.price_amount = row.price_amount;
  snapshot.price_currency = 'USD';
  for (const variant of asArray(seedData.variants)) {
    variant.price = String(regionalPrice.display_raw || row.price_amount);
    variant.currency = 'USD';
  }
  for (const variant of asArray(snapshot.variants)) {
    variant.price = String(regionalPrice.display_raw || row.price_amount);
    variant.currency = 'USD';
  }
  seedData.wave13_reviewed_price_normalization = {
    source: 'commerce_facts_v1.regional_price',
    previous,
    next: {
      price_amount: row.price_amount,
      price_currency: 'USD',
    },
    evidence_url: regionalPrice.source_url || commerceFacts.evidence_url || target.url,
    reviewed_at: GENERATED_AT,
  };
  snapshot.wave13_reviewed_price_normalization = seedData.wave13_reviewed_price_normalization;
  const nextGate = validateCommerceFactsGateForSeedRow(row);
  seedData.commerce_facts_gate = nextGate;
  snapshot.commerce_facts_gate = nextGate;
  return {
    ok: nextGate.status !== 'hold',
    normalized: true,
    reason: nextGate.status === 'hold' ? asArray(nextGate.problems).join('|') : null,
  };
}

function attachOfficialPdpFields(row, target, officialFields) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const quality = {
    ...asObject(seedData.pdp_field_quality_summary),
    ingredients_raw: {
      source_origin: 'official_html',
      source_quality_status: 'high',
      source_url: target.url,
      reviewed_by: 'codex_wave13_masami',
      reviewed_at: GENERATED_AT,
    },
    how_to_use_raw: {
      source_origin: 'official_html',
      source_quality_status: 'high',
      source_url: target.url,
      reviewed_by: 'codex_wave13_masami',
      reviewed_at: GENERATED_AT,
    },
    details_sections: {
      source_origin: 'official_html',
      source_quality_status: 'high',
      source_url: target.url,
      reviewed_by: 'codex_wave13_masami',
      reviewed_at: GENERATED_AT,
    },
  };
  const detailsSections = [
    {
      heading: 'Ingredients',
      body: officialFields.ingredients,
      source_kind: 'official_html',
    },
    {
      heading: 'How to use',
      body: officialFields.how_to_use,
      source_kind: 'official_html',
    },
  ];

  seedData.catalog_category_path = target.catalog_category_path;
  seedData.category = target.category;
  seedData.category_path = target.category_path;
  seedData.product_kind = 'single_formula';
  seedData.product_type = target.product_type;
  seedData.pdp_ingredients_raw = officialFields.ingredients;
  seedData.raw_ingredient_text_clean = officialFields.ingredients;
  seedData.ingredients_inci = officialFields.inci_list;
  seedData.inci_list = officialFields.inci_list;
  seedData.pdp_how_to_use_raw = officialFields.how_to_use;
  seedData.pdp_details_sections = detailsSections;
  seedData.pdp_field_quality_summary = quality;
  seedData.pdp_field_capture_status = {
    ingredients_raw: 'captured',
    how_to_use_raw: 'captured',
    details_sections: 'captured',
  };

  Object.assign(snapshot, {
    catalog_category_path: target.catalog_category_path,
    category: target.category,
    category_path: target.category_path,
    product_kind: 'single_formula',
    product_type: target.product_type,
    pdp_ingredients_raw: officialFields.ingredients,
    raw_ingredient_text_clean: officialFields.ingredients,
    ingredients_inci: officialFields.inci_list,
    inci_list: officialFields.inci_list,
    pdp_how_to_use_raw: officialFields.how_to_use,
    pdp_details_sections: detailsSections,
    pdp_field_quality_summary: quality,
    pdp_field_capture_status: seedData.pdp_field_capture_status,
  });
}

function auditCandidate(target, row, officialFields, priceResult) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const diagnostics = asObject(snapshot.diagnostics);
  const sourceValidation = asObject(seedData.source_validation);
  const commerceGate = asObject(seedData.commerce_facts_gate);
  const reasons = [];
  if (!sameUrl(row.canonical_url, target.url)) reasons.push('canonical_url_mismatch');
  if (text(row.brand).toLowerCase() !== 'masami') reasons.push('brand_mismatch');
  if (row.market !== 'US') reasons.push('market_not_us');
  if (row.price_currency !== 'USD') reasons.push('price_not_usd');
  if (commerceGate.status === 'hold') reasons.push(`commerce_gate_hold:${asArray(commerceGate.problems).join('|')}`);
  if (row.availability !== 'in_stock') reasons.push('not_in_stock');
  if (text(diagnostics.block_provider)) reasons.push(`block_provider:${text(diagnostics.block_provider)}`);
  if (text(diagnostics.failure_category)) reasons.push(`failure_category:${text(diagnostics.failure_category)}`);
  if (sourceValidation.requires_multi_offer_merge_validation) reasons.push('requires_multi_offer_merge_validation');
  if (officialFields.inci_list.length < 5) reasons.push('missing_source_backed_full_inci');
  if (officialFields.how_to_use.length < 40) reasons.push('missing_source_backed_how_to');
  if (!asArray(seedData.authority_source?.matched_preferred_titles).length) {
    reasons.push('missing_preferred_title_match');
  }
  if (!priceResult.ok) reasons.push(priceResult.reason || 'price_normalization_failed');
  return {
    file: target.file,
    target_url: target.url,
    canonical_url: row.canonical_url,
    title: row.title,
    price: row.price_amount,
    currency: row.price_currency,
    availability: row.availability,
    ingredients_count: officialFields.inci_list.length,
    ingredients_raw_len: officialFields.ingredients.length,
    how_to_len: officialFields.how_to_use.length,
    price_normalized: priceResult.normalized,
    commerce_gate: commerceGate,
    diagnostics,
    status: reasons.length ? 'hold' : 'ready',
    reasons,
  };
}

async function main() {
  const items = [];
  const auditRows = [];
  const heldItems = [];

  for (const target of TARGETS) {
    const manifest = readAcceptedManifest(target.file);
    const sourceItem = firstItem(manifest);
    const row = clone(asObject(sourceItem.seed_row));
    const canonicalUrl = row.canonical_url || target.url;
    row.seed_id = stableSeedId(canonicalUrl);
    row.external_product_id = stableExternalProductId(canonicalUrl);
    row.domain = hostFromUrl(canonicalUrl) || 'lovemasami.com';
    row.title = target.title;
    row.seed_data = {
      ...asObject(row.seed_data),
      title: target.title,
      external_product_id: row.external_product_id,
      canonical_url: canonicalUrl,
      destination_url: row.destination_url || canonicalUrl,
    };
    row.seed_data.snapshot = {
      ...asObject(row.seed_data.snapshot),
      title: target.title,
      external_product_id: row.external_product_id,
      canonical_url: canonicalUrl,
      destination_url: row.destination_url || canonicalUrl,
    };

    const html = await fetchHtml(target.url);
    const officialFields = extractOfficialFields(html);
    attachOfficialPdpFields(row, target, officialFields);
    const priceResult = applyPriceNormalization(row, target);
    const audit = auditCandidate(target, row, officialFields, priceResult);
    auditRows.push(audit);
    if (audit.status !== 'ready') {
      heldItems.push(audit);
      continue;
    }
    items.push({
      ingredient_id: null,
      ingredient_name: null,
      target_brand: 'MASAMI',
      target_url: target.url,
      extract_status: 'direct_pdp_recovered_ready_official_html',
      market: 'US',
      source_domain: 'https://lovemasami.com',
      source_role: 'direct_official_pdp',
      matched_preferred_titles: [target.title],
      seed_row: row,
    });
  }

  const manifest = {
    generated_at: GENERATED_AT,
    market: 'US',
    source: 'wave13_masami_direct_pdp_official_html_recovery',
    curation_policy:
      'MASAMI single PDPs only: direct official PDP, clean structural review, USD regional price from commerce_facts_v1, in-stock, source-backed official HTML INCI and how-to.',
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

  const manifestPath = path.join(REPORT_DIR, 'masami_candidate_manifest.json');
  const dbReadyPath = path.join(REPORT_DIR, 'db_ready_candidate_manifest.json');
  const auditPath = path.join(REPORT_DIR, 'masami_official_html_extract_audit.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(dbReadyPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        candidate_manifest: manifestPath,
        db_ready_candidate_manifest: dbReadyPath,
        extract_audit: auditPath,
        item_count: manifest.item_count,
        held_item_count: manifest.held_item_count,
        ready_titles: items.map((item) => item.seed_row.title),
        held_reasons: heldItems.map((item) => ({ title: item.title, reasons: item.reasons })),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
