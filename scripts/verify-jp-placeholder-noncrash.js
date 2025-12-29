#!/usr/bin/env node
/* eslint-disable no-console */

const path = require("node:path");

const { repoRoot, filterWarnings } = require("./_utils/lookReplicateVerifyUtils");

function main() {
  const { loadTechniqueKB } = require(path.join(repoRoot(), "src", "layer2", "kb", "loadTechniqueKB"));
  const { renderSkeletonFromKB } = require(path.join(repoRoot(), "src", "layer2", "personalization", "renderSkeletonFromKB"));
  const { AdjustmentSkeletonV0Schema } = require(path.join(repoRoot(), "src", "layer2", "schemas", "adjustmentSkeletonV0"));

  const kb = loadTechniqueKB("JP");
  const expected = [
    "PLACEHOLDER_JP_EYE_LINER_ACTIVITY_PICK",
    "PLACEHOLDER_JP_BASE_ACTIVITY_PICK",
    "PLACEHOLDER_JP_LIP_ACTIVITY_PICK",
  ];

  const missingInKb = expected.filter((id) => !kb.byId.has(id));
  if (missingInKb.length) {
    console.error("[FAIL] JP placeholder technique cards missing from KB:");
    console.error(JSON.stringify(missingInKb));
    process.exit(1);
  }

  const skeletons = [
    AdjustmentSkeletonV0Schema.parse({
      schemaVersion: "v0",
      market: "JP",
      impactArea: "base",
      ruleId: "VERIFY_JP_BASE_PLACEHOLDER",
      severity: 0.1,
      confidence: "low",
      becauseFacts: ["verify JP base placeholder renders"],
      doActionSelection: "sequence",
      doActionIds: ["PLACEHOLDER_JP_BASE_ACTIVITY_PICK"],
      doActions: [],
      whyMechanism: ["verify placeholder card is present and renderable"],
      evidenceKeys: ["verify:PLACEHOLDER_JP_BASE_ACTIVITY_PICK"],
      tags: ["verify"],
    }),
    AdjustmentSkeletonV0Schema.parse({
      schemaVersion: "v0",
      market: "JP",
      impactArea: "eye",
      ruleId: "VERIFY_JP_EYE_PLACEHOLDER",
      severity: 0.1,
      confidence: "low",
      becauseFacts: ["verify JP eye placeholder renders"],
      doActionSelection: "sequence",
      doActionIds: ["PLACEHOLDER_JP_EYE_LINER_ACTIVITY_PICK"],
      doActions: [],
      whyMechanism: ["verify placeholder card is present and renderable"],
      evidenceKeys: ["verify:PLACEHOLDER_JP_EYE_LINER_ACTIVITY_PICK"],
      tags: ["verify"],
    }),
    AdjustmentSkeletonV0Schema.parse({
      schemaVersion: "v0",
      market: "JP",
      impactArea: "lip",
      ruleId: "VERIFY_JP_LIP_PLACEHOLDER",
      severity: 0.1,
      confidence: "low",
      becauseFacts: ["verify JP lip placeholder renders"],
      doActionSelection: "sequence",
      doActionIds: ["PLACEHOLDER_JP_LIP_ACTIVITY_PICK"],
      doActions: [],
      whyMechanism: ["verify placeholder card is present and renderable"],
      evidenceKeys: ["verify:PLACEHOLDER_JP_LIP_ACTIVITY_PICK"],
      tags: ["verify"],
    }),
  ];

  const rendered = renderSkeletonFromKB(skeletons, kb, {
    market: "JP",
    locale: "ja-JP",
    preferenceMode: "structure",
    lookSpec: { breakdown: { base: {}, eye: {}, lip: {} } },
  });

  const warnings = Array.isArray(rendered?.warnings) ? rendered.warnings : [];
  const missingCardWarnings = filterWarnings(warnings, ["Missing technique card", "market mismatch", "area mismatch"]);

  console.log(`JP_OK warnings=${warnings.length} missingCardWarnings=${missingCardWarnings.length}`);

  if (missingCardWarnings.length) {
    console.error("[FAIL] unexpected JP missing/mismatch warnings:");
    console.error(JSON.stringify(missingCardWarnings));
    process.exit(1);
  }
}

main();

