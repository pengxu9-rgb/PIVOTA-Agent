const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function writeTempJpeg() {
  const p = path.join(os.tmpdir(), `pivota-lookrep-e2e-${process.pid}-${Date.now()}.jpg`);
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // minimal JPEG markers
  return p;
}

function readJson(relPathFromRepoRoot) {
  const abs = path.join(__dirname, "..", "..", relPathFromRepoRoot);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function stableSort(list) {
  return [...list].sort((a, b) => String(a).localeCompare(String(b)));
}

function collectTechniqueRefs(telemetrySample) {
  const skeletons = telemetrySample?.replayContext?.adjustmentSkeletons || [];
  const ids = [];
  for (const s of skeletons) {
    const refs = Array.isArray(s?.techniqueRefs) ? s.techniqueRefs : [];
    for (const r of refs) {
      const id = String(r?.id || "").trim();
      if (id) ids.push(id);
    }
  }
  return stableSort(Array.from(new Set(ids)));
}

function collectUsedTechniqueIds(telemetrySample) {
  const used = Array.isArray(telemetrySample?.usedTechniques) ? telemetrySample.usedTechniques : [];
  const ids = used.map((t) => String(t?.id || "").trim()).filter(Boolean);
  return stableSort(Array.from(new Set(ids)));
}

function summarizePipelineSelection(telemetrySample) {
  const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
    ? telemetrySample.replayContext.adjustmentSkeletons
    : [];

  const byArea = skeletons
    .map((s) => ({
      impactArea: String(s?.impactArea || ""),
      ruleId: String(s?.ruleId || ""),
      doActionIds: stableSort((Array.isArray(s?.doActionIds) ? s.doActionIds : []).map(String)),
      techniqueRefs: stableSort(
        (Array.isArray(s?.techniqueRefs) ? s.techniqueRefs : [])
          .map((r) => String(r?.id || ""))
          .filter(Boolean)
      ),
    }))
    .sort((a, b) => a.impactArea.localeCompare(b.impactArea) || a.ruleId.localeCompare(b.ruleId));

  return {
    usedRules: stableSort(
      (Array.isArray(telemetrySample?.usedRules) ? telemetrySample.usedRules : [])
        .map((r) => `${String(r?.area || "")}:${String(r?.ruleId || "")}`)
        .filter((s) => s !== ":")
    ),
    usedTechniques: collectUsedTechniqueIds(telemetrySample),
    skeletons: byArea,
  };
}

function loadIntentsReferencedIdsUS() {
  const intents = readJson("src/layer2/dicts/intents_v0.json");
  const out = new Set();
  for (const it of Array.isArray(intents?.intents) ? intents.intents : []) {
    const m = it?.markets?.US;
    const techniqueIds = Array.isArray(m?.techniqueIds) ? m.techniqueIds : [];
    for (const tid of techniqueIds) out.add(String(tid));
  }
  return out;
}

function buildFailureDiagnostic({ name, expectedActivityIds, telemetrySample }) {
  const referenced = loadIntentsReferencedIdsUS();
  const techniqueRefs = collectTechniqueRefs(telemetrySample);
  const usedTechniques = collectUsedTechniqueIds(telemetrySample);

  const referencedUsed = usedTechniques.filter((id) => referenced.has(id));
  const unreferencedUsed = usedTechniques.filter((id) => !referenced.has(id));

  const impacts = stableSort(
    (telemetrySample?.replayContext?.adjustmentSkeletons || []).map((s) => String(s?.impactArea || "")).filter(Boolean)
  );

  const summary = summarizePipelineSelection(telemetrySample);

  return [
    `E2E activity card reachability failed: ${name}`,
    `expected_any=${expectedActivityIds.join(",")}`,
    `impactAreas=${impacts.join(",") || "(none)"}`,
    `techniqueRefs_rendered=${techniqueRefs.join(",") || "(none)"}`,
    `usedTechniques=${usedTechniques.join(",") || "(none)"}`,
    `usedTechniques_in_intents=${referencedUsed.join(",") || "(none)"}`,
    `usedTechniques_NOT_in_intents=${unreferencedUsed.join(",") || "(none)"}`,
    `selected_rules=${summary.usedRules.join(",") || "(none)"}`,
    `skeletons=${JSON.stringify(summary.skeletons, null, 2)}`,
  ].join("\n");
}

async function runPipelineWithFixture({ locale, lookSpecFixturePath, enableExtendedAreas }) {
  const referenceImagePath = writeTempJpeg();
  const envBackup = { ...process.env };

  try {
    const lookSpec = readJson(lookSpecFixturePath);
    const layer1Bundle = readJson("fixtures/contracts/us/layer1BundleV0.sample.json");

    process.env.API_MODE = "MOCK";
    process.env.PIVOTA_API_KEY = "";
    process.env.OPENAI_API_KEY = "";
    process.env.GEMINI_API_KEY = "";
    process.env.PIVOTA_GEMINI_API_KEY = "";
    process.env.GOOGLE_API_KEY = "";
    process.env.ENABLE_STARTER_KB = "0";
    process.env.EXPERIMENT_MORE_CANDIDATES_ENABLED = "0";
    process.env.LAYER2_ENABLE_EXTENDED_AREAS = enableExtendedAreas ? "1" : "0";

    let runLookReplicatePipeline = null;
    await new Promise((resolve, reject) => {
      jest.isolateModules(() => {
        try {
          jest.doMock("../../src/layer2/extractLookSpec", () => ({
            extractLookSpec: async () => lookSpec,
          }));
          ({ runLookReplicatePipeline } = require("../../src/lookReplicator/lookReplicatePipeline"));
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    return await runLookReplicatePipeline({
      market: "US",
      locale,
      preferenceMode: "structure",
      jobId: `e2e_${locale}`,
      referenceImage: { path: referenceImagePath, contentType: "image/jpeg" },
      layer1Bundle,
    });
  } finally {
    process.env = envBackup;
    fs.rmSync(referenceImagePath, { force: true });
  }
}

describe("look-replicator activity cards reachability (production path)", () => {
  test("EN: eye-liner activity techniques are rendered via intents_v0.json", async () => {
    const expected = [
      "US_eye_liner_daily_upwing_01-en",
      "US_eye_liner_winged_western_01-en",
      "US_eye_liner_light_mixed_01-en",
    ];

    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_up.json",
    });

    const telemetrySample = out?.telemetrySample;
    const techniqueRefs = collectTechniqueRefs(telemetrySample);
    const found = expected.filter((id) => techniqueRefs.includes(id));

    if (!found.length) {
      throw new Error(buildFailureDiagnostic({ name: "EN/eye-liner", expectedActivityIds: expected, telemetrySample }));
    }
  });

  test("ZH: eye-liner activity techniques resolve to -zh via locale", async () => {
    const expected = [
      "US_eye_liner_daily_upwing_01-zh",
      "US_eye_liner_winged_western_01-zh",
      "US_eye_liner_light_mixed_01-zh",
    ];

    const out = await runPipelineWithFixture({
      locale: "zh-CN",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_up.json",
    });

    const telemetrySample = out?.telemetrySample;
    const techniqueRefs = collectTechniqueRefs(telemetrySample);
    const found = expected.filter((id) => techniqueRefs.includes(id));

    if (!found.length) {
      throw new Error(buildFailureDiagnostic({ name: "ZH/eye-liner", expectedActivityIds: expected, telemetrySample }));
    }
  });

  test("EN: base-fix + lip-shaping activity techniques are rendered via intents_v0.json", async () => {
    const baseExpected = ["US_base_fix_caking_01-en", "US_base_fix_floating_powder_01-en"];
    const lipExpected = ["US_lip_thin_lower_fuller_01-en", "US_lip_flat_lips_define_01-en"];

    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_base_coverage_full.json",
    });

    const telemetrySample = out?.telemetrySample;
    const techniqueRefs = collectTechniqueRefs(telemetrySample);
    const baseFound = baseExpected.filter((id) => techniqueRefs.includes(id));
    const lipFound = lipExpected.filter((id) => techniqueRefs.includes(id));

    if (!baseFound.length) {
      throw new Error(buildFailureDiagnostic({ name: "EN/base-fix", expectedActivityIds: baseExpected, telemetrySample }));
    }
    if (!lipFound.length) {
      throw new Error(buildFailureDiagnostic({ name: "EN/lip-shaping", expectedActivityIds: lipExpected, telemetrySample }));
    }
  });

  test("ZH: base-fix + lip-shaping activity techniques resolve to -zh via locale", async () => {
    const baseExpected = ["US_base_fix_caking_01-zh", "US_base_fix_floating_powder_01-zh"];
    const lipExpected = ["US_lip_thin_lower_fuller_01-zh", "US_lip_flat_lips_define_01-zh"];

    const out = await runPipelineWithFixture({
      locale: "zh-CN",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_base_coverage_full.json",
    });

    const telemetrySample = out?.telemetrySample;
    const techniqueRefs = collectTechniqueRefs(telemetrySample);
    const baseFound = baseExpected.filter((id) => techniqueRefs.includes(id));
    const lipFound = lipExpected.filter((id) => techniqueRefs.includes(id));

    if (!baseFound.length) {
      throw new Error(buildFailureDiagnostic({ name: "ZH/base-fix", expectedActivityIds: baseExpected, telemetrySample }));
    }
    if (!lipFound.length) {
      throw new Error(buildFailureDiagnostic({ name: "ZH/lip-shaping", expectedActivityIds: lipExpected, telemetrySample }));
    }
  });

  test("EN: extended areas render at least one activity technique when flag enabled", async () => {
    const expected = [
      "US_prep_primer_01-en",
      "US_prep_skincare_prep_steps_01-en",
      "US_contour_nose_soft_shadow_01-en",
      "US_brow_five_point_mapping_01-en",
      "US_blush_soft_diffuse_01-en",
    ];

    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_base_coverage_full.json",
      enableExtendedAreas: true,
    });

    const telemetrySample = out?.telemetrySample;
    const techniqueRefs = collectTechniqueRefs(telemetrySample);
    const found = expected.filter((id) => techniqueRefs.includes(id));

    if (!found.length) {
      throw new Error(buildFailureDiagnostic({ name: "EN/extended-areas", expectedActivityIds: expected, telemetrySample }));
    }
  });

  test("ZH: extended areas resolve to -zh via locale when flag enabled", async () => {
    const expected = [
      "US_prep_primer_01-zh",
      "US_prep_skincare_prep_steps_01-zh",
      "US_contour_nose_soft_shadow_01-zh",
      "US_brow_five_point_mapping_01-zh",
      "US_blush_soft_diffuse_01-zh",
    ];

    const out = await runPipelineWithFixture({
      locale: "zh-CN",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_base_coverage_full.json",
      enableExtendedAreas: true,
    });

    const telemetrySample = out?.telemetrySample;
    const techniqueRefs = collectTechniqueRefs(telemetrySample);
    const found = expected.filter((id) => techniqueRefs.includes(id));

    if (!found.length) {
      throw new Error(buildFailureDiagnostic({ name: "ZH/extended-areas", expectedActivityIds: expected, telemetrySample }));
    }
  });
});
