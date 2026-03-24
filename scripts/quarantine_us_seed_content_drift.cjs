#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');
const { auditExternalSeedRow } = require('../src/services/externalSeedContentAudit');

const DEFAULT_ANOMALIES = Object.freeze([
  'locale_market_mismatch',
  'non_english_description_for_us_seed',
  'fr_content_in_us_seed',
  'es_content_in_us_seed',
]);

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function argValues(name) {
  const out = [];
  for (let idx = 0; idx < process.argv.length; idx += 1) {
    if (process.argv[idx] !== `--${name}`) continue;
    const value = process.argv[idx + 1];
    if (!value || value.startsWith('--')) continue;
    out.push(value);
  }
  return out;
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
  const where = [`status = 'active'`, `market = 'US'`];
  const params = [];
  let idx = 0;
  const bind = (value) => {
    params.push(value);
    idx += 1;
    return `$${idx}`;
  };

  if (options.seedId) where.push(`id::text = ${bind(options.seedId)}`);
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
      tool,
      destination_url,
      canonical_url,
      domain,
      title,
      image_url,
      price_amount,
      price_currency,
      availability,
      seed_data,
      status,
      attached_product_key,
      created_at,
      updated_at
    FROM external_product_seeds
    WHERE ${where.join('\n      AND ')}
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT ${limitBind}
    OFFSET ${offsetBind}
  `;
  const res = await query(sql, params);
  return res.rows || [];
}

function pickMatchingFindings(findings, targetAnomalies) {
  const set = new Set(targetAnomalies.map((item) => normalizeNonEmptyString(item)));
  return (Array.isArray(findings) ? findings : []).filter((finding) =>
    set.has(normalizeNonEmptyString(finding?.anomaly_type)),
  );
}

function buildQuarantinePayload(row, findings) {
  return {
    blocked: true,
    reason: 'content_market_drift',
    market: 'US',
    source: 'quarantine_us_seed_content_drift',
    anomaly_types: findings.map((finding) => normalizeNonEmptyString(finding?.anomaly_type)).filter(Boolean),
    canonical_url: normalizeNonEmptyString(row?.canonical_url || row?.destination_url),
    note: 'US seed quarantined because content audit still showed language or locale drift after correction.',
    findings: findings.map((finding) => ({
      anomaly_type: normalizeNonEmptyString(finding?.anomaly_type),
      severity: normalizeNonEmptyString(finding?.severity),
      evidence: finding?.evidence || {},
      recommended_action: normalizeNonEmptyString(finding?.recommended_action),
      last_extracted_at: normalizeNonEmptyString(finding?.last_extracted_at),
    })),
  };
}

async function quarantineRow(row, findings) {
  const payload = buildQuarantinePayload(row, findings);
  const res = await query(
    `
      UPDATE external_product_seeds
      SET
        status = 'inactive',
        seed_data = jsonb_set(
          jsonb_set(COALESCE(seed_data, '{}'::jsonb), '{content_drift_quarantine}', $2::jsonb, true),
          '{snapshot,diagnostics,content_drift_quarantine}',
          $2::jsonb,
          true
        ),
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, status, canonical_url, destination_url
    `,
    [row.id, JSON.stringify(payload)],
  );
  return res.rows?.[0] || null;
}

function summarize(items, options) {
  const summary = {
    mode: options.dryRun ? 'dry_run' : 'apply',
    scanned: items.length,
    matched: 0,
    quarantined: 0,
    skipped: 0,
    by_domain: {},
    by_anomaly_type: {},
  };

  for (const item of items) {
    const domain = normalizeNonEmptyString(item.domain);
    if (!summary.by_domain[domain]) {
      summary.by_domain[domain] = { scanned: 0, matched: 0, quarantined: 0, skipped: 0 };
    }
    summary.by_domain[domain].scanned += 1;

    if (item.matching_findings.length > 0) {
      summary.matched += 1;
      summary.by_domain[domain].matched += 1;
      for (const finding of item.matching_findings) {
        const anomaly = normalizeNonEmptyString(finding.anomaly_type);
        summary.by_anomaly_type[anomaly] = (summary.by_anomaly_type[anomaly] || 0) + 1;
      }
      if (item.apply_status === 'quarantined') {
        summary.quarantined += 1;
        summary.by_domain[domain].quarantined += 1;
      }
    } else {
      summary.skipped += 1;
      summary.by_domain[domain].skipped += 1;
    }
  }

  return summary;
}

async function main() {
  const options = {
    seedId: argValue('seed-id') || argValue('seedId') || null,
    domain: argValue('domain') || null,
    brand: argValue('brand') || null,
    limit: Math.max(1, Math.min(Number(argValue('limit') || 200), 2000)),
    offset: Math.max(0, Number(argValue('offset') || 0)),
    dryRun: hasFlag('dry-run') || hasFlag('dryRun'),
    out: normalizeNonEmptyString(argValue('out')),
    anomalies: (() => {
      const explicit = argValues('anomaly').map((item) => normalizeNonEmptyString(item)).filter(Boolean);
      return explicit.length ? explicit : Array.from(DEFAULT_ANOMALIES);
    })(),
  };

  const rows = await fetchRows(options);
  const items = [];

  for (const row of rows) {
    const audit = auditExternalSeedRow(row);
    const matchingFindings = pickMatchingFindings(audit.findings, options.anomalies);
    const item = {
      seed_id: row.id,
      domain: row.domain,
      canonical_url: normalizeNonEmptyString(row.canonical_url || row.destination_url),
      matching_findings: matchingFindings,
      apply_status: 'skipped',
    };

    if (matchingFindings.length > 0 && !options.dryRun) {
      const updated = await quarantineRow(row, matchingFindings);
      item.apply_status = updated ? 'quarantined' : 'failed';
    }

    items.push(item);
  }

  const payload = {
    generated_at: new Date().toISOString(),
    options,
    summary: summarize(items, options),
    items,
  };

  if (options.out) {
    ensureParentDir(options.out);
    fs.writeFileSync(options.out, `${JSON.stringify(payload, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_ANOMALIES,
  pickMatchingFindings,
  buildQuarantinePayload,
  summarize,
};
