#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require(path.join(__dirname, '../../..', 'src/db'));

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return '';
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? String(value).trim() : '';
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function resolvePath(value) {
  const raw = text(value);
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function sha(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex').slice(0, 16);
}

function readManifestRows(filePath) {
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return (Array.isArray(doc.items) ? doc.items : [])
    .map((item) => item && item.seed_row)
    .filter((row) => row && row.external_product_id && row.seed_data);
}

function writeOut(filePath, payload) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
  const manifestPath = resolvePath(argValue('manifest'));
  if (!manifestPath) throw new Error('Missing --manifest');
  const outPath = resolvePath(argValue('out'));
  const apply = hasFlag('apply');
  const requestedIds = new Set(
    text(argValue('external-product-ids'))
      .split(/[\s,]+/g)
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const rows = readManifestRows(manifestPath).filter(
    (row) => !requestedIds.size || requestedIds.has(row.external_product_id),
  );
  if (!rows.length) throw new Error('No manifest rows selected');

  const plans = [];
  for (const row of rows) {
    const existing = await query(
      `
        SELECT id, external_product_id, title, seed_data
        FROM external_product_seeds
        WHERE external_product_id = $1 OR id = $2
        LIMIT 1
      `,
      [row.external_product_id, row.seed_id],
    );
    const found = existing.rows && existing.rows[0];
    if (!found) {
      plans.push({
        external_product_id: row.external_product_id,
        seed_id: row.seed_id,
        status: 'missing',
      });
      continue;
    }
    const beforeHash = sha(found.seed_data);
    const afterHash = sha(row.seed_data);
    const changed = beforeHash !== afterHash;
    if (apply && changed) {
      await query(
        `
          UPDATE external_product_seeds
          SET seed_data = $2::jsonb,
              updated_at = NOW()
          WHERE id = $1
        `,
        [found.id, JSON.stringify(row.seed_data)],
      );
    }
    plans.push({
      external_product_id: row.external_product_id,
      seed_id: found.id,
      title: found.title || row.title || null,
      status: changed ? (apply ? 'updated' : 'would_update') : 'unchanged',
      before_hash: beforeHash,
      after_hash: afterHash,
      variant_axis_kinds: (row.seed_data.variants || []).map((variant) => variant.axis_kind || null),
    });
  }

  const payload = {
    ok: true,
    generated_at: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry_run',
    manifest_path: manifestPath,
    selected_rows: rows.length,
    updated: plans.filter((plan) => plan.status === 'updated').length,
    would_update: plans.filter((plan) => plan.status === 'would_update').length,
    unchanged: plans.filter((plan) => plan.status === 'unchanged').length,
    missing: plans.filter((plan) => plan.status === 'missing').length,
    plans,
  };
  writeOut(outPath, payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
