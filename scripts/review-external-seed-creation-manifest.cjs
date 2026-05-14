#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BLOCKING_DIAGNOSTIC_RE =
  /\b(?:captcha|challenge|bot|blocked|forbidden|access[_ -]?denied|login|auth|paywall|anti[_ -]?abuse|rate[_ -]?limit)\b/i;
const DEFAULT_NON_PRODUCT_RE =
  /\b(?:donat(?:e|ion)|charity|gift cards?|e-?gift cards?|shipping protection|package protection|warranty|sleep shorts?|shorts?|t-?shirts?|sweatshirts?|hoodies?|hats?|caps?|totes?|key\s*chains?|stickers?|pins?|blankets?|pillowcases?|scrunchies?|lockets?|necklaces?|bracelets?|earrings?)\b/i;
const DEFAULT_PAGE_POLLUTION_RE =
  /\b(?:privacy policy|terms(?: of (?:use|service))?|customer service|customer support|shipping policy|return policy|store locator|careers|about us|blog|faq)\b/i;

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeString(value) {
  return String(value || '').trim();
}

function resolvePathMaybeRelative(value) {
  const text = normalizeString(value);
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.join(process.cwd(), text);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join('|') : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows, columns) {
  return `${[
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')),
  ].join('\n')}\n`;
}

function buildExtraExcludeRe(raw) {
  const text = normalizeString(raw);
  if (!text) return null;
  return new RegExp(text, 'i');
}

function itemSeedRow(item) {
  return asObject(item && item.seed_row);
}

function itemSnapshot(item) {
  return asObject(asObject(itemSeedRow(item).seed_data).snapshot);
}

function itemTitle(item) {
  const row = itemSeedRow(item);
  const snapshot = itemSnapshot(item);
  return normalizeString(row.title || snapshot.title || asObject(row.seed_data).title || item?.title);
}

function itemUrl(item) {
  const row = itemSeedRow(item);
  const snapshot = itemSnapshot(item);
  return normalizeString(row.canonical_url || row.destination_url || snapshot.canonical_url || snapshot.url || item?.target_url);
}

