#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_SHARED_CORPUS_PATH,
  buildProdCanaryView,
  buildProdGateView,
  buildPromptLiveSmokeView,
  buildStagingAcceptanceMatrixView,
} = require('./lib/commerce_shared_acceptance_views');

function parseArgs(argv) {
  const fixturesDir = path.join(__dirname, 'fixtures');
  const args = {
    corpusPath: process.env.CORPUS_PATH || DEFAULT_SHARED_CORPUS_PATH,
    prodGatePath:
      process.env.PROD_GATE_PATH ||
      path.join(fixturesDir, 'celestial_commerce_core_prod_gate.json'),
    prodCanaryPath:
      process.env.PROD_CANARY_PATH ||
      path.join(fixturesDir, 'celestial_commerce_core_prod_canary.json'),
    stagingPath:
      process.env.STAGING_MATRIX_PATH ||
      path.join(fixturesDir, 'celestial_commerce_core_staging_acceptance_matrix.json'),
    promptPath:
      process.env.PROMPT_LIVE_SMOKE_PATH ||
      path.join(fixturesDir, 'celestial_commerce_core_prompt_live_smoke.json'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    const next = argv[index + 1];
    if (token === '--corpus' && next) args.corpusPath = path.resolve(String(next));
    if (token === '--prod-gate' && next) args.prodGatePath = path.resolve(String(next));
    if (token === '--prod-canary' && next) args.prodCanaryPath = path.resolve(String(next));
    if (token === '--staging' && next) args.stagingPath = path.resolve(String(next));
    if (token === '--prompt' && next) args.promptPath = path.resolve(String(next));
  }

  return args;
}

function writeJson(outputPath, payload) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const prodGate = buildProdGateView(args.corpusPath);
  const prodCanary = buildProdCanaryView(args.corpusPath);
  const stagingMatrix = buildStagingAcceptanceMatrixView(args.corpusPath);
  const promptLiveSmoke = buildPromptLiveSmokeView(args.corpusPath);

  writeJson(args.prodGatePath, prodGate);
  writeJson(args.prodCanaryPath, prodCanary);
  writeJson(args.stagingPath, stagingMatrix);
  writeJson(args.promptPath, promptLiveSmoke);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        corpus: args.corpusPath,
        prod_gate: { path: args.prodGatePath, count: prodGate.length },
        prod_canary: { path: args.prodCanaryPath, count: prodCanary.length },
        staging_matrix: {
          path: args.stagingPath,
          semantic_count: stagingMatrix.semantic_cases.length,
          governance_count: stagingMatrix.governance_cases.length,
        },
        prompt_live_smoke: {
          path: args.promptPath,
          count: Array.isArray(promptLiveSmoke.prompt_cases) ? promptLiveSmoke.prompt_cases.length : 0,
        },
      },
      null,
      2,
    )}\n`,
  );
}

main();
