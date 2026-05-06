#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

const URL_REPAIR_CONTRACT_VERSION = 'external_seed.url_repair.v1';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return fallback;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function uniqueStrings(values, limit = 100) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = normalizeString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeUrl(value) {
  const normalized = normalizeString(value);
  if (!/^https?:\/\//i.test(normalized)) return '';
  try {
    const parsed = new URL(normalized);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function canonicalUrlKey(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return normalized.replace(/\/+$/, '').toLowerCase();
  }
}

function readMapping() {
  const mappingFile = normalizeString(argValue('mapping-file'));
  const mappingJson = normalizeString(argValue('mapping-json'));
  const mappingJsonBase64 = normalizeString(argValue('mapping-json-base64'));
  let raw = '';
  if (mappingFile) {
    raw = fs.readFileSync(mappingFile, 'utf8');
  } else if (mappingJsonBase64) {
    raw = Buffer.from(mappingJsonBase64, 'base64').toString('utf8');
  } else {
    raw = mappingJson;
  }
  if (!raw) throw new Error('missing_mapping_json');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.mappings)) return parsed.mappings;
  throw new Error('mapping_json_must_be_array_or_object_with_mappings');
}

function collectCurrentUrls(row) {
  const seedData = ensureObject(row?.seed_data);
  const snapshot = ensureObject(seedData.snapshot);
  return uniqueStrings([
    row?.canonical_url,
    row?.destination_url,
    seedData.canonical_url,
    seedData.destination_url,
    snapshot.canonical_url,
    snapshot.destination_url,
  ]);
}

function matchesExpectedCurrentUrl(row, mapping) {
  const expected = uniqueStrings([
    mapping.expected_current_url,
    mapping.expected_old_url,
    ...(Array.isArray(mapping.expected_current_urls) ? mapping.expected_current_urls : []),
  ]).map(canonicalUrlKey);
  if (!expected.length) return true;
  const current = collectCurrentUrls(row).map(canonicalUrlKey);
  return expected.some((item) => current.includes(item));
}

function bodyMatchesTitleHint(body, mapping) {
  const hints = uniqueStrings([
    mapping.expected_title_contains,
    ...(Array.isArray(mapping.expected_title_hints) ? mapping.expected_title_hints : []),
  ]);
  if (!hints.length) return true;
  const haystack = normalizeLower(body);
  return hints.some((hint) => haystack.includes(normalizeLower(hint)));
}

