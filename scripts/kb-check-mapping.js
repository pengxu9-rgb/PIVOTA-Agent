#!/usr/bin/env node
/* eslint-disable no-console */
const { loadIntentsV0 } = require('../src/layer2/dicts/intents');
const { loadTechniqueKB } = require('../src/layer2/kb/loadTechniqueKB');

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
  npm run kb:check:mapping -- --market JP

Checks:
  - intents_v0.json intent -> techniqueIds mapping for the given market
  - every referenced technique id must exist in the market KB OR be declared in intents_v0.json.placeholders
`);
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const market = normalizeMarket(args.market);
  if (!market) usageAndExit(1);

  const dict = loadIntentsV0();
  const placeholderSet = new Set(Array.isArray(dict.placeholders) ? dict.placeholders : []);
  const kb = loadTechniqueKB(market);
  const kbIds = new Set(kb.list.map((c) => c.id));

  const missing = [];
  const intents = Array.isArray(dict.intents) ? dict.intents : [];

  let totalRefs = 0;
  for (const intent of intents) {
    const bucket = intent?.markets?.[market];
    const techniqueIds = Array.isArray(bucket?.techniqueIds) ? bucket.techniqueIds : [];
    for (const tid of techniqueIds) {
      totalRefs += 1;
      const exists = kbIds.has(tid);
      const isPlaceholder = placeholderSet.has(tid);
      if (!exists && !isPlaceholder) {
        missing.push({ intentId: intent?.id ?? '(unknown)', techniqueId: tid });
      }
    }
  }

  console.log(`[kb:check:mapping] market=${market}`);
  console.log(`[kb:check:mapping] intents=${intents.length} techniqueRefs=${totalRefs} placeholders=${placeholderSet.size} kbCards=${kbIds.size}`);

  if (missing.length === 0) {
    console.log('[kb:check:mapping] OK: no missing technique ids.');
    return;
  }

  console.log(`[kb:check:mapping] ERROR: missing ${missing.length} technique id reference(s):`);
  for (const m of missing) {
    console.log(`- intent=${m.intentId} missingTechniqueId=${m.techniqueId}`);
    console.log(`  Fix options:`);
    console.log(`  1) Create card: src/layer2/kb/${market.toLowerCase()}/techniques/${m.techniqueId}.json`);
    console.log(`  2) Add placeholder to src/layer2/dicts/intents_v0.json:placeholders (short-term only)`);
  }

  process.exitCode = 1;
}

main();

