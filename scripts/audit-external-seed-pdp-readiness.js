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

function safeFilePart(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown';
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

async function fetchSeedRowsPage(options = {}) {
  const where = [
    `eps.status = 'active'`,
    `eps.external_product_id LIKE 'ext_%'`,
  ];
  const params = [];
  if (!options.allMarkets) {
    where.push(`eps.market = ${bindParam(params, options.market || 'US')}`);
  }
  if (!options.includeAttached) where.push(`eps.attached_product_key IS NULL`);
  if (options.cursor) where.push(`eps.id > ${bindParam(params, options.cursor)}`);
  params.push(Math.max(1, Math.min(Number(options.pageSize || options.limit || 250), 1000)));
  const limitBind = `$${params.length}`;

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
      ORDER BY eps.id
      LIMIT ${limitBind}
    `,
    params,
  );
  return res.rows || [];
}

async function fetchSeedDomains(options = {}) {
  const where = [
    `eps.status = 'active'`,
    `eps.external_product_id LIKE 'ext_%'`,
  ];
  const params = [];
  if (!options.allMarkets) {
    where.push(`eps.market = ${bindParam(params, options.market || 'US')}`);
  }
  if (!options.includeAttached) where.push(`eps.attached_product_key IS NULL`);

  const res = await query(
    `
      SELECT eps.domain, count(*)::int AS seed_count
      FROM external_product_seeds eps
      WHERE ${where.join('\n        AND ')}
      GROUP BY eps.domain
      ORDER BY seed_count DESC, eps.domain
    `,
    params,
  );
  return (res.rows || []).map((row) => normalizeString(row.domain)).filter(Boolean);
}

async function fetchSeedRowsChunkedByDomain(options = {}) {
  if (options.domain || options.externalProductId) return fetchSeedRows(options);
  const domains = await fetchSeedDomains(options);
  const rows = [];
  const maxRows = Math.max(1, Math.min(Number(options.limit || 5000), 20000));
  for (const domain of domains) {
    if (rows.length >= maxRows) break;
    const chunk = await fetchSeedRows({
      ...options,
      domain,
      limit: maxRows - rows.length,
      offset: 0,
    });
    rows.push(...chunk);
  }
  return rows;
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
          SELECT product_id, product_line_id, variant_axes
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
      variantAxesByProductId: new Map(),
      productIdsByLineId: new Map(),
      allProductIds: [],
      warnings,
    };
  }

  const directRows = await fetchIdentityRowsBy('product_id', ids, warnings);
  const productLineIdByProductId = new Map();
  const variantAxesByProductId = new Map();
  const lineIds = [];
  for (const row of directRows) {
    const productId = normalizeString(row.product_id);
    const lineId = normalizeString(row.product_line_id);
    if (!productId || !lineId) continue;
    productLineIdByProductId.set(productId, lineId);
    if (row.variant_axes && typeof row.variant_axes === 'object' && !Array.isArray(row.variant_axes)) {
      variantAxesByProductId.set(productId, row.variant_axes);
    }
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
      if (!variantAxesByProductId.has(productId) && row.variant_axes && typeof row.variant_axes === 'object' && !Array.isArray(row.variant_axes)) {
        variantAxesByProductId.set(productId, row.variant_axes);
      }
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
    variantAxesByProductId,
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

async function buildReadinessAuditForSeedRows(seedRows, options = {}) {
  const seedProductIds = seedRows.map((row) => row.external_product_id).filter(Boolean);
  const intelContextMode = normalizeString(options.intelContext || 'effective').toLowerCase();
  const identityContext =
    intelContextMode === 'effective'
      ? await fetchIdentityContext(seedProductIds)
      : {
          productLineIdByProductId: new Map(),
          variantAxesByProductId: new Map(),
          productIdsByLineId: new Map(),
          allProductIds: seedProductIds,
          warnings: [],
        };
  const kbByProductId =
    intelContextMode === 'none'
      ? new Map()
      : await fetchKbContext(identityContext.allProductIds);
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

async function buildReadinessAudit(options = {}) {
  const seedRows = options.chunkByDomain
    ? await fetchSeedRowsChunkedByDomain(options)
    : await fetchSeedRows(options);
  return buildReadinessAuditForSeedRows(seedRows, options);
}

function readJsonFileIfPresent(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function checkpointDomainPath(checkpointDir, domain) {
  return path.join(checkpointDir, 'domains', `${safeFilePart(domain)}.json`);
}

async function buildCheckpointedReadinessAudit(options = {}) {
  const checkpointMode = normalizeString(options.checkpointMode || 'page').toLowerCase();
  if (checkpointMode === 'domain') return buildDomainCheckpointedReadinessAudit(options);
  return buildPageCheckpointedReadinessAudit(options);
}

async function buildDomainCheckpointedReadinessAudit(options = {}) {
  const checkpointDir = path.resolve(options.checkpointDir);
  const domains = await fetchSeedDomains(options);
  const selectedDomains = domains.slice(0, Math.max(1, Number(options.maxDomains || domains.length)));
  const rows = [];
  const warnings = [];
  const manifest = {
    generated_at: new Date().toISOString(),
    checkpoint_dir: checkpointDir,
    options,
    domain_count: selectedDomains.length,
    completed_domains: [],
    skipped_domains: [],
    failed_domains: [],
  };

  fs.mkdirSync(path.join(checkpointDir, 'domains'), { recursive: true });

  for (const domain of selectedDomains) {
    const filePath = checkpointDomainPath(checkpointDir, domain);
    if (options.resume && !options.force && fs.existsSync(filePath)) {
      const cached = readJsonFileIfPresent(filePath);
      if (cached?.rows?.length) {
        rows.push(...cached.rows);
        warnings.push(...(cached.warnings || []));
        manifest.skipped_domains.push({ domain, rows: cached.rows.length, file: filePath });
        process.stderr.write(`[pdp-readiness] resume ${domain}: ${cached.rows.length} rows\n`);
        continue;
      }
    }

    process.stderr.write(`[pdp-readiness] audit ${domain}\n`);
    try {
      const domainPayload = await buildReadinessAudit({
        ...options,
        domain,
        checkpointDir: null,
        chunkByDomain: false,
      });
      ensureParentDir(filePath);
      fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(domainPayload, null, 2)}\n`, 'utf8');
      fs.renameSync(`${filePath}.tmp`, filePath);
      rows.push(...(domainPayload.rows || []));
      warnings.push(...(domainPayload.warnings || []));
      manifest.completed_domains.push({ domain, rows: domainPayload.rows?.length || 0, file: filePath });
      process.stderr.write(`[pdp-readiness] done ${domain}: ${domainPayload.rows?.length || 0} rows\n`);
    } catch (error) {
      const entry = { domain, error: compactErrorMessage(error) };
      manifest.failed_domains.push(entry);
      process.stderr.write(`[pdp-readiness] failed ${domain}: ${entry.error}\n`);
      if (!options.continueOnError) throw error;
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    options,
    warnings,
    summary: summarizeReadinessRows(rows, { sampleLimit: options.sampleLimit }),
    rows,
    manifest,
  };
  const manifestPath = path.join(checkpointDir, 'manifest.json');
  fs.writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify({ ...manifest, summary: payload.summary }, null, 2)}\n`, 'utf8');
  fs.renameSync(`${manifestPath}.tmp`, manifestPath);
  return payload;
}

function checkpointPagePath(checkpointDir, pageNumber) {
  return path.join(checkpointDir, 'pages', `page-${String(pageNumber).padStart(6, '0')}.json`);
}

function listCheckpointPageFiles(checkpointDir) {
  const dir = path.join(checkpointDir, 'pages');
  try {
    return fs.readdirSync(dir)
      .filter((name) => /^page-\d+\.json$/.test(name))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

async function buildPageCheckpointedReadinessAudit(options = {}) {
  const checkpointDir = path.resolve(options.checkpointDir);
  const rows = [];
  const warnings = [];
  const manifest = {
    generated_at: new Date().toISOString(),
    checkpoint_dir: checkpointDir,
    options,
    checkpoint_mode: 'page',
    completed_pages: [],
    skipped_pages: [],
    failed_pages: [],
  };
  fs.mkdirSync(path.join(checkpointDir, 'pages'), { recursive: true });

  let cursor = normalizeString(options.cursor);
  let nextPageNumber = 1;
  if (options.resume && !options.force) {
    const cachedFiles = listCheckpointPageFiles(checkpointDir);
    for (const filePath of cachedFiles) {
      const cached = readJsonFileIfPresent(filePath);
      if (!cached?.rows?.length) continue;
      rows.push(...cached.rows);
      warnings.push(...(cached.warnings || []));
      cursor = normalizeString(cached.next_cursor || cached.rows[cached.rows.length - 1]?.seed_id || cursor);
      manifest.skipped_pages.push({ page: nextPageNumber, rows: cached.rows.length, cursor, file: filePath });
      nextPageNumber += 1;
      process.stderr.write(`[pdp-readiness] resume page ${nextPageNumber - 1}: ${cached.rows.length} rows\n`);
    }
  }

  const maxRows = Math.max(1, Math.min(Number(options.limit || 5000), 20000));
  const maxPages = Math.max(0, Number(options.maxPages || 0));
  const pageSize = Math.max(1, Math.min(Number(options.pageSize || 250), 1000));
  while (rows.length < maxRows) {
    if (maxPages && manifest.completed_pages.length >= maxPages) break;
    const seedRows = await fetchSeedRowsPage({
      ...options,
      cursor,
      pageSize: Math.min(pageSize, maxRows - rows.length),
    });
    if (!seedRows.length) break;
    const pageNumber = nextPageNumber;
    const filePath = checkpointPagePath(checkpointDir, pageNumber);
    process.stderr.write(`[pdp-readiness] audit page ${pageNumber}: cursor=${cursor || 'start'} rows=${seedRows.length}\n`);
    try {
      const pagePayload = await buildReadinessAuditForSeedRows(seedRows, options);
      const nextCursor = normalizeString(seedRows[seedRows.length - 1]?.id || cursor);
      const payloadWithCursor = { ...pagePayload, next_cursor: nextCursor };
      fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(payloadWithCursor, null, 2)}\n`, 'utf8');
      fs.renameSync(`${filePath}.tmp`, filePath);
      rows.push(...(pagePayload.rows || []));
      warnings.push(...(pagePayload.warnings || []));
      cursor = nextCursor;
      manifest.completed_pages.push({ page: pageNumber, rows: pagePayload.rows?.length || 0, cursor, file: filePath });
      nextPageNumber += 1;
      process.stderr.write(`[pdp-readiness] done page ${pageNumber}: ${pagePayload.rows?.length || 0} rows cursor=${cursor}\n`);
    } catch (error) {
      const entry = { page: pageNumber, cursor, error: compactErrorMessage(error) };
      manifest.failed_pages.push(entry);
      process.stderr.write(`[pdp-readiness] failed page ${pageNumber}: ${entry.error}\n`);
      if (!options.continueOnError) throw error;
      cursor = normalizeString(seedRows[seedRows.length - 1]?.id || cursor);
      nextPageNumber += 1;
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    options,
    warnings,
    summary: summarizeReadinessRows(rows, { sampleLimit: options.sampleLimit }),
    rows,
    manifest,
  };
  const manifestPath = path.join(checkpointDir, 'manifest.json');
  fs.writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify({ ...manifest, summary: payload.summary }, null, 2)}\n`, 'utf8');
  fs.renameSync(`${manifestPath}.tmp`, manifestPath);
  return payload;
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
    intelContext: normalizeString(argValue('intel-context') || argValue('intelContext') || 'effective').toLowerCase(),
    chunkByDomain: hasFlag('chunk-by-domain') || hasFlag('chunkByDomain'),
    checkpointDir: argValue('checkpoint-dir') || argValue('checkpointDir') || null,
    checkpointMode: normalizeString(argValue('checkpoint-mode') || argValue('checkpointMode') || 'page').toLowerCase(),
    resume: hasFlag('resume'),
    force: hasFlag('force'),
    continueOnError: hasFlag('continue-on-error') || hasFlag('continueOnError'),
    maxDomains: Number(argValue('max-domains') || argValue('maxDomains') || 0),
    maxPages: Number(argValue('max-pages') || argValue('maxPages') || 0),
    pageSize: Math.max(1, Math.min(Number(argValue('page-size') || argValue('pageSize') || 250), 1000)),
    cursor: argValue('cursor') || null,
    format: normalizeString(argValue('format') || 'summary').toLowerCase(),
    out: argValue('out') || null,
  };
  const payload = options.checkpointDir && !options.domain && !options.externalProductId
    ? await buildCheckpointedReadinessAudit(options)
    : await buildReadinessAudit(options);
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
  buildReadinessAuditForSeedRows,
  buildCheckpointedReadinessAudit,
  buildDomainCheckpointedReadinessAudit,
  buildPageCheckpointedReadinessAudit,
  fetchSeedRows,
  fetchSeedRowsPage,
  fetchSeedDomains,
  fetchSeedRowsChunkedByDomain,
  fetchIdentityContext,
  fetchIdentityRowsBy,
  fetchKbContext,
  renderSummary,
};