function itemPrice(item) {
  const row = itemSeedRow(item);
  const snapshot = itemSnapshot(item);
  const raw = row.price_amount ?? row.price ?? snapshot.price_amount ?? snapshot.price;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function itemCurrency(item) {
  const row = itemSeedRow(item);
  const snapshot = itemSnapshot(item);
  return normalizeString(row.price_currency || row.currency || snapshot.price_currency || snapshot.currency);
}

function itemAvailability(item) {
  const row = itemSeedRow(item);
  const snapshot = itemSnapshot(item);
  return normalizeString(row.availability || snapshot.availability || asObject(row.seed_data).availability);
}

function itemImageCount(item) {
  const row = itemSeedRow(item);
  const snapshot = itemSnapshot(item);
  const seedData = asObject(row.seed_data);
  const images = [
    row.image_url,
    snapshot.image_url,
    seedData.image_url,
    ...asArray(snapshot.image_urls),
    ...asArray(seedData.image_urls),
  ].filter((value) => normalizeString(value));
  return new Set(images).size;
}

function itemKey(item) {
  const row = itemSeedRow(item);
  const snapshot = itemSnapshot(item);
  return normalizeString(
    row.external_product_id ||
      row.id ||
      row.canonical_url ||
      row.destination_url ||
      snapshot.canonical_url ||
      snapshot.url ||
      item?.target_url,
  ).toLowerCase();
}

function collectDiagnostics(manifest) {
  const out = [];
  if (manifest?.diagnostics_summary) out.push(manifest.diagnostics_summary);
  for (const attempt of asArray(manifest?.source_attempts)) {
    if (attempt?.diagnostics_summary) out.push(attempt.diagnostics_summary);
  }
  return out;
}

function reviewManifest(manifest, options = {}) {
  const items = asArray(manifest && manifest.items);
  const minCoverage = Number(options.minCoverage || 0.9);
  const failOnBlockProvider = options.failOnBlockProvider !== false;
  const extraExcludeRe = buildExtraExcludeRe(options.excludeTitleRegex);
  const blockers = [];
  const warnings = [];
  const rowFindings = [];
  const blockedKeys = new Set();
  const diagnostics = collectDiagnostics(manifest);

  if (!items.length) blockers.push('zero_accepted_items_from_extractor');
  for (const diagnostic of diagnostics) {
    const failureCategory = normalizeString(diagnostic.failure_category);
    const blockProvider = normalizeString(diagnostic.block_provider);
    if (failureCategory && DEFAULT_BLOCKING_DIAGNOSTIC_RE.test(failureCategory)) {
      blockers.push(`blocked_failure_category:${failureCategory}`);
    }
    if (blockProvider && failOnBlockProvider) {
      blockers.push(`anti_abuse_signal:${blockProvider}`);
    }
  }

  let priced = 0;
  let available = 0;
  let imaged = 0;
  for (const item of items) {
    const title = itemTitle(item);
    const url = itemUrl(item);
    const price = itemPrice(item);
    const currency = itemCurrency(item);
    const availability = itemAvailability(item);
    const imageCount = itemImageCount(item);
    const combined = `${title} ${url}`;
    const reasons = [];
    if (price != null && price > 0 && currency) priced += 1;
    if (availability) available += 1;
    if (imageCount > 0) imaged += 1;
    if (!url || !/^https?:\/\//i.test(url)) reasons.push('missing_product_url');
    if (price == null || price <= 0 || !currency) reasons.push('missing_price_or_currency');
    if (!availability) reasons.push('missing_availability');
    if (!imageCount) reasons.push('missing_image');
    if (DEFAULT_PAGE_POLLUTION_RE.test(combined)) reasons.push('fallback_or_policy_page_text');
    if (DEFAULT_NON_PRODUCT_RE.test(combined)) reasons.push('non_product_or_accessory_title');
    if (extraExcludeRe && extraExcludeRe.test(combined)) reasons.push('manual_exclude_title_regex');
    if (reasons.length) {
      const key = itemKey(item);
      if (key) blockedKeys.add(key);
      rowFindings.push({
        severity: 'blocker',
        reason_codes: reasons,
        title,
        url,
        price,
        currency,
        availability,
      });
    }
  }

  const denom = items.length || 1;
  const priceCoverageRate = Number((priced / denom).toFixed(4));
  const availabilityCoverageRate = Number((available / denom).toFixed(4));
  const imageCoverageRate = Number((imaged / denom).toFixed(4));
  if (items.length && priceCoverageRate < minCoverage) blockers.push(`price_coverage_below_${minCoverage}`);
  if (items.length && availabilityCoverageRate < minCoverage) blockers.push(`availability_coverage_below_${minCoverage}`);
  if (items.length && imageCoverageRate < minCoverage) blockers.push(`image_coverage_below_${minCoverage}`);
  if (rowFindings.length) warnings.push('row_level_blockers_filtered_from_accepted_manifest');

  const acceptedItems = items.filter((item) => !blockedKeys.has(itemKey(item)));
  if (items.length && !acceptedItems.length) blockers.push('no_rows_remain_after_row_review');
  return {
    generated_at: new Date().toISOString(),
    ok_to_continue: blockers.length === 0 && acceptedItems.length > 0,
    blocker_reasons: Array.from(new Set(blockers)),
    warning_reasons: Array.from(new Set(warnings)),
    item_count: items.length,
    accepted_item_count: acceptedItems.length,
    blocked_item_count: rowFindings.length,
    price_coverage_rate: priceCoverageRate,
    availability_coverage_rate: availabilityCoverageRate,
    image_coverage_rate: imageCoverageRate,
    diagnostics,
    row_findings: rowFindings,
    blocked_keys: Array.from(blockedKeys),
  };
}

function buildAcceptedManifest(manifest, review) {
  const blocked = new Set(asArray(review.blocked_keys));
  const items = asArray(manifest.items).filter((item) => !blocked.has(itemKey(item)));
  return {
    ...manifest,
    generated_at: new Date().toISOString(),
    reviewed_from_manifest_generated_at: manifest.generated_at || null,
    review_gate: {
      ok_to_continue: review.ok_to_continue,
      blocker_reasons: review.blocker_reasons,
      warning_reasons: review.warning_reasons,
      accepted_item_count: items.length,
      blocked_item_count: review.blocked_item_count,
    },
    item_count: items.length,
    items,
  };
}

function main() {
  const input = resolvePathMaybeRelative(argValue('input'));
  if (!input) throw new Error('Missing required --input');
  const outJson = resolvePathMaybeRelative(argValue('out'));
  const outCsv = resolvePathMaybeRelative(argValue('out-csv'));
  const acceptedPath = resolvePathMaybeRelative(argValue('accepted-manifest'));
  const manifest = JSON.parse(fs.readFileSync(input, 'utf8'));
  const review = reviewManifest(manifest, {
    minCoverage: Number(argValue('min-coverage') || 0.9),
    failOnBlockProvider: !hasFlag('allow-block-provider'),
    excludeTitleRegex: argValue('exclude-title-regex'),
  });
  const accepted = buildAcceptedManifest(manifest, review);

  if (outJson) {
    ensureDir(outJson);
    fs.writeFileSync(outJson, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
  }
  if (outCsv) {
    ensureDir(outCsv);
    fs.writeFileSync(
      outCsv,
      rowsToCsv(review.row_findings, [
        'severity',
        'reason_codes',
        'title',
        'url',
        'price',
        'currency',
        'availability',
      ]),
      'utf8',
    );
  }
  if (acceptedPath && review.ok_to_continue) {
    ensureDir(acceptedPath);
    fs.writeFileSync(acceptedPath, `${JSON.stringify(accepted, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(review, null, 2)}\n`);
  if (!review.ok_to_continue) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  buildAcceptedManifest,
  reviewManifest,
};
