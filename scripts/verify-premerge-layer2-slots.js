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

function withExtendedAreaIntents(lookSpec, { prepIntent, contourIntent, browIntent, blushIntent }) {
  const out = cloneJson(lookSpec);
  out.breakdown = out.breakdown || {};

  const mk = (intent) => ({
    intent: String(intent || "unknown"),
    finish: "unknown",
    coverage: "unknown",
    keyNotes: [],
    evidence: [],
  });

  out.breakdown.prep = mk(prepIntent);
  out.breakdown.contour = mk(contourIntent);
  out.breakdown.brow = mk(browIntent);
  out.breakdown.blush = mk(blushIntent);
  return out;
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

function findSkeleton(telemetrySample, ruleId) {
  const skels = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
    ? telemetrySample.replayContext.adjustmentSkeletons
    : [];
  return skels.find((s) => String(s?.ruleId || "") === ruleId) || null;
}

function skeletonTechniqueRefIds(skeleton) {
  const refs = Array.isArray(skeleton?.techniqueRefs) ? skeleton.techniqueRefs : [];
  return stableSortStrings(refs.map((r) => String(r?.id || "")).filter(Boolean));
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

async function runExtendedAreasCase({ name, needsChange }) {
  const locale = "en-US";

  const target = withExtendedAreaIntents(buildTargetLookSpec({ locale, includeEyeDirection: false }), {
    prepIntent: "target_prep",
    contourIntent: "target_contour",
    browIntent: "target_brow",
    blushIntent: "target_blush",
  });

  const selfie = withExtendedAreaIntents(buildTargetLookSpec({ locale, includeEyeDirection: false }), {
    prepIntent: needsChange ? "user_prep" : "target_prep",
    contourIntent: needsChange ? "user_contour" : "target_contour",
    browIntent: needsChange ? "user_brow" : "target_brow",
    blushIntent: needsChange ? "user_blush" : "target_blush",
  });

  const out = await runLookReplicatePipelineWithMockLookSpecs({
    market: "US",
    locale,
    preferenceMode: "structure",
    referenceLookSpec: target,
    selfieLookSpec: selfie,
    enableSelfieLookSpec: true,
    env: {
      LAYER2_ENABLE_SELFIE_LOOKSPEC: "1",
      LAYER2_ENABLE_TRIGGER_MATCHING: "1",
      LAYER2_ENABLE_EXTENDED_AREAS: "1",
      LAYER2_ENABLE_EYE_ACTIVITY_SLOT: "0",
      LAYER2_ENABLE_BASE_ACTIVITY_SLOT: "0",
      LAYER2_ENABLE_LIP_ACTIVITY_SLOT: "0",
      LAYER2_TRIGGER_MATCH_DEBUG: "0",
    },
  });

  const ts = out?.telemetrySample;
  const prepSlot = findSkeleton(ts, "PREP_ACTIVITY_SLOT");
  const contourSlot = findSkeleton(ts, "CONTOUR_ACTIVITY_SLOT");
  const browSlot = findSkeleton(ts, "BROW_ACTIVITY_SLOT");
  const blushSlot = findSkeleton(ts, "BLUSH_ACTIVITY_SLOT");

  const prepMicro = findSkeleton(ts, "PREP_FALLBACK_SAFE");
  const contourMicro = findSkeleton(ts, "CONTOUR_FALLBACK_SAFE");
  const browMicro = findSkeleton(ts, "BROW_FALLBACK_SAFE");
  const blushMicro = findSkeleton(ts, "BLUSH_FALLBACK_SAFE");

  const slotIds = uniqStrings([
    ...skeletonTechniqueRefIds(prepSlot),
    ...skeletonTechniqueRefIds(contourSlot),
    ...skeletonTechniqueRefIds(browSlot),
    ...skeletonTechniqueRefIds(blushSlot),
  ]);

  console.log(
    `CASE=${name} locale=${locale} market=US needsChange=${needsChange} extendedAreaSlotIds=[${slotIds.join(",")}]`,
  );

  const slotsPresent = Boolean(prepSlot || contourSlot || browSlot || blushSlot);
  const microsPresent = Boolean(prepMicro || contourMicro || browMicro || blushMicro);

  if (!needsChange) {
    if (slotsPresent || microsPresent) {
      console.error(`[FAIL] CASE=${name} expected no extended-area micro/slot skeletons when needsChange=false`);
      printFailureDiagnostic({ out });
      return { ok: false };
    }
    return { ok: true };
  }

  const requiredSlots = [
    ["PREP_ACTIVITY_SLOT", prepSlot],
    ["CONTOUR_ACTIVITY_SLOT", contourSlot],
    ["BROW_ACTIVITY_SLOT", browSlot],
    ["BLUSH_ACTIVITY_SLOT", blushSlot],
  ];
  const missingSlots = requiredSlots.filter(([, s]) => !s).map(([id]) => id);
  if (missingSlots.length) {
    console.error(`[FAIL] CASE=${name} missing extended-area slots: ${missingSlots.join(",")}`);
    printFailureDiagnostic({ out });
    return { ok: false };
  }

  const requiredMicros = [
    ["PREP_FALLBACK_SAFE", prepMicro],
    ["CONTOUR_FALLBACK_SAFE", contourMicro],
    ["BROW_FALLBACK_SAFE", browMicro],
    ["BLUSH_FALLBACK_SAFE", blushMicro],
  ];
  const missingMicros = requiredMicros.filter(([, s]) => !s).map(([id]) => id);
  if (missingMicros.length) {
    console.error(`[FAIL] CASE=${name} missing extended-area micros: ${missingMicros.join(",")}`);
    printFailureDiagnostic({ out });
    return { ok: false };
  }

  for (const [rid, s] of requiredSlots) {
    const ids = skeletonTechniqueRefIds(s);
    if (ids.length !== 1) {
      console.error(`[FAIL] CASE=${name} ${rid} expected exactly 1 techniqueRef (got ${ids.length})`);
      printFailureDiagnostic({ out });
      return { ok: false };
    }
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

  for (const c of [
    { name: "E_EXTENDED_AREAS_needsChange_true", needsChange: true },
    { name: "F_EXTENDED_AREAS_needsChange_false", needsChange: false },
  ]) {
    const r = await runExtendedAreasCase(c);
    if (!r.ok) failed = true;
  }

  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error("[FATAL]", e && e.stack ? e.stack : String(e));
  process.exit(1);
});
