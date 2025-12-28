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

function collectResultTechniqueIds(result) {
  const refs = Array.isArray(result?.techniqueRefs) ? result.techniqueRefs : [];
  const ids = refs.map((r) => String(r?.id || "").trim()).filter(Boolean);
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

async function runPipelineWithFixture({
  locale,
  lookSpecFixturePath,
  lookSpecOverride,
  enableExtendedAreas,
  enableTriggerMatching,
  enableEyeActivitySlot,
  preferenceMode,
}) {
  const referenceImagePath = writeTempJpeg();
  const envBackup = { ...process.env };

  try {
    const lookSpec = lookSpecOverride ?? readJson(lookSpecFixturePath);
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
    process.env.LAYER2_ENABLE_TRIGGER_MATCHING = enableTriggerMatching ? "1" : "0";
    if (typeof enableEyeActivitySlot === "boolean") {
      process.env.LAYER2_ENABLE_EYE_ACTIVITY_SLOT = enableEyeActivitySlot ? "1" : "0";
    } else {
      delete process.env.LAYER2_ENABLE_EYE_ACTIVITY_SLOT;
    }

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
      preferenceMode: preferenceMode ?? "structure",
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
	  test("EN: eye-liner micro steps stay sequence; macro slot is NOT emitted when matching is OFF", async () => {
	    const out = await runPipelineWithFixture({
	      locale: "en-US",
	      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_up.json",
	      enableTriggerMatching: false,
      enableEyeActivitySlot: true,
    });

    const telemetrySample = out?.telemetrySample;
    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    const allSkeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];

    const eyeMain = allSkeletons.find((s) => String(s?.ruleId || "") === "EYE_LINER_DIRECTION_ADAPT");
    if (!eyeMain) {
      throw new Error(buildFailureDiagnostic({ name: "EN/eye-liner-main", expectedActivityIds: [], telemetrySample }));
    }

    const mainRefs = Array.isArray(eyeMain?.techniqueRefs)
      ? eyeMain.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean)
      : [];
	    expect(mainRefs.some((id) => id.startsWith("T_EYE_"))).toBe(true);
	    expect(mainRefs.some((id) => id.startsWith("US_eye_liner_"))).toBe(false);

	    expect(allSkeletons.some((s) => String(s?.ruleId || "") === "EYE_LINER_ACTIVITY_SLOT")).toBe(false);

	    const macroInResult = resultTechniqueIds.filter((id) => id.startsWith("US_eye_") && id.includes("liner"));
	    const microInResult = resultTechniqueIds.filter((id) => id.startsWith("T_EYE_"));
	    expect(microInResult.length).toBeGreaterThanOrEqual(3);
	    expect(macroInResult).toHaveLength(0);
	  });

	  test("EN: eye-liner activity slot still returns exactly one macro card (matching ON)", async () => {
	    const expectedMacro = [
	      "US_eye_liner_daily_upwing_01-en",
	      "US_eye_liner_winged_western_01-en",
	      "US_eye_liner_light_mixed_01-en",
	      "US_eye_liner_subtle_elongate_01-en",
	      "US_eye_liner_downturned_soft_01-en",
	    ];

    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_up.json",
      enableTriggerMatching: true,
      enableEyeActivitySlot: true,
    });

    const telemetrySample = out?.telemetrySample;
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    const slot = skeletons.find((s) => String(s?.ruleId || "") === "EYE_LINER_ACTIVITY_SLOT");
    if (!slot) {
      throw new Error(buildFailureDiagnostic({ name: "EN/eye-liner-slot-matching", expectedActivityIds: expectedMacro, telemetrySample }));
    }
    const slotRefs = Array.isArray(slot?.techniqueRefs) ? slot.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean) : [];
	    expect(slotRefs).toHaveLength(1);
	    expect(expectedMacro).toContain(slotRefs[0]);
	  });

	  test("EN: eye-liner macro slot chooses subtle_elongate for direction=straight (matching ON)", async () => {
	    const out = await runPipelineWithFixture({
	      locale: "en-US",
	      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_straight.json",
	      enableTriggerMatching: true,
	      enableEyeActivitySlot: true,
	      preferenceMode: "structure",
	    });

    const telemetrySample = out?.telemetrySample;
    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    const slot = skeletons.find((s) => String(s?.ruleId || "") === "EYE_LINER_ACTIVITY_SLOT");
    if (!slot) {
      throw new Error(
        buildFailureDiagnostic({
          name: "EN/eye-liner-slot-straight",
          expectedActivityIds: ["US_eye_liner_subtle_elongate_01-en"],
          telemetrySample,
        })
      );
    }

    const slotRefs = Array.isArray(slot?.techniqueRefs) ? slot.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean) : [];
	    expect(slotRefs).toEqual(["US_eye_liner_subtle_elongate_01-en"]);
	    expect(resultTechniqueIds).toContain("US_eye_liner_subtle_elongate_01-en");
	  });

	  test("EN: eye-liner macro slot chooses downturned_soft for direction=down (matching ON)", async () => {
    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_down.json",
      enableTriggerMatching: true,
      enableEyeActivitySlot: true,
      preferenceMode: "structure",
    });

    const telemetrySample = out?.telemetrySample;
    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    const slot = skeletons.find((s) => String(s?.ruleId || "") === "EYE_LINER_ACTIVITY_SLOT");
    if (!slot) {
      throw new Error(
        buildFailureDiagnostic({
          name: "EN/eye-liner-slot-down",
          expectedActivityIds: ["US_eye_liner_downturned_soft_01-en"],
          telemetrySample,
        })
      );
    }

    const slotRefs = Array.isArray(slot?.techniqueRefs) ? slot.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean) : [];
	    expect(slotRefs).toEqual(["US_eye_liner_downturned_soft_01-en"]);
	    expect(resultTechniqueIds).toContain("US_eye_liner_downturned_soft_01-en");
	  });

	  test("EN: eye-liner macro slot is NOT emitted when linerDirection is missing (matching ON)", async () => {
	    const lookSpec = readJson("fixtures/look_replicator/lookspec_eye_liner_up.json");
	    if (lookSpec?.breakdown?.eye) {
	      delete lookSpec.breakdown.eye.linerDirection;
	    }

    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_up.json",
      lookSpecOverride: lookSpec,
      enableTriggerMatching: true,
      enableEyeActivitySlot: true,
      preferenceMode: "structure",
    });

    const telemetrySample = out?.telemetrySample;
    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    const allSkeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    expect(allSkeletons.some((s) => String(s?.ruleId || "") === "EYE_LINER_ACTIVITY_SLOT")).toBe(false);

    const macroInResult = resultTechniqueIds.filter((id) => id.startsWith("US_eye_") && id.includes("liner"));
    expect(macroInResult).toHaveLength(0);
  });

  test("EN: eye-liner macro slot chooses winged_western for direction=up + preferenceMode=structure (matching ON)", async () => {
    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_up.json",
      enableTriggerMatching: true,
      enableEyeActivitySlot: true,
      preferenceMode: "structure",
    });

    const telemetrySample = out?.telemetrySample;
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    const slot = skeletons.find((s) => String(s?.ruleId || "") === "EYE_LINER_ACTIVITY_SLOT");
    if (!slot) {
      throw new Error(
        buildFailureDiagnostic({
          name: "EN/eye-liner-slot-structure-up",
          expectedActivityIds: ["US_eye_liner_winged_western_01-en"],
          telemetrySample,
        })
      );
    }

    const slotRefs = Array.isArray(slot?.techniqueRefs) ? slot.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean) : [];
    expect(slotRefs).toEqual(["US_eye_liner_winged_western_01-en"]);
  });

  test("EN: eye-liner macro slot chooses daily_upwing for direction=up + preferenceMode=ease (matching ON)", async () => {
    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_up.json",
      enableTriggerMatching: true,
      enableEyeActivitySlot: true,
      preferenceMode: "ease",
    });

    const telemetrySample = out?.telemetrySample;
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    const slot = skeletons.find((s) => String(s?.ruleId || "") === "EYE_LINER_ACTIVITY_SLOT");
    if (!slot) {
      throw new Error(
        buildFailureDiagnostic({
          name: "EN/eye-liner-slot-ease-up",
          expectedActivityIds: ["US_eye_liner_daily_upwing_01-en"],
          telemetrySample,
        })
      );
    }

    const slotRefs = Array.isArray(slot?.techniqueRefs) ? slot.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean) : [];
    expect(slotRefs).toEqual(["US_eye_liner_daily_upwing_01-en"]);
  });

  test("ZH: eye-liner macro slot chooses daily_upwing and resolves to -zh for direction=up + preferenceMode=ease (matching ON)", async () => {
    const out = await runPipelineWithFixture({
      locale: "zh-CN",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_up.json",
      enableTriggerMatching: true,
      enableEyeActivitySlot: true,
      preferenceMode: "ease",
    });

    const telemetrySample = out?.telemetrySample;
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    const slot = skeletons.find((s) => String(s?.ruleId || "") === "EYE_LINER_ACTIVITY_SLOT");
    if (!slot) {
      throw new Error(
        buildFailureDiagnostic({
          name: "ZH/eye-liner-slot-ease-up",
          expectedActivityIds: ["US_eye_liner_daily_upwing_01-zh"],
          telemetrySample,
        })
      );
    }

    const slotRefs = Array.isArray(slot?.techniqueRefs) ? slot.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean) : [];
    expect(slotRefs).toEqual(["US_eye_liner_daily_upwing_01-zh"]);
  });

  test("ZH: eye-liner macro slot resolves subtle_elongate to -zh for direction=straight (matching ON)", async () => {
    const out = await runPipelineWithFixture({
      locale: "zh-CN",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_straight.json",
      enableTriggerMatching: true,
      enableEyeActivitySlot: true,
      preferenceMode: "structure",
    });

    const telemetrySample = out?.telemetrySample;
    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    const slot = skeletons.find((s) => String(s?.ruleId || "") === "EYE_LINER_ACTIVITY_SLOT");
    if (!slot) {
      throw new Error(
        buildFailureDiagnostic({
          name: "ZH/eye-liner-slot-straight",
          expectedActivityIds: ["US_eye_liner_subtle_elongate_01-zh"],
          telemetrySample,
        })
      );
    }

    const slotRefs = Array.isArray(slot?.techniqueRefs) ? slot.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean) : [];
    expect(slotRefs).toEqual(["US_eye_liner_subtle_elongate_01-zh"]);
    expect(resultTechniqueIds).toContain("US_eye_liner_subtle_elongate_01-zh");
  });

  test("ZH: eye-liner macro slot resolves downturned_soft to -zh for direction=down (matching ON)", async () => {
    const out = await runPipelineWithFixture({
      locale: "zh-CN",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_down.json",
      enableTriggerMatching: true,
      enableEyeActivitySlot: true,
      preferenceMode: "structure",
    });

    const telemetrySample = out?.telemetrySample;
    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    const slot = skeletons.find((s) => String(s?.ruleId || "") === "EYE_LINER_ACTIVITY_SLOT");
    if (!slot) {
      throw new Error(
        buildFailureDiagnostic({
          name: "ZH/eye-liner-slot-down",
          expectedActivityIds: ["US_eye_liner_downturned_soft_01-zh"],
          telemetrySample,
        })
      );
    }

    const slotRefs = Array.isArray(slot?.techniqueRefs) ? slot.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean) : [];
    expect(slotRefs).toEqual(["US_eye_liner_downturned_soft_01-zh"]);
    expect(resultTechniqueIds).toContain("US_eye_liner_downturned_soft_01-zh");
  });

  test("ZH: eye-liner activity slot resolves macro card to -zh via locale (matching ON)", async () => {
    const expectedMacro = [
      "US_eye_liner_daily_upwing_01-zh",
      "US_eye_liner_winged_western_01-zh",
      "US_eye_liner_light_mixed_01-zh",
      "US_eye_liner_subtle_elongate_01-zh",
      "US_eye_liner_downturned_soft_01-zh",
    ];

    const out = await runPipelineWithFixture({
      locale: "zh-CN",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_up.json",
      enableTriggerMatching: true,
      enableEyeActivitySlot: true,
    });

    const telemetrySample = out?.telemetrySample;
    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    const slot = skeletons.find((s) => String(s?.ruleId || "") === "EYE_LINER_ACTIVITY_SLOT");
    if (!slot) {
      throw new Error(buildFailureDiagnostic({ name: "ZH/eye-liner-slot", expectedActivityIds: expectedMacro, telemetrySample }));
    }
    const slotRefs = Array.isArray(slot?.techniqueRefs) ? slot.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean) : [];
    expect(slotRefs).toHaveLength(1);
    expect(expectedMacro).toContain(slotRefs[0]);

    const macroInResult = resultTechniqueIds.filter((id) => id.startsWith("US_eye_") && id.includes("liner"));
    expect(macroInResult).toHaveLength(1);
    expect(macroInResult[0]).toMatch(/-zh$/);
  });

  test("EN: base coverage fixture does NOT emit eye macro slot when linerDirection is absent", async () => {
    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_base_coverage_full.json",
      enableTriggerMatching: true,
      enableEyeActivitySlot: true,
    });

    const telemetrySample = out?.telemetrySample;
    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    const allSkeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    expect(allSkeletons.some((s) => String(s?.ruleId || "") === "EYE_LINER_ACTIVITY_SLOT")).toBe(false);

    const macroInResult = resultTechniqueIds.filter((id) => id.startsWith("US_eye_") && id.includes("liner"));
    expect(macroInResult).toHaveLength(0);
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
    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    const techniqueRefs = collectTechniqueRefs(telemetrySample);
    const found = expected.filter((id) => techniqueRefs.includes(id));

    if (!found.length) {
      throw new Error(buildFailureDiagnostic({ name: "EN/extended-areas", expectedActivityIds: expected, telemetrySample }));
    }

    const foundInResult = expected.filter((id) => resultTechniqueIds.includes(id));
    expect(foundInResult.length).toBeGreaterThan(0);
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
    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    const techniqueRefs = collectTechniqueRefs(telemetrySample);
    const found = expected.filter((id) => techniqueRefs.includes(id));

    if (!found.length) {
      throw new Error(buildFailureDiagnostic({ name: "ZH/extended-areas", expectedActivityIds: expected, telemetrySample }));
    }

    const foundInResult = expected.filter((id) => resultTechniqueIds.includes(id));
    expect(foundInResult.length).toBeGreaterThan(0);
  });

  test("Trigger matching OFF: base skeleton renders multiple techniqueRefs", async () => {
    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_base_coverage_full.json",
      enableTriggerMatching: false,
    });

    const telemetrySample = out?.telemetrySample;
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    const base = skeletons.find((s) => String(s?.impactArea || "") === "base");
    const refs = Array.isArray(base?.techniqueRefs) ? base.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean) : [];
    expect(refs.length).toBeGreaterThan(1);
    expect(refs).toContain("T_BASE_BUILD_COVERAGE_THIN_PASSES");
    expect(refs).toContain("US_base_fix_caking_01-en");
  });

  test("Trigger matching ON (EN): choose_one intent selects exactly one base technique", async () => {
    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_base_coverage_full.json",
      enableTriggerMatching: true,
    });

    const telemetrySample = out?.telemetrySample;
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    const base = skeletons.find((s) => String(s?.impactArea || "") === "base");
    const refs = Array.isArray(base?.techniqueRefs) ? base.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean) : [];
    expect(refs).toEqual(["US_base_fix_caking_01-en"]);
  });

  test("Trigger matching ON (ZH): chooses one base technique and resolves to -zh via locale", async () => {
    const out = await runPipelineWithFixture({
      locale: "zh-CN",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_base_coverage_full.json",
      enableTriggerMatching: true,
    });

    const telemetrySample = out?.telemetrySample;
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    const base = skeletons.find((s) => String(s?.impactArea || "") === "base");
    const refs = Array.isArray(base?.techniqueRefs) ? base.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean) : [];
    expect(refs).toEqual(["US_base_fix_caking_01-zh"]);
  });
});
