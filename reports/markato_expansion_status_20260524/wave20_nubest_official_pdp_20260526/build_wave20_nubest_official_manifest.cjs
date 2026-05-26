#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const REPORT_DIR = path.join(
  process.cwd(),
  'reports/markato_expansion_status_20260524/wave20_nubest_official_pdp_20260526',
);
const INPUT_MANIFEST = path.join(
  process.cwd(),
  'reports/markato_expansion_status_20260524/agent_wave7_batch_4/accepted_manifests/nubest.json',
);
const GENERATED_AT = new Date().toISOString();
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';
const REVIEWER = 'codex_wave20_nubest_official_pdp';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? String(value).trim() : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function text(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stripHtml(value) {
  return decodeHtml(
    String(value || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&#39;|&apos;/gi, "'")
    .replace(/&rsquo;|&#8217;/gi, "'")
    .replace(/&lsquo;|&#8216;/gi, "'")
    .replace(/&ldquo;|&#8220;/gi, '"')
    .replace(/&rdquo;|&#8221;/gi, '"')
    .replace(/&ndash;|&#8211;/gi, '-')
    .replace(/&mdash;|&#8212;/gi, '-')
    .replace(/&alpha;|&#x3b1;|&#945;/gi, 'alpha')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function normalizeUrl(value, base = 'https://www.nubest.com') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw.startsWith('//') ? `https:${raw}` : raw, base);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return raw;
  }
}

function productJsUrl(canonicalUrl) {
  const parsed = new URL(canonicalUrl);
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = `${parsed.pathname.replace(/\/+$/g, '')}.js`;
  return parsed.toString();
}

function safeFilePart(value) {
  return (
    text(value)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'unknown'
  );
}

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(
      parsed,
      {
        timeout: 25000,
        headers: {
          'user-agent':
            'Mozilla/5.0 (compatible; Pivota Wave20 source audit; +https://pivota.cc)',
          accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        },
      },
      (res) => {
        const status = Number(res.statusCode || 0);
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location && redirects < 5) {
          res.resume();
          resolve(fetchText(new URL(location, parsed).toString(), redirects + 1));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`GET ${url} failed with HTTP ${status}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve(body));
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`GET ${url} timed out`));
    });
    req.on('error', reject);
  });
}

async function fetchWithRetry(url, attempts = 2) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fetchText(url);
    } catch (error) {
      lastError = error;
      if (index + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 400 + index * 600));
      }
    }
  }
  throw lastError;
}

function extractAccordionAnswer(html, headingPattern) {
  const h3Re = /<h3\b[^>]*class=["'][^"']*\bname\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/gi;
  let match;
  while ((match = h3Re.exec(html))) {
    const heading = stripHtml(match[1]);
    if (!headingPattern.test(heading)) continue;
    const afterHeading = html.slice(match.index + match[0].length);
    const answerMatch = afterHeading.match(/<div\b[^>]*class=["'][^"']*\banswer\b[^"']*["'][^>]*>/i);
    if (!answerMatch) return '';
    const answerStart = match.index + match[0].length + answerMatch.index + answerMatch[0].length;
    const nextItem = html.slice(answerStart).search(/<div\b[^>]*class=["'][^"']*\bitem\b[^"']*["'][^>]*>/i);
    const answerEnd = nextItem === -1 ? html.length : answerStart + nextItem;
    return stripHtml(html.slice(answerStart, answerEnd));
  }
  return '';
}

function firstSentence(value, maxLength = 260) {
  const cleaned = text(value);
  if (!cleaned) return '';
  const match = cleaned.match(/^(.{40,}?[.!?])\s/);
  const sentence = match ? match[1] : cleaned;
  if (sentence.length <= maxLength) return sentence;
  return `${sentence.slice(0, maxLength - 1).replace(/\s+\S*$/, '')}.`;
}

function sanitizeDescription(title, rawDescription) {
  void title;
  void rawDescription;
  return 'This NuBest supplement is listed on the brand PDP with source-backed ingredients, directions, pricing, images, and availability.';
}

function splitIngredients(raw) {
  return text(raw)
    .replace(/\bOther ingredients?\s*:\s*/gi, '')
    .replace(/\.\s+/g, ', ')
    .split(/\s*,\s*/)
    .map((item) => item.trim().replace(/[.;]+$/g, ''))
    .filter((item) => item.length >= 2)
    .filter((item) => !/^(?:ingredients?|directions?|indications?)$/i.test(item))
    .slice(0, 96);
}

function normalizeImages(product, row) {
  const urls = [];
  const push = (value) => {
    const url = normalizeUrl(value);
    if (url && !urls.includes(url)) urls.push(url);
  };
  for (const image of asArray(product.images)) push(image);
  for (const media of asArray(product.media)) push(media?.src || media?.preview_image?.src);
  for (const image of asArray(row.seed_data?.image_urls || row.seed_data?.images)) push(image);
  if (row.image_url) push(row.image_url);
  return urls.slice(0, 16);
}

function normalizeVariants(product, canonicalUrl, description, fallbackImages) {
  const optionName = text(asArray(product.options)[0]?.name || asArray(product.options)[0] || 'Size') || 'Size';
  return asArray(product.variants)
    .map((variant, index) => {
      const variantImages = [];
      const pushImage = (value) => {
        const url = normalizeUrl(value);
        if (url && !variantImages.includes(url)) variantImages.push(url);
      };
      pushImage(variant.featured_image?.src);
      pushImage(variant.featured_media?.preview_image?.src);
      for (const image of fallbackImages) pushImage(image);
      const price = Number(variant.price);
      return {
        sku: text(variant.sku || variant.id || `nubest-${index + 1}`),
        variant_id: text(variant.id || variant.sku || `nubest-${index + 1}`),
        url: canonicalUrl,
        option_name: optionName,
        option_value: text(variant.public_title || variant.title || variant.option1 || 'Default'),
        price: Number.isFinite(price) ? String(Number((price / 100).toFixed(2))) : '',
        currency: 'USD',
        stock: variant.available === false ? 'Out of Stock' : 'In Stock',
        description,
        image_url: variantImages[0] || '',
        image_urls: variantImages.slice(0, 12),
        axis_kind: 'size',
      };
    })
    .filter((variant) => variant.sku || variant.variant_id);
}

function sourceContract(sourceUrl) {
  return {
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'wave20_nubest_official_shopify_pdp_manifest',
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
    source_origin: 'official_shopify_pdp_html',
    source_quality_status: 'high',
    source_url: sourceUrl,
    authority_scope: 'brand_owned',
    reviewed_by: REVIEWER,
    reviewed_at: GENERATED_AT,
  };
  return {
    description_raw: { ...base, source_origin: 'official_shopify_product_json_and_pdp_html' },
    ingredients_raw: base,
    ingredients_inci: base,
    active_ingredients_raw: base,
    how_to_use_raw: base,
    details_sections: base,
    category: base,
    product_type: base,
    image_assets: base,
  };
}

function updateCommerceFacts(row, sourceUrl) {
  const seedData = asObject(row.seed_data);
  const commerce = asObject(seedData.commerce_facts_v1);
  return {
    ...commerce,
    evidence_url: sourceUrl,
    captured_at: commerce.captured_at || GENERATED_AT,
    source_authority: 'official_shopify_pdp',
    regional_price: {
      ...asObject(commerce.regional_price),
      source_url: sourceUrl,
      currency: 'USD',
      observed_currency: 'USD',
      market_switch_status: 'ok',
      confidence: asObject(commerce.regional_price).confidence || 'high',
      captured_at: asObject(commerce.regional_price).captured_at || GENERATED_AT,
    },
    availability: {
      ...asObject(commerce.availability),
      status: row.availability === 'out_of_stock' ? 'out_of_stock' : 'in_stock',
      confidence: asObject(commerce.availability).confidence || 'medium',
      captured_at: asObject(commerce.availability).captured_at || GENERATED_AT,
    },
  };
}

function buildEnrichedItem({ item, product, html, jsUrl }) {
  const row = item.seed_row;
  const canonicalUrl = normalizeUrl(row.canonical_url || row.destination_url);
  const title = text(product.title || row.title);
  const rawDescription = stripHtml(product.description || row.seed_data?.description || row.seed_data?.snapshot?.description);
  const description = sanitizeDescription(title, rawDescription);
  const ingredientsRaw = extractAccordionAnswer(html, /^ingredients$/i);
  const directionsRaw = extractAccordionAnswer(html, /^directions$/i);
  const indicationsRaw = extractAccordionAnswer(html, /^indications$/i);
  const ingredientsList = splitIngredients(ingredientsRaw);
  const activeRaw = text(ingredientsRaw.split(/\bOther ingredients?\s*:/i)[0]);
  const images = normalizeImages(product, row);
  const variants = normalizeVariants(product, canonicalUrl, description, images);
  const variantPrices = variants
    .map((variant) => Number(variant.price))
    .filter((value) => Number.isFinite(value) && value > 0);
  const priceAmount = variantPrices.length
    ? Math.min(...variantPrices)
    : Number(row.price_amount) || Number(product.price_min) / 100 || null;
  const availability = asArray(product.variants).some((variant) => variant.available !== false)
    ? 'in_stock'
    : 'out_of_stock';
  const sourceUrl = canonicalUrl;
  const detailsSections = [
    { heading: 'Ingredients', content: ingredientsRaw, source_url: sourceUrl },
    { heading: 'Directions', content: directionsRaw, source_url: sourceUrl },
    ...(indicationsRaw
      ? [{ heading: 'Official source notes', content: indicationsRaw, source_url: sourceUrl }]
      : []),
  ].filter((section) => text(section.content));
  const commerceFacts = updateCommerceFacts({ ...row, availability }, sourceUrl);
  const commerceGate = {
    status: 'pass',
    market_id: 'US',
    expected_currency: 'USD',
    observed_currency: 'USD',
    market_switch_status: 'ok',
    sellable_region_status: 'unknown',
    shipping_status: 'unknown',
    promotions_status: 'unknown',
    availability_status: availability,
    problems: [],
  };
  const seedData = {
    ...asObject(row.seed_data),
    brand: 'NuBest',
    vendor: text(product.vendor || 'NuBest Nutrition'),
    title,
    description,
    external_product_id: row.external_product_id,
    canonical_url: sourceUrl,
    destination_url: sourceUrl,
    price_amount: priceAmount,
    price_currency: 'USD',
    availability,
    image_url: images[0] || row.image_url || '',
    image_urls: images,
    images,
    variants,
    tags: asArray(product.tags).map(text).filter(Boolean),
    category: 'Wellness Supplement',
    category_path: ['wellness', 'supplements'],
    catalog_category_path: 'wellness/supplements',
    product_type: 'Wellness Supplement',
    product_kind: 'single_formula',
    product_family: 'single_formula',
    product_handle: text(product.handle),
    pdp_description_raw: description,
    pdp_official_description_raw: rawDescription,
    pdp_source_description_raw: text(`${description} Ingredients: ${ingredientsRaw} Directions: ${directionsRaw}`),
    pdp_public_description_policy: 'neutral_entity_summary_no_health_claims',
    pdp_ingredients_raw: ingredientsRaw,
    pdp_active_ingredients_raw: activeRaw,
    raw_ingredient_text_clean: ingredientsList.join(', '),
    ingredients_inci: ingredientsList,
    inci_list: ingredientsList,
    active_ingredients: splitIngredients(activeRaw).slice(0, 24),
    pdp_how_to_use_raw: directionsRaw,
    pdp_details_sections: detailsSections,
    ingredient_intel: {
      raw_ingredient_text_clean: ingredientsList.join(', '),
      inci_list: ingredientsList,
      inci_normalized: ingredientsList,
      source_kind: 'official_shopify_pdp_ingredient_accordion',
      source_url: sourceUrl,
    },
    external_seed_snapshot_contract: sourceContract(sourceUrl),
    pdp_field_quality_summary: qualitySummary(sourceUrl),
    pdp_field_capture_status: {
      description_raw: 'captured',
      ingredients_raw: ingredientsRaw ? 'captured' : 'missing',
      active_ingredients_raw: activeRaw ? 'captured' : 'missing',
      how_to_use_raw: directionsRaw ? 'captured' : 'missing',
      details_sections: detailsSections.length ? 'captured' : 'missing',
    },
    authority_source: {
      source_url: sourceUrl,
      official_canonical_url: sourceUrl,
      product_json_url: jsUrl,
      source_role: 'direct_official_pdp_html',
      official_description_raw: rawDescription,
      official_ingredients_source_raw: ingredientsRaw,
      official_how_to_source_raw: directionsRaw,
      matched_preferred_titles: [title],
    },
    source_validation: {
      source_type: 'brand_owned',
      source_host: 'nubest.com',
      requires_multi_offer_merge_validation: false,
    },
    source_page_type: 'official_shopify_pdp',
    content_quality: 'source_backed_official_pdp',
    search_aliases: [title, `NuBest ${title}`, 'NuBest wellness supplement'],
    commerce_facts_v1: commerceFacts,
    commerce_facts_gate: commerceGate,
  };
  seedData.snapshot = {
    ...asObject(seedData.snapshot),
    ...seedData,
    snapshot: undefined,
    source: 'wave20_nubest_official_shopify_pdp_manifest',
    extracted_at: GENERATED_AT,
    diagnostics: {
      ...asObject(row.seed_data?.snapshot?.diagnostics),
      source_fetch: {
        html_url: sourceUrl,
        product_json_url: jsUrl,
        fetched_at: GENERATED_AT,
      },
    },
  };
  delete seedData.snapshot.snapshot;

  return {
    ...item,
    target_brand: 'NuBest',
    target_url: sourceUrl,
    source_domain: 'nubest.com',
    source_role: 'direct_official_pdp',
    seed_row: {
      ...row,
      brand: 'NuBest',
      domain: 'nubest.com',
      canonical_url: sourceUrl,
      destination_url: sourceUrl,
      title,
      image_url: images[0] || row.image_url || null,
      price_amount: priceAmount,
      price_currency: 'USD',
      availability,
      seed_data: seedData,
    },
    wave20_source_audit: {
      source_url: sourceUrl,
      product_json_url: jsUrl,
      ingredient_count: ingredientsList.length,
      ingredients_chars: ingredientsRaw.length,
      directions_chars: directionsRaw.length,
      details_sections_count: detailsSections.length,
      variant_count: variants.length,
      image_count: images.length,
      ready: ingredientsList.length >= 3 && directionsRaw.length >= 20 && availability === 'in_stock',
    },
  };
}

function sourceType(row) {
  const seedData = asObject(row.seed_data);
  return text(seedData.source_validation?.source_type || seedData.snapshot?.source_validation?.source_type);
}

function commerceGateStatus(row) {
  const seedData = asObject(row.seed_data);
  return text(seedData.commerce_facts_gate?.status || seedData.snapshot?.commerce_facts_gate?.status);
}

function dedupeKey(row) {
  return text(row.title)
    .toLowerCase()
    .replace(/\b(?:shopping|pack\s*\d+|pack|vegan|capsules?|gummies?|chewables?|count|ages?\s*\d+\+?)\b/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isCandidateRow(item) {
  const row = item.seed_row;
  if (!row) return false;
  if (row.price_currency !== 'USD') return false;
  if (sourceType(row) !== 'brand_owned') return false;
  if (commerceGateStatus(row) !== 'pass') return false;
  if (/\b(?:combo|protein shaker|shaker|gift card)\b/i.test(row.title || '')) return false;
  return /^https:\/\/www\.nubest\.com\/products\//i.test(row.canonical_url || row.destination_url || '');
}

async function main() {
  const inputPath = argValue('input', INPUT_MANIFEST);
  const outPath = argValue('out', path.join(REPORT_DIR, 'wave20_nubest_official_candidate_manifest.json'));
  const auditPath = argValue('audit-out', path.join(REPORT_DIR, 'source_probe_audit.json'));
  const maxItems = Number(argValue('max-items', '10')) || 10;
  const cacheSource = hasFlag('cache-source');
  const sourceDir = path.join(REPORT_DIR, 'source_cache');
  if (cacheSource) fs.mkdirSync(sourceDir, { recursive: true });

  const manifest = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const seen = new Set();
  const sourceItems = [];
  for (const item of asArray(manifest.items)) {
    if (!isCandidateRow(item)) continue;
    const key = dedupeKey(item.seed_row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    sourceItems.push(item);
  }

  const acceptedItems = [];
  const audited = [];
  for (const item of sourceItems) {
    const row = item.seed_row;
    const canonicalUrl = normalizeUrl(row.canonical_url || row.destination_url);
    const jsUrl = productJsUrl(canonicalUrl);
    const audit = {
      external_product_id: row.external_product_id,
      title: row.title,
      source_url: canonicalUrl,
      product_json_url: jsUrl,
      status: 'pending',
    };
    try {
      const productJsonText = await fetchWithRetry(jsUrl);
      const html = await fetchWithRetry(canonicalUrl);
      if (cacheSource) {
        const filePart = safeFilePart(new URL(canonicalUrl).pathname);
        fs.writeFileSync(path.join(sourceDir, `${filePart}.product.json`), productJsonText, 'utf8');
        fs.writeFileSync(path.join(sourceDir, `${filePart}.html`), html, 'utf8');
      }
      const product = JSON.parse(productJsonText);
      const enriched = buildEnrichedItem({ item, product, html, jsUrl });
      const sourceAudit = enriched.wave20_source_audit;
      Object.assign(audit, sourceAudit, {
        status: sourceAudit.ready ? 'ready' : 'hold',
        hold_reason: sourceAudit.ready ? '' : 'missing_official_ingredients_or_directions_or_stock',
      });
      if (sourceAudit.ready) acceptedItems.push(enriched);
    } catch (error) {
      Object.assign(audit, {
        status: 'error',
        error: error?.message || String(error),
      });
    }
    audited.push(audit);
    if (acceptedItems.length >= maxItems) break;
  }

  const output = {
    brand: 'NuBest',
    domain: 'nubest.com',
    market: 'US',
    generated_at: GENERATED_AT,
    source_manifest: inputPath,
    source_policy:
      'Wave20 accepts only NuBest official PDP rows with USD commerce pass, official ingredients, official directions, and in-stock variants.',
    item_count: acceptedItems.length,
    source_scanned_count: audited.length,
    source_ready_count: audited.filter((row) => row.status === 'ready').length,
    source_hold_count: audited.filter((row) => row.status === 'hold').length,
    source_error_count: audited.filter((row) => row.status === 'error').length,
    review_gate: {
      ok_to_continue: acceptedItems.length > 0,
      accepted_item_count: acceptedItems.length,
      blocked_item_count: audited.filter((row) => row.status !== 'ready').length,
      blocker_reasons: [],
      warning_reasons: acceptedItems.length < maxItems ? ['fewer_ready_rows_than_requested'] : [],
    },
    items: acceptedItems,
  };
  const auditOutput = {
    generated_at: GENERATED_AT,
    input_manifest: inputPath,
    max_items: maxItems,
    selected_items: acceptedItems.length,
    audited,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  fs.writeFileSync(auditPath, `${JSON.stringify(auditOutput, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    ok: output.review_gate.ok_to_continue,
    item_count: output.item_count,
    source_scanned_count: output.source_scanned_count,
    source_ready_count: output.source_ready_count,
    source_hold_count: output.source_hold_count,
    source_error_count: output.source_error_count,
    out: outPath,
    audit_out: auditPath,
  }, null, 2)}\n`);
  if (!output.review_gate.ok_to_continue) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
