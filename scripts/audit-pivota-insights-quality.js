#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { closePool, query } = require('../src/db');
const {
  buildPivotaInsightInventoryRow,
  summarizePivotaInsightInventory,
} = require('../src/services/pivotaInsightsQuality');

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactJson(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function csvEscape(value) {
  const text = compactJson(value).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function safeTimestamp(value) {
  return asString(value).replace(/[:.]/g, '-');
}

function parseArgs() {
  return {
    limit: Math.max(0, Number(argValue('limit', '0')) || 0),
    outDir: argValue('out-dir', 'reports/pivota-insights-quality'),
    lane: asString(argValue('lane', '')),
    issue: asString(argValue('issue', '')),
    stdout: hasFlag('stdout'),
    noCsv: hasFlag('no-csv'),
  };
}

async function fetchProductIntelRows(limit = 0) {
  const params = [];
  let limitSql = '';
  if (limit > 0) {
    params.push(limit);
    limitSql = 'LIMIT $1';
  }
  const result = await query(
    `
      SELECT
        kb_key,
        analysis,
        source,
        source_meta,
        last_success_at,
        last_error,
        updated_at
      FROM aurora_product_intel_kb
      WHERE kb_key LIKE 'product:%'
      ORDER BY COALESCE(updated_at, last_success_at) DESC NULLS LAST, kb_key
      ${limitSql}
    `,
    params,
  );
  return result.rows || [];
}

function filterInventoryRows(rows, args) {
  return rows.filter((row) => {
    if (args.lane && row.lane !== args.lane) return false;
    if (args.issue) {
      const issues = new Set([...asArray(row.issues), ...asArray(row.blocking_issues)]);
      if (!issues.has(args.issue)) return false;
    }
    return true;
  });
}

async function main() {
  const args = parseArgs();
  const rootDir = path.resolve(__dirname, '..');
  const generatedAt = new Date().toISOString();
  const rawRows = await fetchProductIntelRows(args.limit);
  const inventoryRows = filterInventoryRows(
    rawRows.map((row) => buildPivotaInsightInventoryRow(row)),
    args,
  ).sort((left, right) => right.priority - left.priority || left.kb_key.localeCompare(right.kb_key));
  const summary = summarizePivotaInsightInventory(inventoryRows);
  const report = {
    meta: {
      generated_at: generatedAt,
      source: 'aurora_product_intel_kb',
      row_limit: args.limit || null,
      filters: {
        lane: args.lane || null,
        issue: args.issue || null,
      },
    },
    summary,
    rows: inventoryRows,
  };

  if (args.stdout) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const outDir = resolvePath(rootDir, args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const base = `pivota_insights_quality_${safeTimestamp(generatedAt)}`;
  const jsonPath = path.join(outDir, `${base}.json`);
  const csvPath = path.join(outDir, `${base}.csv`);
  writeJson(jsonPath, report);
  if (!args.noCsv) {
    writeCsv(csvPath, inventoryRows, [
      'product_id',
      'kb_key',
      'lane',
      'reason',
      'priority',
      'protected',
      'agent_readable',
      'public_ready',
      'displayable',
      'high_quality_ready',
      'human_reviewed',
      'quality_state',
      'evidence_profile',
      'review_tier',
      'issues',
      'blocking_issues',
      'bundle_hash',
      'source',
      'updated_at',
      'last_success_at',
    ]);
  }

  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      scanned: summary.scanned,
      summary,
      json: jsonPath,
      csv: args.noCsv ? null : csvPath,
    })}\n`,
  );
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
    });
}

module.exports = {
  fetchProductIntelRows,
  filterInventoryRows,
};
