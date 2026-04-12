#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');
const { resolveProductRef } = require('../src/services/productGroundingResolver');
const { buildExternalSeedRecallLikePredicate } = require('../src/services/externalSeedRecall');
const {
  buildRecoAuthorityQueryVariants,
  buildRecoAuthoritySearchAliases,
} = require('../src/services/recoAlternativesAuthority');

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function resolvePathMaybeRelative(targetPath) {
  const normalized = normalizeNonEmptyString(targetPath);
  if (!normalized) return '';
  return path.isAbsolute(normalized) ? normalized : path.join(process.cwd(), normalized);
}

function uniqStrings(values, maxItems = 16) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const normalized = normalizeNonEmptyString(raw);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function buildLikePattern(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase().replace(/[%_]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized ? `%${normalized}%` : '';
}

function normalizeCandidateRow(raw) {
  const row = ensureObject(raw);
  const product = ensureObject(row.product);
  const seedRow = ensureObject(row.seed_row);
  const brand = normalizeNonEmptyString(
    row.brand || product.brand || seedRow.brand || seedRow.seed_data?.brand,
  );
  const name = normalizeNonEmptyString(
    row.name || product.name || product.display_name || seedRow.title || seedRow.seed_data?.title,
  );
  const productType = normalizeNonEmptyString(
    row.product_type || row.productType || product.product_type || product.category || seedRow.seed_data?.category,
  );
  const usageRole = normalizeNonEmptyString(row.usage_role || row.usageRole || row.role_scope);
  const searchAliases = uniqStrings(
    [
      ...(Array.isArray(row.search_aliases) ? row.search_aliases : []),
      ...(Array.isArray(product.search_aliases) ? product.search_aliases : []),
      ...(Array.isArray(seedRow.seed_data?.search_aliases) ? seedRow.seed_data.search_aliases : []),
      brand && name ? `${brand} ${name}` : '',
      name,
    ],
    8,
  );
  return {
    brand,
    name,
    product_type: productType || null,
    usage_role: usageRole || null,
    search_aliases: searchAliases,
    source_row: row,
  };
}

function parseInputRows(inputPath) {
  const resolved = resolvePathMaybeRelative(inputPath);
  if (!resolved) return [];
  const body = fs.readFileSync(resolved, 'utf8');
  const trimmed = body.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.rows)) return parsed.rows;
    if (Array.isArray(parsed.items)) return parsed.items;
    return [];
  }
  const rows = [];
  for (const line of body.split(/\r?\n/)) {
    const normalized = line.trim();
    if (!normalized) continue;
    rows.push(JSON.parse(normalized));
  }
  return rows;
}

async function fetchInternalHitsForVariant(queryFn, variant, limit = 5) {
  const pattern = buildLikePattern(variant?.query);
  if (!pattern) return [];
  const res = await queryFn(
    `
      SELECT
        product_id::text AS product_id,
        merchant_id::text AS merchant_id
      FROM products_cache
      WHERE lower(to_jsonb(products_cache)::text) LIKE $1
      LIMIT $2
    `,
    [pattern, Math.max(1, Math.min(Number(limit) || 5, 20))],
  );
  return Array.isArray(res?.rows) ? res.rows : [];
}

async function fetchExternalHitsForVariant(queryFn, variant, limit = 5) {
  const pattern = buildLikePattern(variant?.query);
  if (!pattern) return [];
  const res = await queryFn(
    `
      SELECT
        id,
        external_product_id,
        title,
        canonical_url,
        domain
      FROM external_product_seeds
      WHERE status = 'active'
        AND attached_product_key IS NULL
        AND ${buildExternalSeedRecallLikePredicate('$1')}
      LIMIT $2
    `,
    [[pattern], Math.max(1, Math.min(Number(limit) || 5, 20))],
  );
  return Array.isArray(res?.rows) ? res.rows : [];
}

