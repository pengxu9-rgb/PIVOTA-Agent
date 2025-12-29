#!/usr/bin/env node
/* eslint-disable no-console */

const {
  readJson,
  stableSortStrings,
  uniqStrings,
  collectTechniqueIds,
  summarizeSkeletons,
  filterWarnings,
  runLookReplicatePipelineWithMockLookSpecs,
} = require("./_utils/lookReplicateVerifyUtils");

function cloneJson(v) {
  return JSON.parse(JSON.stringify(v));
}

function buildTargetLookSpec({ locale, includeEyeDirection }) {
  const base = cloneJson(readJson("fixtures/look_replicator/lookspec_base_coverage_full.json"));
  base.locale = locale;
  base.market = "US";

  base.breakdown = base.breakdown || {};
  base.breakdown.eye = base.breakdown.eye || {};
  if (includeEyeDirection) base.breakdown.eye.linerDirection = { direction: "up" };
  else delete base.breakdown.eye.linerDirection;

  base.breakdown.lip = base.breakdown.lip || {};
  base.breakdown.lip.finish = "matte";

  return base;
}

function buildSelfieLookSpec({ locale, needsChange, includeEyeDirection }) {
  const selfie = buildTargetLookSpec({ locale, includeEyeDirection });
  if (!needsChange) return selfie;

  selfie.breakdown.base.finish = "matte";
  selfie.breakdown.base.coverage = "sheer";
  selfie.breakdown.lip.finish = "gloss";
  if (includeEyeDirection) selfie.breakdown.eye.linerDirection = { direction: "down" };
  return selfie;
}

function classifyMacroIds(ids) {
  const macroEye = ids.filter((id) => id.startsWith("US_eye_liner_"));
  const macroBase = ids.filter((id) => id.startsWith("US_base_fix_"));
  const macroLip = ids.filter((id) => id.startsWith("US_lip_"));
  return {
    macroEye: stableSortStrings(macroEye),
    macroBase: stableSortStrings(macroBase),
    macroLip: stableSortStrings(macroLip),
    macroAll: stableSortStrings([...macroEye, ...macroBase, ...macroLip]),
  };
}

function countMicros(ids) {
  return {
    microEyeCount: ids.filter((id) => id.startsWith("T_EYE_")).length,
    microBaseCount: ids.filter((id) => id.startsWith("T_BASE_")).length,
    microLipCount: ids.filter((id) => id.startsWith("T_LIP_")).length,
  };
}

function printFailureDiagnostic({ out }) {
  const warningPatterns = ["[trigger_match]", "Technique language fallback", "NO_CANDIDATES", "Missing technique card"];
  const warnings = filterWarnings(out?.result?.warnings, warningPatterns);
  const skeletons = summarizeSkeletons(out);
  console.error("DIAG warnings=" + JSON.stringify(warnings));
  console.error("DIAG skeletons=" + JSON.stringify(skeletons));
}

async function runCase({ name, enableTriggerMatching, enableSlots, needsChange }) {
  const locale = "en-US";
  const includeEyeDirection = name === "D";
  const targetLookSpec = buildTargetLookSpec({ locale, includeEyeDirection });
  const selfieLookSpec = buildSelfieLookSpec({ locale, needsChange, includeEyeDirection });

  const out = await runLookReplicatePipelineWithMockLookSpecs({
    market: "US",
    locale,
    preferenceMode: "structure",
    referenceLookSpec: targetLookSpec,
    selfieLookSpec,
    enableSelfieLookSpec: true,
    env: {
      LAYER2_ENABLE_SELFIE_LOOKSPEC: "1",
      LAYER2_ENABLE_TRIGGER_MATCHING: enableTriggerMatching ? "1" : "0",
      LAYER2_ENABLE_EYE_ACTIVITY_SLOT: enableSlots ? "1" : "0",
      LAYER2_ENABLE_BASE_ACTIVITY_SLOT: enableSlots ? "1" : "0",
      LAYER2_ENABLE_LIP_ACTIVITY_SLOT: enableSlots ? "1" : "0",
      LAYER2_ENABLE_EXTENDED_AREAS: "0",
      LAYER2_TRIGGER_MATCH_DEBUG: "0",
    },
  });

  const techniqueIds = collectTechniqueIds(out);
  const macros = classifyMacroIds(techniqueIds);
  const micros = countMicros(techniqueIds);

  console.log(
    `CASE=${name} locale=${locale} market=US needsChange=${needsChange} macroIds=[${macros.macroAll.join(",")}] microEyeCount=${micros.microEyeCount} microBaseCount=${micros.microBaseCount} microLipCount=${micros.microLipCount}`,
  );

  const expectedMacroEmpty = ["A", "B", "C"].includes(name);
  if (expectedMacroEmpty && macros.macroAll.length) {
    console.error(`[FAIL] CASE=${name} expected macroIds empty`);
    printFailureDiagnostic({ out });
    return { ok: false };
  }

  if (!expectedMacroEmpty && !macros.macroAll.length) {
    console.error(`[FAIL] CASE=${name} expected macroIds non-empty`);
    printFailureDiagnostic({ out });
    return { ok: false };
  }

  if (!expectedMacroEmpty) {
    const tooManyPerArea = macros.macroEye.length > 1 || macros.macroBase.length > 1 || macros.macroLip.length > 1;
    if (tooManyPerArea) {
      console.error(
        `[FAIL] CASE=${name} expected <=1 macro per area (eye=${macros.macroEye.length}, base=${macros.macroBase.length}, lip=${macros.macroLip.length})`,
      );
      printFailureDiagnostic({ out });
      return { ok: false };
    }
  }

  if (micros.microEyeCount < 1 || micros.microBaseCount < 1 || micros.microLipCount < 1) {
    console.error(
      `[FAIL] CASE=${name} expected micro counts >=1 (eye=${micros.microEyeCount}, base=${micros.microBaseCount}, lip=${micros.microLipCount})`,
    );
    printFailureDiagnostic({ out });
    return { ok: false };
  }

  return { ok: true };
}

async function main() {
  const cases = [
    { name: "A", enableTriggerMatching: false, enableSlots: true, needsChange: true },
    { name: "B", enableTriggerMatching: true, enableSlots: false, needsChange: true },
    { name: "C", enableTriggerMatching: true, enableSlots: true, needsChange: false },
    { name: "D", enableTriggerMatching: true, enableSlots: true, needsChange: true },
  ];

  let failed = false;
  for (const c of cases) {
    const r = await runCase(c);
    if (!r.ok) failed = true;
  }

  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error("[FATAL]", e && e.stack ? e.stack : String(e));
  process.exit(1);
});