async function verifyPublicProductUrl(url, mapping, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 20000) || 20000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
        'user-agent': 'PivotaSeedUrlRepair/1.0 (+https://pivota.cc)',
      },
    });
    const finalUrl = response.url || url;
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    const ok =
      response.status >= 200 &&
      response.status < 300 &&
      /\/products\//i.test(finalUrl) &&
      bodyMatchesTitleHint(text.slice(0, 600000), mapping);
    return {
      ok,
      status: response.status,
      final_url: finalUrl,
      content_type: contentType,
      body_chars: text.length,
      title_hint_matched: bodyMatchesTitleHint(text.slice(0, 600000), mapping),
      reason: ok ? null : 'public_product_url_verification_failed',
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      final_url: url,
      content_type: '',
      body_chars: 0,
      title_hint_matched: false,
      reason: error?.name === 'AbortError' ? 'public_product_url_verify_timeout' : 'public_product_url_verify_error',
      error: error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildUrlRepairPatch(row, mapping, now, verification = null) {
  const canonicalUrl = normalizeUrl(mapping.canonical_url || mapping.url || mapping.next_url);
  const destinationUrl = normalizeUrl(mapping.destination_url || mapping.url || mapping.next_url || canonicalUrl);
  if (!canonicalUrl || !destinationUrl) throw new Error('missing_valid_next_url');

  const beforeUrls = collectCurrentUrls(row);
  const seedData = cloneJson(ensureObject(row.seed_data));
  const snapshot = ensureObject(seedData.snapshot);
  seedData.snapshot = snapshot;

  const marker = {
    contract_version: URL_REPAIR_CONTRACT_VERSION,
    updated_at: now,
    previous_urls: beforeUrls,
    next_urls: uniqueStrings([canonicalUrl, destinationUrl]),
    reason_codes: uniqueStrings([
      mapping.reason_code || mapping.reason,
      ...(Array.isArray(mapping.reason_codes) ? mapping.reason_codes : []),
    ]),
    source: normalizeString(mapping.source) || 'manual_reviewed_canonical_repair',
    verification: verification || null,
  };

  seedData.canonical_url = canonicalUrl;
  seedData.destination_url = destinationUrl;
  snapshot.canonical_url = canonicalUrl;
  snapshot.destination_url = destinationUrl;
  seedData.external_seed_url_repair_v1 = marker;
  snapshot.external_seed_url_repair_v1 = marker;

  return {
    canonical_url: canonicalUrl,
    destination_url: destinationUrl,
    seed_data: seedData,
    marker,
  };
}

async function fetchRows(ids, market) {
  const res = await query(
    `
      SELECT id, external_product_id, title, market, canonical_url, destination_url, seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
        AND ($2::text = '' OR market = $2::text)
      ORDER BY array_position($1::text[], external_product_id::text)
    `,
    [ids, market],
  );
  return res.rows || [];
}

async function main() {
  const mappings = readMapping();
  const market = normalizeString(argValue('market', 'US')).toUpperCase();
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun');
  const requirePublic200 = hasFlag('require-public-200') || hasFlag('requirePublic200');
  const out = normalizeString(argValue('out'));
  const now = new Date().toISOString();
  const ids = uniqueStrings(mappings.map((mapping) => mapping.external_product_id));
  if (!ids.length) throw new Error('missing_external_product_id_in_mapping');
  const mappingById = new Map(mappings.map((mapping) => [normalizeString(mapping.external_product_id), mapping]));
  const rows = await fetchRows(ids, market);
  const foundIds = new Set(rows.map((row) => normalizeString(row.external_product_id)));
  const missingIds = ids.filter((id) => !foundIds.has(id));
  const results = [];

  for (const row of rows) {
    const id = normalizeString(row.external_product_id);
    const mapping = mappingById.get(id) || {};
    const result = {
      external_product_id: id,
      title: row.title,
      status: 'skipped',
      before_urls: collectCurrentUrls(row),
      next_url: normalizeUrl(mapping.canonical_url || mapping.url || mapping.next_url),
    };
    if (!matchesExpectedCurrentUrl(row, mapping)) {
      result.reason = 'current_url_mismatch';
      results.push(result);
      continue;
    }

    const verification = await verifyPublicProductUrl(result.next_url, mapping);
    result.verification = verification;
    if (requirePublic200 && !verification.ok) {
      result.reason = verification.reason || 'public_product_url_verification_failed';
      results.push(result);
      continue;
    }

    const patch = buildUrlRepairPatch(row, mapping, now, verification);
    result.after_urls = uniqueStrings([patch.canonical_url, patch.destination_url]);
    result.reason_codes = patch.marker.reason_codes;
    result.status = dryRun ? 'dry_run' : 'updated';
    if (!dryRun) {
      await query(
        `
          UPDATE external_product_seeds
          SET canonical_url = $2,
              destination_url = $3,
              seed_data = $4::jsonb,
              updated_at = NOW()
          WHERE id = $1
        `,
        [row.id, patch.canonical_url, patch.destination_url, JSON.stringify(patch.seed_data)],
      );
    }
    results.push(result);
  }

  const report = {
    generated_at: now,
    dry_run: dryRun,
    market,
    summary: {
      requested: ids.length,
      scanned: rows.length,
      missing_ids: missingIds.length,
      dry_run: results.filter((row) => row.status === 'dry_run').length,
      updated: results.filter((row) => row.status === 'updated').length,
      skipped: results.filter((row) => row.status === 'skipped').length,
      verified_public_product_url: results.filter((row) => row.verification?.ok).length,
      by_reason: results.reduce((acc, row) => {
        const reason = row.reason || 'ok';
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {}),
    },
    missing_ids: missingIds,
    results,
  };

  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report.summary, null, 2));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
    });
}

module.exports = {
  URL_REPAIR_CONTRACT_VERSION,
  buildUrlRepairPatch,
  bodyMatchesTitleHint,
  canonicalUrlKey,
  matchesExpectedCurrentUrl,
};