async function auditCandidate(candidate, deps = {}) {
  const queryFn = typeof deps.queryFn === 'function' ? deps.queryFn : query;
  const resolveProductRefFn = typeof deps.resolveProductRefFn === 'function' ? deps.resolveProductRefFn : resolveProductRef;
  const normalized = normalizeCandidateRow(candidate);
  const variants = buildRecoAuthorityQueryVariants({
    brand: normalized.brand,
    name: normalized.name,
    category: normalized.product_type,
    usageRole: normalized.usage_role,
    searchAliases: normalized.search_aliases,
    maxVariants: 6,
  });
  const queryVariants = variants.map((item) => item.query);
  const rows = [];
  let firstInternalMatch = null;
  let firstExternalMatch = null;
  for (const variant of variants.slice(0, 4)) {
    // eslint-disable-next-line no-await-in-loop
    const [internalHits, externalHits] = await Promise.all([
      fetchInternalHitsForVariant(queryFn, variant, 5),
      fetchExternalHitsForVariant(queryFn, variant, 5),
    ]);
    if (!firstInternalMatch && internalHits.length) firstInternalMatch = { variant, rows: internalHits };
    if (!firstExternalMatch && externalHits.length) firstExternalMatch = { variant, rows: externalHits };
    rows.push({
      query: variant.query,
      kind: variant.kind,
      internal_hit_count: internalHits.length,
      external_hit_count: externalHits.length,
    });
  }

  let resolver = null;
  try {
    resolver = await resolveProductRefFn({
      query: `${normalized.brand} ${normalized.name}`.trim(),
      lang: 'en',
      hints: {
        search_aliases: buildRecoAuthoritySearchAliases({
          brand: normalized.brand,
          name: normalized.name,
          category: normalized.product_type,
          usageRole: normalized.usage_role,
          searchAliases: queryVariants,
          maxAliases: 8,
        }),
      },
      options: {
        search_all_merchants: true,
        stable_alias_short_circuit: true,
        allow_stable_alias_for_uuid: true,
        allow_external_seed: true,
        external_seed_strategy: 'supplement_internal_first',
        upstream_retries: 0,
        timeout_ms: 1600,
      },
    });
  } catch (error) {
    resolver = {
      resolved: false,
      reason: error?.code || error?.message || 'resolver_error',
      error_code: error?.code || null,
    };
  }

  let classification = 'missing_authority';
  if (resolver?.resolved === true && resolver?.product_ref) {
    classification = String(resolver.product_ref?.merchant_id || '').trim().toLowerCase() === 'external_seed'
      ? 'external_seed_hit'
      : 'internal_hit';
  } else if (firstInternalMatch || firstExternalMatch) {
    classification = 'present_but_unresolved';
  }

  return {
    brand: normalized.brand,
    name: normalized.name,
    product_type: normalized.product_type,
    usage_role: normalized.usage_role,
    classification,
    query_variants: queryVariants,
    first_internal_match: firstInternalMatch
      ? {
          query: firstInternalMatch.variant.query,
          kind: firstInternalMatch.variant.kind,
          hit_count: firstInternalMatch.rows.length,
          merchant_ids: uniqStrings(firstInternalMatch.rows.map((row) => row.merchant_id), 5),
        }
      : null,
    first_external_match: firstExternalMatch
      ? {
          query: firstExternalMatch.variant.query,
          kind: firstExternalMatch.variant.kind,
          hit_count: firstExternalMatch.rows.length,
          domains: uniqStrings(firstExternalMatch.rows.map((row) => row.domain), 5),
        }
      : null,
    resolver: {
      resolved: resolver?.resolved === true,
      reason: normalizeNonEmptyString(resolver?.reason) || null,
      product_ref: resolver?.product_ref || null,
      metadata: ensureObject(resolver?.metadata),
    },
    variant_audit: rows,
    miss_reason:
      classification === 'missing_authority'
        ? 'no_internal_or_external_authority_hit'
        : classification === 'present_but_unresolved'
          ? 'presence_hit_without_runtime_resolution'
          : null,
  };
}

function summarizeAuditRows(rows) {
  const summary = {
    scanned: Array.isArray(rows) ? rows.length : 0,
    internal_hit: 0,
    external_seed_hit: 0,
    present_but_unresolved: 0,
    missing_authority: 0,
    by_brand: {},
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = normalizeNonEmptyString(row?.classification);
    if (key && Object.prototype.hasOwnProperty.call(summary, key)) {
      summary[key] += 1;
    }
    const brand = normalizeNonEmptyString(row?.brand) || 'unknown';
    summary.by_brand[brand] = summary.by_brand[brand] || {
      scanned: 0,
      internal_hit: 0,
      external_seed_hit: 0,
      present_but_unresolved: 0,
      missing_authority: 0,
    };
    summary.by_brand[brand].scanned += 1;
    if (key && Object.prototype.hasOwnProperty.call(summary.by_brand[brand], key)) {
      summary.by_brand[brand][key] += 1;
    }
  }
  return summary;
}

async function main() {
  const inputPath = argValue('input');
  if (!inputPath) {
    throw new Error('Missing required --input <candidates.json|jsonl>');
  }
  const rows = parseInputRows(inputPath).map(normalizeCandidateRow).filter((row) => row.brand && row.name);
  const audited = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    audited.push(await auditCandidate(row));
  }
  const output = {
    generated_at: new Date().toISOString(),
    input_path: resolvePathMaybeRelative(inputPath),
    summary: summarizeAuditRows(audited),
    rows: audited,
  };
  const outPath = resolvePathMaybeRelative(argValue('out'));
  const body = `${JSON.stringify(output, null, 2)}\n`;
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
  buildLikePattern,
  normalizeCandidateRow,
  parseInputRows,
  fetchInternalHitsForVariant,
  fetchExternalHitsForVariant,
  auditCandidate,
  summarizeAuditRows,
};
