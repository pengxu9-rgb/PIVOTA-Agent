#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');

const HOLD_VERSION = 'external_seed.content_evidence_hold.v1';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  return String(value == null ? '' : value).trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function readIdsFile(filePath) {
  const normalized = asString(filePath);
  if (!normalized) return [];
  return fs
    .readFileSync(normalized, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function uniqueStrings(values, limit = 5000) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = asString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function isContentEvidenceHold(value) {
  const marker = asObject(value);
  const contractVersion = asString(marker.contract_version || marker.contractVersion);
  const status = asString(marker.status);
  return contractVersion === HOLD_VERSION || status === 'hold_for_evidence' || status === 'content_evidence_hold';
}

function summarizeHoldMarker(value) {
  const marker = asObject(value);
  if (!isContentEvidenceHold(marker)) return null;
  return {
    contract_version: asString(marker.contract_version || marker.contractVersion) || null,
    status: asString(marker.status) || null,
    reason: asString(marker.reason) || null,
    evidence: asString(marker.evidence) || null,
    updated_at: asString(marker.updated_at) || null,
  };
}

function clearSeedDataContentEvidenceHold(seedData) {
  const next = cloneJson(asObject(seedData));
  const snapshot = asObject(next.snapshot);
  const topLevelMarker = summarizeHoldMarker(next.content_evidence_hold_v1);
  const snapshotMarker = summarizeHoldMarker(snapshot.content_evidence_hold_v1);

  if (topLevelMarker) delete next.content_evidence_hold_v1;
  if (snapshotMarker) {
    const nextSnapshot = cloneJson(snapshot);
    delete nextSnapshot.content_evidence_hold_v1;
    next.snapshot = nextSnapshot;
  } else if (Object.prototype.hasOwnProperty.call(next, 'snapshot')) {
    next.snapshot = snapshot;
  }

  return {
    seed_data: next,
    removed_top_level: Boolean(topLevelMarker),
    removed_snapshot: Boolean(snapshotMarker),
    top_level_marker: topLevelMarker,
    snapshot_marker: snapshotMarker,
  };
}

async function fetchRows(ids, market) {
  if (!ids.length) return [];
  const res = await query(
    `
      SELECT id, external_product_id, market, domain, title, canonical_url, destination_url,
             status, seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
        AND ($2::text = '' OR upper(market) = upper($2))
      ORDER BY external_product_id
    `,
    [ids, asString(market)],
  );
  return res.rows || [];
}

async function applyRows(rows, clearResults, { write }) {
  if (!write) return { external_product_seeds: 0 };
  let seedUpdates = 0;
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout = '10000ms'");
      await client.query("SET LOCAL statement_timeout = '60000ms'");
      for (const row of rows) {
        const clearResult = clearResults.get(asString(row.external_product_id));
        if (!clearResult?.removed_top_level && !clearResult?.removed_snapshot) continue;
        const seedResult = await client.query(
          `
            UPDATE external_product_seeds
            SET seed_data = $2::jsonb,
                updated_at = NOW()
            WHERE id = $1
          `,
          [row.id, JSON.stringify(clearResult.seed_data)],
        );
        seedUpdates += Number(seedResult.rowCount || 0);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => null);
      throw error;
    }
  });
  return { external_product_seeds: seedUpdates };
}

async function main() {
  const ids = uniqueStrings([
    ...readIdsFile(argValue('ids-file')),
    ...asString(argValue('external-product-id'))
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    ...asString(argValue('external-product-ids'))
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  ]);
  const market = asString(argValue('market', 'US')).toUpperCase();
  const out = asString(argValue('out'));
  const write = hasFlag('write');
  const generatedAt = new Date().toISOString();

  const rows = await fetchRows(ids, market);
  const foundIds = new Set(rows.map((row) => asString(row.external_product_id)));
  const missingIds = ids.filter((id) => !foundIds.has(id));
  const clearResults = new Map(
    rows.map((row) => [asString(row.external_product_id), clearSeedDataContentEvidenceHold(row.seed_data)]),
  );
  const applyResult = await applyRows(rows, clearResults, { write });
  const clearedRows = rows.filter((row) => {
    const clearResult = clearResults.get(asString(row.external_product_id));
    return clearResult?.removed_top_level || clearResult?.removed_snapshot;
  });
  const report = {
    generated_at: generatedAt,
    dry_run: !write,
    market,
    summary: {
      requested_ids: ids.length,
      scanned: rows.length,
      missing_ids: missingIds.length,
      rows_with_hold_marker: clearedRows.length,
      updated: applyResult,
    },
    missing_ids: missingIds,
    rows: rows.map((row) => {
      const clearResult = clearResults.get(asString(row.external_product_id));
      return {
        id: row.id,
        external_product_id: row.external_product_id,
        title: row.title,
        domain: row.domain,
        canonical_url: row.canonical_url,
        destination_url: row.destination_url,
        before: {
          status: row.status,
          top_level_marker: clearResult?.top_level_marker || null,
          snapshot_marker: clearResult?.snapshot_marker || null,
        },
        after: {
          content_evidence_hold_v1_present: false,
          requires_serving_resync: Boolean(clearResult?.removed_top_level || clearResult?.removed_snapshot),
        },
      };
    }),
  };

  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => null);
    });
}

module.exports = {
  HOLD_VERSION,
  clearSeedDataContentEvidenceHold,
  isContentEvidenceHold,
  summarizeHoldMarker,
};
