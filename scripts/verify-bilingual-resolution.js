#!/usr/bin/env node
/* eslint-disable no-console */

const {
  readJson,
  stableSortStrings,
  collectTechniqueIds,
  filterWarnings,
  runLookReplicatePipelineWithMockLookSpecs,
} = require("./_utils/lookReplicateVerifyUtils");

function cloneJson(v) {
  return JSON.parse(JSON.stringify(v));
}

function buildTargetLookSpec({ locale }) {
  const base = cloneJson(readJson("fixtures/look_replicator/lookspec_base_coverage_full.json"));
  base.locale = locale;
  base.market = "US";
  base.breakdown = base.breakdown || {};
  base.breakdown.eye = base.breakdown.eye || {};
  base.breakdown.eye.linerDirection = { direction: "up" };
  base.breakdown.lip = base.breakdown.lip || {};
  base.breakdown.lip.finish = "matte";
  return base;
}

function buildSelfieLookSpec({ locale }) {
  const selfie = buildTargetLookSpec({ locale });
  selfie.breakdown.base.finish = "matte";
  selfie.breakdown.base.coverage = "sheer";
  selfie.breakdown.lip.finish = "gloss";
  selfie.breakdown.eye.linerDirection = { direction: "down" };
  return selfie;
}

function macroIds(ids) {
  return stableSortStrings(ids.filter((id) => id.startsWith("US_eye_liner_") || id.startsWith("US_base_fix_") || id.startsWith("US_lip_")));
}

async function main() {
  const locale = "zh-CN";
  const out = await runLookReplicatePipelineWithMockLookSpecs({
    market: "US",
    locale,
    preferenceMode: "structure",
    referenceLookSpec: buildTargetLookSpec({ locale }),
    selfieLookSpec: buildSelfieLookSpec({ locale }),
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
  const fallbackWarnings = filterWarnings(out?.result?.warnings, ["Technique language fallback"]);
  const badLang = macros.filter((id) => id.endsWith("-en"));

  console.log(`ZH_OK macroIds=[${macros.join(",")}] fallbackWarnings=${fallbackWarnings.length}`);

  if (!macros.length) {
    console.error("[FAIL] expected at least one macro id in zh-CN run");
    process.exit(1);
  }
  if (fallbackWarnings.length) {
    console.error("[FAIL] expected no Technique language fallback warnings");
    console.error(JSON.stringify(fallbackWarnings));
    process.exit(1);
  }
  if (badLang.length) {
    console.error("[FAIL] expected all macro ids to resolve to -zh under zh-CN locale");
    console.error(JSON.stringify(badLang));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[FATAL]", e && e.stack ? e.stack : String(e));
  process.exit(1);
});

