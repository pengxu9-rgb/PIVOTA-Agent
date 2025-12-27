#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const { parseCsvString, buildTechniqueCardFromCsvRow, writeTechniqueCardJsonFile } = require('../src/layer2/kb/importTechniqueCsv');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }

    const eq = a.indexOf('=');
    if (eq !== -1) {
      const key = a.slice(2, eq);
      const value = a.slice(eq + 1);
      out[key] = value;
      continue;
    }

    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function usageAndExit(code) {
  console.log(`Usage:
  npm run kb:import:csv -- --market JP --input <path/to.csv> [--output <dir>] [--on-duplicate update|reject] [--prepare-pr]

Notes:
  - --market is required (US|JP)
  - --output defaults to src/layer2/kb/<market>/techniques
  - trigger_* fields are semicolon-separated conditions: "key op value"
`);
  process.exit(code);
}

function normalizeMarket(m) {
  const s = String(m ?? '').trim().toUpperCase();
  if (s === 'US' || s === 'JP') return s;
  return null;
}

function runNpmScript(script, extraArgs = []) {
  childProcess.execFileSync('npm', ['run', script, ...extraArgs], {
    stdio: 'inherit',
    env: process.env,
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const market = normalizeMarket(args.market);
  const inputPath = args.input ? String(args.input) : null;
  const outputDirArg = args.output ? String(args.output) : null;
  const onDuplicate = String(args['on-duplicate'] ?? 'reject');
  const preparePr = Boolean(args['prepare-pr']);

  if (!market || !inputPath) usageAndExit(1);
  if (onDuplicate !== 'reject' && onDuplicate !== 'update') {
    console.error(`Invalid --on-duplicate value: ${onDuplicate} (expected "reject" or "update")`);
    process.exit(1);
  }

  const marketLower = market.toLowerCase();
  const outputDir = outputDirArg ?? path.join('src', 'layer2', 'kb', marketLower, 'techniques');

  const csvText = fs.readFileSync(inputPath, 'utf8');
  const { rows } = parseCsvString(csvText);

  fs.mkdirSync(outputDir, { recursive: true });

  const seenIds = new Set();
  const accepted = [];
  const rejected = [];

  for (let idx = 0; idx < rows.length; idx += 1) {
    const rowNumber = idx + 2; // header is row 1
    const row = rows[idx] ?? {};

    // Skip completely empty rows.
    if (!String(row.id ?? '').trim()) continue;

    try {
      const card = buildTechniqueCardFromCsvRow(row, { market });
      if (seenIds.has(card.id)) {
        const msg = `Duplicate id in CSV: ${card.id}`;
        if (onDuplicate === 'reject') throw new Error(msg);
        console.warn(`[kb:import] ${msg} (on-duplicate=update: last row wins)`);
      }
      seenIds.add(card.id);

      const filePath = path.join(outputDir, `${card.id}.json`);
      if (fs.existsSync(filePath) && onDuplicate === 'reject') {
        throw new Error(`Output file already exists: ${filePath} (use --on-duplicate update to overwrite)`);
      }

      writeTechniqueCardJsonFile(outputDir, card);
      accepted.push(card.id);
    } catch (err) {
      rejected.push({ rowNumber, id: String(row.id ?? '').trim(), error: String(err?.message ?? err) });
    }
  }

  console.log(`[kb:import] market=${market} input=${inputPath}`);
  console.log(`[kb:import] wrote ${accepted.length} technique JSON file(s) to ${outputDir}`);

  if (rejected.length) {
    console.log(`[kb:import] rejected ${rejected.length} row(s):`);
    for (const r of rejected) {
      console.log(`  - row ${r.rowNumber}${r.id ? ` (id=${r.id})` : ''}: ${r.error}`);
    }
  }

  if (accepted.length === 0) {
    process.exit(rejected.length ? 1 : 0);
  }

  console.log(`[kb:import] running KB lint...`);
  runNpmScript(`lint:kb:${marketLower}`);

  if (preparePr) {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    if (pkg?.scripts?.['kb:prepare-pr']) {
      console.log(`[kb:import] running kb:prepare-pr (dry-run)...`);
      runNpmScript('kb:prepare-pr', ['--', `--market=${market}`, '--mode=dry-run']);
    } else {
      console.warn(`[kb:import] --prepare-pr requested but package.json has no "kb:prepare-pr" script; skipping.`);
    }
  }

  if (rejected.length) process.exit(1);
}

main();

