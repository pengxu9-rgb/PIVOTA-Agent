#!/usr/bin/env node
/* eslint-disable no-console */

const {
  readJson,
  stableSortStrings,
  uniqStrings,
  collectTechniqueIds,
  runLookReplicatePipelineWithMockLookSpecs,
} = require("./_utils/lookReplicateVerifyUtils");

function cloneJson(v) {
  return JSON.parse(JSON.stringify(v));
}

function buildLookSpecNoDirection({ locale }) {
  const base = cloneJson(readJson("fixtures/look_replicator/lookspec_base_coverage_full.json"));
  base.locale = locale;
  base.market = "US";
  base.breakdown = base.breakdown || {};
  base.breakdown.eye = base.breakdown.eye || {};
  delete base.breakdown.eye.linerDirection;
  base.breakdown.lip = base.breakdown.lip || {};
  base.breakdown.lip.finish = "matte";
  return base;
}

function macroIds(ids) {
  return stableSortStrings(ids.filter((id) => id.startsWith("US_eye_liner_") || id.startsWith("US_base_fix_") || id.startsWith("US_lip_")));
}

async function main() {
  const locale = "en-US";
  const referenceLookSpec = buildLookSpecNoDirection({ locale });
  const selfieLookSpec = buildLookSpecNoDirection({ locale }); // needsChange=false

  const runs = 5;
  const seen = new Set();
  let example = [];

  for (let i = 0; i < runs; i++) {
    const out = await runLookReplicatePipelineWithMockLookSpecs({
      market: "US",
      locale,
      preferenceMode: "structure",
      referenceLookSpec,
      selfieLookSpec,
      enableSelfieLookSpec: true,
      env: {
        LAYER2_ENABLE_SELFIE_LOOKSPEC: "1",
        LAYER2_ENABLE_TRIGGER_MATCHING: "1",
        LAYER2_ENABLE_EYE_ACTIVITY_SLOT: "1",
        LAYER2_ENABLE_BASE_ACTIVITY_SLOT: "1",
        LAYER2_ENABLE_LIP_ACTIVITY_SLOT: "1",
        LAYER2_ENABLE_EXTENDED_AREAS: "0",
        LAYER2_TRIGGER_MATCH_DEBUG: "0",
      },
    });

    const ids = collectTechniqueIds(out);
    const macros = macroIds(ids);
    example = macros;
    seen.add(JSON.stringify(macros));
  }

  const macroIdsSetSize = seen.size;
  console.log(`STABLE_OK runs=${runs} macroIdsSetSize=${macroIdsSetSize} macroIdsExample=[${example.join(",")}]`);

  if (macroIdsSetSize !== 1) {
    console.error("[FAIL] expected stable macroIds across runs");
    process.exit(1);
  }

  if (example.length) {
    console.error("[FAIL] expected macroIds to be empty when linerDirection missing and needsChange=false");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[FATAL]", e && e.stack ? e.stack : String(e));
  process.exit(1);
});

