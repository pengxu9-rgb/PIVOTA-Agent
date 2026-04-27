#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query, getPool } = require('../src/db');
const {
  buildReadinessRow,
  summarizeReadinessRows,
} = require('../src/services/externalSeedPdpReadiness');

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

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function bindParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function compactErrorMessage(error) {
  return String(error?.message || error || 'unknown_error').slice(0, 240);
}

async function fetchSeedRows(options = {}) {
  const where = [
    `eps.status = 'active'`,
    `eps.external_product_id LIKE 'ext_%'`,
  ];
  const params = [];
  if (!options.allMarkets) {
    where.push(`eps.market = ${bindParam(params, options.market || 'US')}`);
  }
  if (!options.includeAttached) where.push(`eps.attached_product_key IS NULL`);
  if (options.domain) where.push(`eps.domain = ${bindParam(params, options.domain)}`);
  if (options.externalProductId) {
    where.push(`eps.external_product_id = ${bindParam(params, options.externalProductId)}`);
  }
  params.push(Math.max(1, Math.min(Number(options.limit || 5000), 20000)));
  const limitBind = `$${params.length}`;
  params.push(Math.max(0, Number(options.offset || 0)));
  const offsetBind = `$${params.length}`;

  const res = await query(
    `
      SELECT
        eps.id,
        eps.external_product_id,
        eps.market,
        eps.tool,
        eps.domain,
        eps.title,
        eps.canonical_url,
        eps.destination_url,
        eps.image_url,
        eps.attached_product_key,
        coalesce(eps.seed_data, '{}'::jsonb) AS seed_data
      FROM external_product_seeds eps
      WHERE ${where.join('\n        AND ')}
      ORDER BY eps.market, eps.domain, eps.external_product_id
      LIMIT ${limitBind}
      OFFSET ${offsetBind}
    `,
    params,
  );
  return res.rows || [];
}

async function fetchIdentityRowsBy(columnName, values, warnings, chunkSize = 500) {
  const ids = Array.from(new Set((values || []).map(normalizeString).filter(Boolean)));
  const rows = [];
  if (!ids.length) return rows;
  if (!['product_id', 'product_line_id'].includes(columnName)) {
    throw new Error(`Unsupported identity column: ${columnName}`);
  }

  async function fetchChunk(chunk) {
    try {
      const res = await query(
        `
          SELECT product_id, product_line_id
          FROM pdp_identity_listing
          WHERE merchant_id = 'external_seed'
            AND coalesce(live_read_enabled, true) = true
            AND ${columnName} = ANY($1::text[])
            AND product_line_id IS NOT NULL
        `,
        [chunk],
      );
      rows.push(...(res.rows || []));
    } catch (error) {
      if (chunk.length <= 1) {
        warnings.push({
          scope: `pdp_identity_listing.${columnName}`,
          value: chunk[0],
          error: compactErrorMessage(error),
        });
        return;
      }
      const midpoint = Math.ceil(chunk.length / 2);
      await fetchChunk(chunk.slice(0, midpoint));
      await fetchChunk(chunk.slice(midpoint));
    }
  }

  for (let idx = 0; idx < ids.length; idx += chunkSize) {
    await fetchChunk(ids.slice(idx, idx + chunkSize));
  }
  return rows;
}

async function fetchIdentityContext(productIds) {
  const ids = Array.from(new Set((productIds || []).map(normalizeString).filter(Boolean)));
  const warnings = [];
  if (!ids.length) {
    return {
      productLineIdByProductId: new Map(),
      productIdsByLineId: new Map(),
      allProductIds: [],
      warnings,
    };
  }

  const directRows = await fetchIdentityRowsBy('product_id', ids, warnings);
  const productLineIdByProductId = new Map();
  const lineIds = [];
  for (const row of directRows) {
    const productId = normalizeString(row.product_id);
    const lineId = normalizeString(row.product_line_id);
    if (!productId || !lineId) continue;
    productLineIdByProductId.set(productId, lineId);
    lineIds.push(lineId);
  }

  const uniqueLineIds = Array.from(new Set(lineIds));
  const productIdsByLineId = new Map();
  const allProductIds = new Set(ids);
  if (uniqueLineIds.length) {
    const lineRows = await fetchIdentityRowsBy('product_line_id', uniqueLineIds, warnings);
    for (const row of lineRows) {
      const productId = normalizeString(row.product_id);
      const lineId = normalizeString(row.product_line_id);
      if (!productId || !lineId) continue;
      productLineIdByProductId.set(productId, lineId);
      if (!productIdsByLineId.has(lineId)) productIdsByLineId.set(lineId, []);
      productIdsByLineId.get(lineId).push(productId);
      allProductIds.add(productId);
    }
  }

  for (const [lineId, lineProductIds] of productIdsByLineId.entries()) {
    productIdsByLineId.set(lineId, Array.from(new Set(lineProductIds)));
  }

  return {
    productLineIdByProductId,
    productIdsByLineId,
    allProductIds: Array.from(allProductIds),
    warnings,
  };
}

