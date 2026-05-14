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

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function main() {
  const brand = argValue('brand') || null;
  const limit = Math.max(1, Math.min(5000, Number(argValue('limit') || 500) || 500));
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun');
  const out = argValue('out');

  const result = await backfillPdpIdentityGraph({
    brand,
    limit,
    dryRun,
  });
  const payload = {
    ok: true,
    generated_at: new Date().toISOString(),
    input: {
      brand,
      limit,
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
