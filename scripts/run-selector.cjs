#!/usr/bin/env node
'use strict';

const { closeReadOnlyPool, queryReadOnly } = require('./lib/read-only-db.cjs');
const { parseCommonArgs, toTable } = require('./lib/pdp-sampling-cli.cjs');
const { getSelector, selectors } = require('./selectors/index.cjs');

function usage() {
  return [
    'Usage: node scripts/run-selector.cjs <name> [--limit N] [--json]',
    '',
    'Runs a read-only PDP repair selector against DATABASE_URL_PUBLIC.',
    '',
    'Available selectors:',
    ...selectors.map((selector) => `  - ${selector.name}`),
  ].join('\n');
}

async function main() {
  const args = parseCommonArgs(process.argv.slice(2));
  const name = args.positional[0];
  if (args.help || !name) {
    process.stdout.write(`${usage()}\n`);
    process.exit(args.help ? 0 : 1);
  }
  const selector = getSelector(name);
  if (!selector) {
    throw new Error(`unknown selector: ${name}`);
  }
  const totalResult = await queryReadOnly(`SELECT COUNT(*)::int AS total_rows FROM (${selector.query}) selector_rows`);
  const sampleResult = await queryReadOnly(`${selector.query}\nLIMIT $1`, [args.limit]);
  const payload = {
    name: selector.name,
    total_rows: Number(totalResult.rows?.[0]?.total_rows || 0),
    sample: sampleResult.rows || [],
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${selector.name}\n`);
    process.stdout.write(`total_rows: ${payload.total_rows}\n\n`);
    process.stdout.write(`${toTable(payload.sample)}\n`);
  }
}

main()
  .catch((err) => {
    process.stderr.write(`${err?.message || err}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeReadOnlyPool().catch(() => {}));
