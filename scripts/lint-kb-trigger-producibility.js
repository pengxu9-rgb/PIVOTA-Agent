#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');

const { loadTechniqueKB } = require('../src/layer2/kb/loadTechniqueKB');
const { isTriggerKeyAllowed } = require('../src/layer2/dicts/triggerKeys');

const { LookSpecV0Schema } = require('../src/layer2/schemas/lookSpecV0');
const { LookSpecV1Schema } = require('../src/layer2/schemas/lookSpecV1');
const { FaceProfileV0Schema } = require('../src/layer1/schemas/faceProfileV0');
const { SimilarityReportV0Schema } = require('../src/layer1/schemas/similarityReportV0');

const { parseAllowlist, buildTriggerProducibilityReport } = require('../src/layer2/kb/triggerProducibility');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const s = String(argv[i] || '');
    if (!s) continue;
    if (!s.startsWith('--')) {
      out._.push(s);
      continue;
    }
    const m = s.match(/^--([^=]+)=(.*)$/);
    if (m) {
      out[m[1]] = m[2];
      continue;
    }
    const k = s.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[k] = next;
      i += 1;
    } else {
      out[k] = true;
    }
  }
  return out;
}

function parseEnvBool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return null;
}

function readAllowlistDict() {
  const filePath = path.join(__dirname, '..', 'src', 'layer2', 'dicts', 'trigger_producibility_allowlist_v0.json');
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return parseAllowlist(raw);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const market = String(args.market || args.m || args._[0] || '').trim().toUpperCase();
  if (market !== 'US' && market !== 'JP') {
    throw new Error('Usage: node scripts/lint-kb-trigger-producibility.js --market US|JP [--json] [--strict] [--include-starter]');
  }

  const strict = args.strict === true || String(args.strict || '').trim() === '1';
  const includeStarter =
    args['include-starter'] === true ||
    args.includeStarter === true ||
    String(args.includeStarter || '').trim() === '1' ||
    parseEnvBool(process.env.ENABLE_STARTER_KB) === true;

  // Default to production-like behavior (starter off) unless explicitly enabled.
  process.env.ENABLE_STARTER_KB = includeStarter ? '1' : '0';

  const kb = loadTechniqueKB(market);
  const allowUnproducibleKeys = readAllowlistDict();

  const rootSchemas = {
    lookSpec: [LookSpecV0Schema, LookSpecV1Schema],
    userFaceProfile: [FaceProfileV0Schema],
    refFaceProfile: [FaceProfileV0Schema],
    similarityReport: [SimilarityReportV0Schema],
  };

  const report = buildTriggerProducibilityReport({
    market,
    kbCards: kb.list,
    isTriggerKeyAllowed,
    allowUnproducibleKeys,
    rootSchemas,
  });

  const asJson = args.json === true || String(args.json || '').trim() === '1';
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`=== KB Trigger Producibility (${market}) ===`);
    console.log(`starter_kb_included=${includeStarter ? 'true' : 'false'}`);
    console.log(
      `summary kb=${report.summary.kbCardCount} cardsWithTriggers=${report.summary.cardsWithTriggers} uniqueKeys=${report.summary.uniqueTriggerKeys} unproducibleKeys=${report.summary.unproducibleKeysCount} cardsAffected=${report.summary.cardsAffectedCount}`,
    );
    if (report.unproducibleKeys.length) {
      console.log('unproducible_keys (top 20):');
      for (const it of report.unproducibleKeys.slice(0, 20)) {
        console.log(`- ${it.key} (${it.reason}) cards=${it.cards.length}`);
      }
    }
  }

  if (strict && report.summary.unproducibleKeysCount > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(String(err?.stack || err?.message || err));
    process.exitCode = 1;
  }
}
