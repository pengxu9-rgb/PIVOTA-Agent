#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');
const { auditExternalSeedRow, summarizeAuditResults } = require('../src/services/externalSeedContentAudit');
const {
  createExternalSeedAuditRun,
  recordExternalSeedAuditFindings,
} = require('../src/services/externalSeedAuditLedger');

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

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function fetchRows(options) {
  const where = [];
  const params = [];
  let idx = 0;

  const bind = (value) => {
    params.push(value);
    idx += 1;
    return `$${idx}`;
  };

  if (!options.includeInactive) where.push(`status = 'active'`);
  if (options.market) where.push(`market = ${bind(options.market)}`);
  if (options.seedId) where.push(`id::text = ${bind(options.seedId)}`);
  if (options.externalProductId) where.push(`external_product_id = ${bind(options.externalProductId)}`);
  if (options.domain) where.push(`domain = ${bind(options.domain)}`);
  if (options.brand) where.push(`lower(coalesce(seed_data->>'brand', '')) = lower(${bind(options.brand)})`);

  params.push(options.limit);
  const limitBind = `$${params.length}`;
  params.push(options.offset);
  const offsetBind = `$${params.length}`;

  const sql = `
    SELECT
      id,
      external_product_id,
      market,
      domain,
      canonical_url,
      destination_url,
      title,
      image_url,
      price_amount,
      price_currency,
      availability,
      seed_data,
      status,
      updated_at,
      created_at
    FROM external_product_seeds
    ${where.length ? `WHERE ${where.join('\n      AND ')}` : ''}
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT ${limitBind}
    OFFSET ${offsetBind}
  `;

  const res = await query(sql, params);
  return res.rows || [];
}

function renderSummary(summary) {
  return [
    `scanned=${summary.scanned}`,
    `flagged_rows=${summary.flagged_rows}`,
    `findings_total=${summary.findings_total}`,
    `blocker=${summary.by_severity.blocker}`,
    `review=${summary.by_severity.review}`,
    `info=${summary.by_severity.info}`,
  ].join(' ');
}

async function main() {
  const options = {
    market: normalizeNonEmptyString(argValue('market') || 'US').toUpperCase(),
    seedId: argValue('seed-id') || argValue('seedId') || null,
    externalProductId: argValue('external-product-id') || argValue('externalProductId') || null,
    domain: argValue('domain') || null,
    brand: argValue('brand') || null,
    limit: Math.max(1, Math.min(Number(argValue('limit') || 200), 5000)),
    offset: Math.max(0, Number(argValue('offset') || 0)),
    includeInactive: hasFlag('include-inactive'),
    format: normalizeNonEmptyString(argValue('format') || 'summary').toLowerCase(),
    out: argValue('out') || null,
    onlyFlagged: !hasFlag('include-clean'),
    persistRun: hasFlag('persist-run') || hasFlag('persistRun'),
    stage: normalizeNonEmptyString(argValue('stage') || 'initial'),
  };

  const rows = await fetchRows(options);
  const results = rows.map((row) => auditExternalSeedRow(row));
  const findings = results.flatMap((result) => result.findings || []);
  const summary = summarizeAuditResults(results);
  let auditRunId = null;
  if (options.persistRun) {
    auditRunId = await createExternalSeedAuditRun({
      stage: options.stage,
      market: options.market,
      filters: {
        seed_id: options.seedId,
        external_product_id: options.externalProductId,
        domain: options.domain,
        brand: options.brand,
        limit: options.limit,
        offset: options.offset,
      },
      summary,
    });
    await recordExternalSeedAuditFindings(auditRunId, findings);
  }
  const payload = {
    options,
    summary,
    audit_run_id: auditRunId,
    findings: options.onlyFlagged ? findings : results,
  };

  let output = '';
  if (options.format === 'json') {
    output = `${JSON.stringify(payload, null, 2)}\n`;
  } else if (options.format === 'jsonl') {
    output = `${findings.map((finding) => JSON.stringify(finding)).join('\n')}\n`;
  } else {
    const lines = [renderSummary(payload.summary)];
    for (const finding of findings.slice(0, 50)) {
      lines.push(
        `${finding.severity.toUpperCase()} ${finding.domain} ${finding.seed_id} ${finding.anomaly_type} ${finding.canonical_url}`,
      );
    }
    if (findings.length > 50) lines.push(`... ${findings.length - 50} more findings`);
    output = `${lines.join('\n')}\n`;
  }

  if (options.out) {
    ensureParentDir(options.out);
    fs.writeFileSync(options.out, output, 'utf8');
  }
  process.stdout.write(output);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchRows,
  renderSummary,
};
