const fs = require('fs');
const path = require('path');

const { LlmError } = require('../src/llm/provider');

const { LookSpecV0Schema } = require('../src/layer2/schemas/lookSpecV0');
const { FaceProfileV0Schema } = require('../src/layer1/schemas/faceProfileV0');
const { SimilarityReportV0Schema } = require('../src/layer1/schemas/similarityReportV0');

const { getMarketPack } = require('../src/markets/getMarketPack');
const { loadTechniqueKB } = require('../src/layer2/kb/loadTechniqueKB');
const { loadIntentsV0, getTechniqueIdsForIntent } = require('../src/layer2/dicts/intents');

const { AdjustmentSkeletonV0Schema } = require('../src/layer2/schemas/adjustmentSkeletonV0');
const { generateAdjustments } = require('../src/layer2/personalization/generateAdjustments');
const { renderSkeletonFromKB } = require('../src/layer2/personalization/renderSkeletonFromKB');
const { rephraseAdjustments } = require('../src/layer2/personalization/rephraseAdjustments');
const { generateSteps } = require('../src/layer2/personalization/generateSteps');

function readJsonFromRepo(relPath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8'));
}

function disabledProvider() {
  return {
    analyzeImageToJson: async () => {
      throw new LlmError('LLM_DISABLED', 'Smoke mode uses deterministic fallbacks.');
    },
    analyzeTextToJson: async () => {
      throw new LlmError('LLM_DISABLED', 'Smoke mode uses deterministic fallbacks.');
    },
  };
}

function buildFallbackSkeletonsJP() {
  const dict = loadIntentsV0();

  const baseIds = getTechniqueIdsForIntent('BASE_FALLBACK_THIN_LAYER', 'JP', dict);
  const eyeIds = getTechniqueIdsForIntent('EYE_FALLBACK_SAFE_CONTROL', 'JP', dict);
  const lipIds = getTechniqueIdsForIntent('LIP_FALLBACK_FINISH_FOCUS', 'JP', dict);

  if (!baseIds || !eyeIds || !lipIds) throw new Error('Missing fallback intent mapping for JP.');

  const make = (impactArea, ruleId, doActionIds) =>
    AdjustmentSkeletonV0Schema.parse({
      schemaVersion: 'v0',
      market: 'JP',
      impactArea,
      ruleId,
      severity: 0.2,
      confidence: 'low',
      becauseFacts: ['Smoke run for JP uses deterministic fallback rules.'],
      doActionIds,
      doActions: [],
      whyMechanism: ['A safer default reduces sensitivity to missing inputs.'],
      evidenceKeys: ['smoke.dicts'],
    });

  return [make('base', 'BASE_FALLBACK_THIN_LAYER', baseIds), make('eye', 'EYE_FALLBACK_SAFE_CONTROL', eyeIds), make('lip', 'LIP_FALLBACK_FINISH_FOCUS', lipIds)];
}

async function runForMarket(market, locale) {
  const pack = getMarketPack({ market, locale });
  const provider = disabledProvider();

  const lookSpec = LookSpecV0Schema.parse(readJsonFromRepo(`fixtures/contracts/${market.toLowerCase()}/lookSpecV0.sample.json`));
  const layer1Bundle = readJsonFromRepo('fixtures/contracts/us/layer1BundleV0.sample.json');
  const userFaceProfile = layer1Bundle.userFaceProfile ? FaceProfileV0Schema.parse(layer1Bundle.userFaceProfile) : null;
  const refFaceProfile = layer1Bundle.refFaceProfile ? FaceProfileV0Schema.parse(layer1Bundle.refFaceProfile) : null;
  const similarityReport = layer1Bundle.similarityReport ? SimilarityReportV0Schema.parse(layer1Bundle.similarityReport) : null;

  let adjustmentsOut;
  let skeletons;

  if (market === 'US') {
    adjustmentsOut = await generateAdjustments({
      market,
      locale,
      userFaceProfile,
      refFaceProfile,
      similarityReport,
      lookSpec,
      preferenceMode: 'structure',
      provider,
      promptPack: pack.getPromptPack(locale),
    });
    skeletons = adjustmentsOut.skeletons;
  } else {
    const kb = loadTechniqueKB(market);
    skeletons = buildFallbackSkeletonsJP();
    const rendered = renderSkeletonFromKB(skeletons, kb, { market, lookSpec, preferenceMode: 'structure' });
    const rephrased = await rephraseAdjustments({
      market,
      locale,
      skeletons: rendered.skeletons,
      provider,
      promptPack: pack.getPromptPack(locale),
    });
    adjustmentsOut = { adjustments: rephrased.adjustments, warnings: [...(rendered.warnings || []), ...(rephrased.warnings || [])], usedFallback: true, skeletons: rendered.skeletons };
  }

  const stepsOut = await generateSteps({
    market,
    locale,
    lookSpec,
    adjustments: adjustmentsOut.adjustments,
    userFaceProfile,
    provider,
    promptPack: pack.getPromptPack(locale),
  });

  const ok =
    Array.isArray(adjustmentsOut.adjustments) &&
    adjustmentsOut.adjustments.length === 3 &&
    Array.isArray(stepsOut.steps) &&
    stepsOut.steps.length >= 8 &&
    stepsOut.steps.length <= 12;

  if (!ok) {
    throw new Error(
      `Unexpected smoke output for ${market}: adjustments=${adjustmentsOut.adjustments?.length} steps=${stepsOut.steps?.length}`,
    );
  }

  if (market === 'US' && pack.commerceEnabled !== true) throw new Error('US pack must have commerceEnabled=true');
  if (market === 'JP' && pack.commerceEnabled !== false) throw new Error('JP pack must have commerceEnabled=false');

  return {
    market,
    commerceEnabled: pack.commerceEnabled,
    adjustments: adjustmentsOut.adjustments.length,
    steps: stepsOut.steps.length,
    warnings: (adjustmentsOut.warnings || []).length + (stepsOut.warnings || []).length,
    skeletons: Array.isArray(skeletons) ? skeletons.length : 0,
  };
}

async function main() {
  // Smoke should exercise both markets even if JP is feature-flagged off in production.
  if (!process.env.ENABLE_MARKET_JP) process.env.ENABLE_MARKET_JP = '1';

  const results = [];
  results.push(await runForMarket('US', 'en-US'));
  results.push(await runForMarket('JP', 'ja-JP'));

  for (const r of results) {
    // Keep output concise and deterministic for CI logs.
    console.log(`[smoke:layer2] market=${r.market} commerceEnabled=${r.commerceEnabled} skeletons=${r.skeletons} adjustments=${r.adjustments} steps=${r.steps} warnings=${r.warnings}`);
  }
}

main().catch((err) => {
  console.error('[smoke:layer2] FAILED', err);
  process.exitCode = 1;
});