async function fetchKbContext(productIds) {
  const ids = Array.from(new Set((productIds || []).map(normalizeString).filter(Boolean)));
  const kbByProductId = new Map();
  if (!ids.length) return kbByProductId;
  const res = await query(
    `
      SELECT
        kb_key,
        replace(kb_key, 'product:', '') AS product_id,
        analysis AS kb_analysis,
        source AS kb_source,
        source_meta AS kb_source_meta,
        last_error AS kb_last_error,
        last_success_at AS kb_last_success_at,
        updated_at AS kb_updated_at
      FROM aurora_product_intel_kb
      WHERE kb_key = ANY($1::text[])
    `,
    [ids.map((id) => `product:${id}`)],
  );
  for (const row of res.rows || []) {
    const productId = normalizeString(row.product_id);
    if (!productId) continue;
    kbByProductId.set(productId, row);
  }
  return kbByProductId;
}

async function buildReadinessAudit(options = {}) {
  const seedRows = await fetchSeedRows(options);
  const seedProductIds = seedRows.map((row) => row.external_product_id).filter(Boolean);
  const identityContext = await fetchIdentityContext(seedProductIds);
  const kbByProductId = await fetchKbContext(identityContext.allProductIds);
  const context = {
    ...identityContext,
    kbByProductId,
  };
  const rows = seedRows.map((row) => buildReadinessRow(row, context));
  return {
    generated_at: new Date().toISOString(),
    options,
    warnings: identityContext.warnings || [],
    summary: summarizeReadinessRows(rows, { sampleLimit: options.sampleLimit }),
    rows,
  };
}

function renderSummary(payload) {
  const summary = payload.summary || {};
  const intel = summary.pivota_insights || {};
  const active = summary.active_ingredients || {};
  const variants = summary.variants || {};
  const lines = [];
  lines.push(`scanned=${summary.scanned || 0}`);
  lines.push(`by_market=${JSON.stringify(summary.by_market || {})}`);
  lines.push(`by_product_family=${JSON.stringify(summary.by_product_family || [])}`);
  lines.push(`top_domains=${JSON.stringify((summary.by_domain || []).slice(0, 12))}`);
  lines.push(`coverage=${JSON.stringify(summary.coverage || {})}`);
  lines.push(`pivota_insights.direct=${JSON.stringify(intel.direct || {})}`);
  lines.push(`pivota_insights.effective=${JSON.stringify(intel.effective || {})}`);
  lines.push(`pivota_insights.effective_issues=${JSON.stringify((intel.effective_issues || []).slice(0, 12))}`);
  lines.push(`pivota_insights.issue_domains=${JSON.stringify((intel.effective_issue_domains || []).slice(0, 12))}`);
  lines.push(`active_ingredients.status=${JSON.stringify(active.status || [])}`);
  lines.push(`active_ingredients.issues=${JSON.stringify(active.issues || [])}`);
  lines.push(`active_ingredients.issue_domains=${JSON.stringify((active.issue_domains || []).slice(0, 12))}`);
  lines.push(`variants.status=${JSON.stringify(variants.status || [])}`);
  lines.push(`variants.issues=${JSON.stringify(variants.issues || [])}`);
  lines.push(`variants.issue_domains=${JSON.stringify((variants.issue_domains || []).slice(0, 12))}`);
  if (payload.warnings?.length) {
    lines.push(`warnings=${JSON.stringify(payload.warnings.slice(0, 12))}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = {
    market: normalizeString(argValue('market') || 'US').toUpperCase(),
    allMarkets: hasFlag('all-markets') || hasFlag('allMarkets'),
    includeAttached: hasFlag('include-attached') || hasFlag('includeAttached'),
    domain: argValue('domain') || null,
    externalProductId: argValue('external-product-id') || argValue('externalProductId') || null,
    limit: Math.max(1, Math.min(Number(argValue('limit') || 5000), 20000)),
    offset: Math.max(0, Number(argValue('offset') || 0)),
    sampleLimit: Math.max(1, Math.min(Number(argValue('sample-limit') || 8), 100)),
    format: normalizeString(argValue('format') || 'summary').toLowerCase(),
    out: argValue('out') || null,
  };
  const payload = await buildReadinessAudit(options);
  const outputPayload = options.format === 'json' ? payload : { ...payload, rows: undefined };
  const output =
    options.format === 'json'
      ? `${JSON.stringify(outputPayload, null, 2)}\n`
      : renderSummary(outputPayload);
  if (options.out) {
    ensureParentDir(options.out);
    fs.writeFileSync(options.out, output, 'utf8');
  }
  process.stdout.write(output);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await getPool()?.end();
      } catch {}
    });
}

module.exports = {
  buildReadinessAudit,
  fetchSeedRows,
  fetchIdentityContext,
  fetchIdentityRowsBy,
  fetchKbContext,
  renderSummary,
};
