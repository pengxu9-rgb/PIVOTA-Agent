#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool } = require('../src/db');
const { backfillPdpIdentityGraph } = require('../src/services/pdpIdentityGraph');

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return '';
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? String(value).trim() : '';
}

function parseListValues(...values) {
  return Array.from(
    new Set(
      values
        .flatMap((value) => String(value || '').split(/[\n,]/g))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function main() {
  const brand = argValue('brand') || null;
  const externalProductIdsFile = argValue('external-product-ids-file');
  const externalProductIds = parseListValues(
    argValue('external-product-id'),
    argValue('external-product-ids'),
    externalProductIdsFile ? fs.readFileSync(path.resolve(externalProductIdsFile), 'utf8') : '',
  );
  const limitFallback = externalProductIds.length || 500;
  const limit = Math.max(1, Math.min(5000, Number(argValue('limit') || limitFallback) || limitFallback));
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun');
  // Catch-up mode: mint ONLY for seeds with no listing yet. Structurally
  // cannot rewrite an existing row (see the NOT EXISTS note in
  // fetchBackfillProducts) -- this is what makes an unattended run safe.
  const onlyUncovered = hasFlag('only-uncovered') || hasFlag('onlyUncovered');
  const out = argValue('out');

  const result = await backfillPdpIdentityGraph({
    brand,
    limit,
    onlyUncovered,
    externalProductIds,
    dryRun,
  });
  const payload = {
    ok: true,
    generated_at: new Date().toISOString(),
    input: {
      brand,
      limit,
      only_uncovered: onlyUncovered,
      external_product_ids: externalProductIds,
      dry_run: dryRun,
    },
    result,
  };

  if (out) {
    const outPath = path.resolve(out);
    ensureParent(outPath);
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(
      `${JSON.stringify(
        {
          ok: false,
          error: 'PDP_IDENTITY_GRAPH_BACKFILL_FAILED',
          message: err?.message || String(err),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
