#!/usr/bin/env node
/* eslint-disable no-console */
const { loadIntentsV0 } = require('../src/layer2/dicts/intents');
const { loadTechniqueKB } = require('../src/layer2/kb/loadTechniqueKB');
const { computeIntentTechniqueMappingReport } = require('../src/layer2/kb/checkIntentTechniqueMapping');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
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

function normalizeMarket(m) {
  const s = String(m ?? '').trim().toUpperCase();
  if (s === 'US' || s === 'JP') return s;
  return null;
}

function usageAndExit(code) {
  console.log(`Usage:
  npm run kb:check:mapping -- --market JP [--ci]

Checks:
  - intents_v0.json intent -> techniqueIds mapping for the given market
  - every referenced technique id must exist in the market KB OR be declared in intents_v0.json.placeholders

Exit codes:
  - default: always exits 0 (prints missing ids if found)
  - --ci: exits 1 if any missing non-placeholder ids are found
`);
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const market = normalizeMarket(args.market);
  const ci = Boolean(args.ci);
  if (!market) usageAndExit(1);

  const dict = loadIntentsV0();
  const kb = loadTechniqueKB(market);
  const kbIds = new Set(kb.list.map((c) => c.id));
  const report = computeIntentTechniqueMappingReport({ market, intentsDict: dict, techniqueIds: kbIds });

  console.log(`[kb:check:mapping] market=${market}`);
  console.log(
    `[kb:check:mapping] intents=${report.totalIntents} techniqueRefs=${report.totalRefs} placeholders=${report.placeholderCount} kbCards=${report.kbCardCount}`,
  );

  if (report.missingNonPlaceholderRefs === 0) {
    console.log('[kb:check:mapping] OK: no missing technique ids.');
    return;
  }

  console.log(`[kb:check:mapping] missing non-placeholder references=${report.missingNonPlaceholderRefs}`);
  console.log('');
  console.log('[kb:check:mapping] Missing technique ids (grouped by intent):');
  console.log('');

  for (const row of report.missingIntentsRanked) {
    console.log(`- intent=${row.intentId} missingCount=${row.missingCount}`);
    for (const tid of row.missingTechniqueIds) {
      console.log(`  - ${tid}`);
      console.log(`    Fix options:`);
      console.log(`    1) Create card: src/layer2/kb/${market.toLowerCase()}/techniques/${tid}.json`);
      console.log(`    2) Add placeholder to src/layer2/dicts/intents_v0.json:placeholders (short-term only)`);
    }
  }

  console.log('');
  console.log('[kb:check:mapping] Top missing intents (by missingCount):');
  for (const row of report.missingIntentsRanked.slice(0, 10)) {
    console.log(`- ${row.intentId}: missing=${row.missingCount}`);
  }

  if (ci) process.exitCode = 1;
}

main();
