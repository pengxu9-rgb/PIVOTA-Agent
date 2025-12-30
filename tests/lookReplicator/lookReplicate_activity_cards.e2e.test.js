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
  selfieLookSpecOverride,
  similarityReportOverride,
  enableSelfieLookSpec,
  enableExtendedAreas,
  enableTriggerMatching,
  enableEyeActivitySlot,
  enableBaseActivitySlot,
  enableLipActivitySlot,
  provideSelfieImage,
  preferenceMode,
  throwOnSelfieExtract,
}) {
  const referenceImagePath = writeTempJpeg();
  const envBackup = { ...process.env };

  try {
    const lookSpec = lookSpecOverride ?? readJson(lookSpecFixturePath);
    const selfieLookSpec = selfieLookSpecOverride ?? lookSpec;
    const layer1Bundle = readJson("fixtures/contracts/us/layer1BundleV0.sample.json");
    if (similarityReportOverride) {
      layer1Bundle.similarityReport = similarityReportOverride;
    }

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
    process.env.LAYER2_ENABLE_SELFIE_LOOKSPEC = enableSelfieLookSpec ? "1" : "0";
    if (typeof enableEyeActivitySlot === "boolean") {
      process.env.LAYER2_ENABLE_EYE_ACTIVITY_SLOT = enableEyeActivitySlot ? "1" : "0";
    } else {
      delete process.env.LAYER2_ENABLE_EYE_ACTIVITY_SLOT;
    }
    if (typeof enableBaseActivitySlot === "boolean") {
      process.env.LAYER2_ENABLE_BASE_ACTIVITY_SLOT = enableBaseActivitySlot ? "1" : "0";
    } else {
      delete process.env.LAYER2_ENABLE_BASE_ACTIVITY_SLOT;
    }
    if (typeof enableLipActivitySlot === "boolean") {
    process.env.LAYER2_ENABLE_LIP_ACTIVITY_SLOT = enableLipActivitySlot ? "1" : "0";
    } else {
      delete process.env.LAYER2_ENABLE_LIP_ACTIVITY_SLOT;
    }

    let runLookReplicatePipeline = null;
    let selfieExtractCalls = 0;
    await new Promise((resolve, reject) => {
      jest.isolateModules(() => {
        try {
          jest.doMock("../../src/layer2/extractLookSpec", () => ({
            extractLookSpec: async (input) => {
              if (input?.imageKind === "selfie") {
                selfieExtractCalls += 1;
                if (throwOnSelfieExtract) throw new Error("SELFIE_EXTRACT_CALLED");
                return selfieLookSpec;
              }
              return lookSpec;
            },
          }));
          ({ runLookReplicatePipeline } = require("../../src/lookReplicator/lookReplicatePipeline"));
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    const shouldProvideSelfieImage = typeof provideSelfieImage === "boolean" ? provideSelfieImage : Boolean(enableSelfieLookSpec);
    const out = await runLookReplicatePipeline({
      market: "US",
      locale,
      preferenceMode: preferenceMode ?? "structure",
      jobId: `e2e_${locale}`,
      referenceImage: { path: referenceImagePath, contentType: "image/jpeg" },
      ...(enableSelfieLookSpec && shouldProvideSelfieImage
        ? { selfieImage: { path: referenceImagePath, contentType: "image/jpeg" } }
        : {}),
      layer1Bundle,
    });
    return { ...out, __selfieExtractCalls: selfieExtractCalls };
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

	  test("EN: extended areas render at least one activity technique when flag enabled", async () => {
	    const expected = [
	      "US_prep_moisturize_01-en",
	      "US_prep_primer_01-en",
	      "US_contour_nose_root_contour_01-en",
	      "US_contour_nose_highlight_points_01-en",
	      "US_brow_fill_natural_strokes_01-en",
	      "US_brow_fix_high_arch_01-en",
	      "US_blush_round_face_placement_01-en",
	      "US_blush_oval_face_gradient_01-en",
	    ];

	    const out = await runPipelineWithFixture({
	      locale: "en-US",
	      lookSpecFixturePath: "fixtures/look_replicator/lookspec_base_coverage_full.json",
	      enableExtendedAreas: true,
	      enableSelfieLookSpec: true,
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
	      "US_prep_moisturize_01-zh",
	      "US_prep_primer_01-zh",
	      "US_contour_nose_root_contour_01-zh",
	      "US_contour_nose_highlight_points_01-zh",
	      "US_brow_fill_natural_strokes_01-zh",
	      "US_brow_fix_high_arch_01-zh",
	      "US_blush_round_face_placement_01-zh",
	      "US_blush_oval_face_gradient_01-zh",
	    ];

	    const out = await runPipelineWithFixture({
	      locale: "zh-CN",
	      lookSpecFixturePath: "fixtures/look_replicator/lookspec_base_coverage_full.json",
	      enableExtendedAreas: true,
	      enableSelfieLookSpec: true,
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
    expect(refs.length).toBeGreaterThanOrEqual(3);
    expect(refs).toContain("T_BASE_BUILD_COVERAGE_THIN_PASSES");
    expect(refs.some((id) => id.startsWith("US_base_fix_"))).toBe(false);
  });

  test("EN: base/lip activity slots are emitted only when lookDiff.needsChange is true (matching ON)", async () => {
    const baseTarget = readJson("fixtures/look_replicator/lookspec_base_coverage_full.json");
    const targetLookSpec = {
      ...baseTarget,
      breakdown: {
        ...baseTarget.breakdown,
        base: { ...baseTarget.breakdown.base, finish: "dewy", coverage: "full" },
        lip: { ...baseTarget.breakdown.lip, finish: "velvet" },
      },
    };
    const selfieLookSpec = {
      ...targetLookSpec,
      breakdown: {
        ...targetLookSpec.breakdown,
        base: { ...targetLookSpec.breakdown.base, finish: "matte", coverage: "sheer" },
        lip: { ...targetLookSpec.breakdown.lip, finish: "gloss" },
      },
    };

    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecOverride: targetLookSpec,
      selfieLookSpecOverride: selfieLookSpec,
      enableSelfieLookSpec: true,
      enableTriggerMatching: true,
      enableBaseActivitySlot: true,
      enableLipActivitySlot: true,
      enableEyeActivitySlot: false,
    });

    const telemetrySample = out?.telemetrySample;
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];

    const baseSlot = skeletons.find((s) => String(s?.ruleId || "") === "BASE_ACTIVITY_SLOT");
    const lipSlot = skeletons.find((s) => String(s?.ruleId || "") === "LIP_ACTIVITY_SLOT");
    expect(Boolean(baseSlot)).toBe(true);
    expect(Boolean(lipSlot)).toBe(true);

    const baseSlotRefs = Array.isArray(baseSlot?.techniqueRefs) ? baseSlot.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean) : [];
    const lipSlotRefs = Array.isArray(lipSlot?.techniqueRefs) ? lipSlot.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean) : [];
    expect(baseSlotRefs).toHaveLength(1);
    expect(lipSlotRefs).toHaveLength(1);
    expect(["US_base_fix_caking_01-en", "US_base_fix_floating_powder_01-en"]).toContain(baseSlotRefs[0]);
    expect(["US_lip_thin_lower_fuller_01-en", "US_lip_flat_lips_define_01-en"]).toContain(lipSlotRefs[0]);

    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    expect(resultTechniqueIds.some((id) => id.startsWith("T_BASE_"))).toBe(true);
    expect(resultTechniqueIds.some((id) => id.startsWith("T_LIP_"))).toBe(true);
    expect(resultTechniqueIds.some((id) => id.startsWith("US_base_fix_"))).toBe(true);
    expect(resultTechniqueIds.some((id) => id.startsWith("US_lip_"))).toBe(true);
  });

  test("ZH: base/lip activity slots resolve to -zh, and do NOT emit when needsChange=false", async () => {
    const baseTarget = readJson("fixtures/look_replicator/lookspec_base_coverage_full.json");
    const targetLookSpec = {
      ...baseTarget,
      breakdown: {
        ...baseTarget.breakdown,
        base: { ...baseTarget.breakdown.base, finish: "dewy", coverage: "full" },
        lip: { ...baseTarget.breakdown.lip, finish: "velvet" },
      },
    };

    const outNoChange = await runPipelineWithFixture({
      locale: "zh-CN",
      lookSpecOverride: targetLookSpec,
      selfieLookSpecOverride: targetLookSpec,
      enableSelfieLookSpec: true,
      enableTriggerMatching: true,
      enableBaseActivitySlot: true,
      enableLipActivitySlot: true,
      enableEyeActivitySlot: false,
    });

    const noChangeIds = collectResultTechniqueIds(outNoChange?.result);
    expect(noChangeIds.some((id) => id.startsWith("US_base_fix_"))).toBe(false);
    expect(noChangeIds.some((id) => id.startsWith("US_lip_"))).toBe(false);

    const selfieLookSpec = {
      ...targetLookSpec,
      breakdown: {
        ...targetLookSpec.breakdown,
        base: { ...targetLookSpec.breakdown.base, finish: "matte", coverage: "sheer" },
        lip: { ...targetLookSpec.breakdown.lip, finish: "gloss" },
      },
    };

    const outChange = await runPipelineWithFixture({
      locale: "zh-CN",
      lookSpecOverride: targetLookSpec,
      selfieLookSpecOverride: selfieLookSpec,
      enableSelfieLookSpec: true,
      enableTriggerMatching: true,
      enableBaseActivitySlot: true,
      enableLipActivitySlot: true,
      enableEyeActivitySlot: false,
    });

    const changeIds = collectResultTechniqueIds(outChange?.result);
    expect(changeIds.some((id) => id.startsWith("US_base_fix_") && id.endsWith("-zh"))).toBe(true);
    expect(changeIds.some((id) => id.startsWith("US_lip_") && id.endsWith("-zh"))).toBe(true);
  });

  test("EN: extended areas (prep/contour/brow/blush) emit one activity card each when extended + selfie enabled", async () => {
    const baseTarget = readJson("fixtures/look_replicator/lookspec_base_coverage_full.json");

    const makeArea = (intent) => ({
      intent,
      finish: "unknown",
      coverage: "unknown",
      keyNotes: [],
      evidence: [],
    });

    const targetLookSpec = {
      ...baseTarget,
      breakdown: {
        ...baseTarget.breakdown,
        prep: makeArea("prep_target"),
        contour: makeArea("contour_target"),
        brow: makeArea("brow_target"),
        blush: makeArea("blush_target"),
      },
    };

    const selfieLookSpec = {
      ...targetLookSpec,
      breakdown: {
        ...targetLookSpec.breakdown,
        prep: makeArea("prep_selfie"),
        contour: makeArea("contour_selfie"),
        brow: makeArea("brow_selfie"),
        blush: makeArea("blush_selfie"),
      },
    };

    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecOverride: targetLookSpec,
      selfieLookSpecOverride: selfieLookSpec,
      enableSelfieLookSpec: true,
      enableExtendedAreas: true,
      enableTriggerMatching: true,
      enableEyeActivitySlot: false,
      enableBaseActivitySlot: false,
      enableLipActivitySlot: false,
    });

    const telemetrySample = out?.telemetrySample;
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];
    const resultTechniqueIds = collectResultTechniqueIds(out?.result);

    const cardExpectations = [
      {
        ruleId: "PREP_ACTIVITY_CARD",
        pool: ["US_prep_moisturize_01-en", "US_prep_primer_01-en"],
      },
      {
        ruleId: "CONTOUR_ACTIVITY_CARD",
        pool: ["US_contour_nose_root_contour_01-en", "US_contour_nose_highlight_points_01-en"],
      },
      {
        ruleId: "BROW_ACTIVITY_CARD",
        pool: ["US_brow_fill_natural_strokes_01-en", "US_brow_fix_high_arch_01-en"],
      },
      {
        ruleId: "BLUSH_ACTIVITY_CARD",
        pool: ["US_blush_round_face_placement_01-en", "US_blush_oval_face_gradient_01-en"],
      },
    ];

    for (const { ruleId, pool } of cardExpectations) {
      const card = skeletons.find((s) => String(s?.ruleId || "") === ruleId);
      if (!card) {
        throw new Error(buildFailureDiagnostic({ name: `EN/extended-card/${ruleId}`, expectedActivityIds: pool, telemetrySample }));
      }
      const refs = Array.isArray(card?.techniqueRefs)
        ? card.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean)
        : [];
      expect(refs).toHaveLength(1);
      expect(pool).toContain(refs[0]);
      expect(resultTechniqueIds).toContain(refs[0]);
    }
  });

  test("EN: extended areas still emit cards when needsChange=false (extended + selfie enabled)", async () => {
    const baseTarget = readJson("fixtures/look_replicator/lookspec_base_coverage_full.json");

    const makeArea = (intent) => ({
      intent,
      finish: "unknown",
      coverage: "unknown",
      keyNotes: [],
      evidence: [],
    });

    const targetLookSpec = {
      ...baseTarget,
      breakdown: {
        ...baseTarget.breakdown,
        prep: makeArea("prep_target"),
        contour: makeArea("contour_target"),
        brow: makeArea("brow_target"),
        blush: makeArea("blush_target"),
      },
    };

    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecOverride: targetLookSpec,
      selfieLookSpecOverride: targetLookSpec,
      enableSelfieLookSpec: true,
      enableExtendedAreas: true,
      enableTriggerMatching: true,
      enableEyeActivitySlot: false,
      enableBaseActivitySlot: false,
      enableLipActivitySlot: false,
    });

    const telemetrySample = out?.telemetrySample;
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];

    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    expect(skeletons.some((s) => String(s?.ruleId || "") === "PREP_ACTIVITY_CARD")).toBe(true);
    expect(skeletons.some((s) => String(s?.ruleId || "") === "CONTOUR_ACTIVITY_CARD")).toBe(true);
    expect(skeletons.some((s) => String(s?.ruleId || "") === "BROW_ACTIVITY_CARD")).toBe(true);
    expect(skeletons.some((s) => String(s?.ruleId || "") === "BLUSH_ACTIVITY_CARD")).toBe(true);
    expect(resultTechniqueIds.some((id) => id.startsWith("US_prep_"))).toBe(true);
    expect(resultTechniqueIds.some((id) => id.startsWith("US_contour_"))).toBe(true);
    expect(resultTechniqueIds.some((id) => id.startsWith("US_brow_"))).toBe(true);
    expect(resultTechniqueIds.some((id) => id.startsWith("US_blush_"))).toBe(true);
  });

  test("ZH: extended areas resolve to -zh and do NOT emit fallback warnings (extended + selfie enabled)", async () => {
    const baseTarget = readJson("fixtures/look_replicator/lookspec_base_coverage_full.json");

    const makeArea = (intent) => ({
      intent,
      finish: "unknown",
      coverage: "unknown",
      keyNotes: [],
      evidence: [],
    });

    const targetLookSpec = {
      ...baseTarget,
      breakdown: {
        ...baseTarget.breakdown,
        prep: makeArea("prep_target"),
        contour: makeArea("contour_target"),
        brow: makeArea("brow_target"),
        blush: makeArea("blush_target"),
      },
    };

    const selfieLookSpec = {
      ...targetLookSpec,
      breakdown: {
        ...targetLookSpec.breakdown,
        prep: makeArea("prep_selfie"),
        contour: makeArea("contour_selfie"),
        brow: makeArea("brow_selfie"),
        blush: makeArea("blush_selfie"),
      },
    };

    const out = await runPipelineWithFixture({
      locale: "zh-CN",
      lookSpecOverride: targetLookSpec,
      selfieLookSpecOverride: selfieLookSpec,
      enableSelfieLookSpec: true,
      enableExtendedAreas: true,
      enableTriggerMatching: true,
      enableEyeActivitySlot: false,
      enableBaseActivitySlot: false,
      enableLipActivitySlot: false,
    });

    const warnings = Array.isArray(out?.result?.warnings) ? out.result.warnings : [];
    expect(warnings.some((w) => String(w).includes("Technique language fallback"))).toBe(false);

    const telemetrySample = out?.telemetrySample;
    const skeletons = Array.isArray(telemetrySample?.replayContext?.adjustmentSkeletons)
      ? telemetrySample.replayContext.adjustmentSkeletons
      : [];

    const cardExpectations = [
      {
        ruleId: "PREP_ACTIVITY_CARD",
        poolEn: ["US_prep_moisturize_01-en", "US_prep_primer_01-en"],
      },
      {
        ruleId: "CONTOUR_ACTIVITY_CARD",
        poolEn: ["US_contour_nose_root_contour_01-en", "US_contour_nose_highlight_points_01-en"],
      },
      {
        ruleId: "BROW_ACTIVITY_CARD",
        poolEn: ["US_brow_fill_natural_strokes_01-en", "US_brow_fix_high_arch_01-en"],
      },
      {
        ruleId: "BLUSH_ACTIVITY_CARD",
        poolEn: ["US_blush_round_face_placement_01-en", "US_blush_oval_face_gradient_01-en"],
      },
    ];

    for (const { ruleId, poolEn } of cardExpectations) {
      const poolZh = poolEn.map((id) => id.replace(/-en$/, "-zh"));
      const card = skeletons.find((s) => String(s?.ruleId || "") === ruleId);
      if (!card) {
        throw new Error(buildFailureDiagnostic({ name: `ZH/extended-card/${ruleId}`, expectedActivityIds: poolZh, telemetrySample }));
      }
      const refs = Array.isArray(card?.techniqueRefs)
        ? card.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean)
        : [];
      expect(refs).toHaveLength(1);
      expect(poolZh).toContain(refs[0]);
    }

    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    expect(resultTechniqueIds.some((id) => id.startsWith("US_prep_") && id.endsWith("-zh"))).toBe(true);
    expect(resultTechniqueIds.some((id) => id.startsWith("US_contour_") && id.endsWith("-zh"))).toBe(true);
    expect(resultTechniqueIds.some((id) => id.startsWith("US_brow_") && id.endsWith("-zh"))).toBe(true);
    expect(resultTechniqueIds.some((id) => id.startsWith("US_blush_") && id.endsWith("-zh"))).toBe(true);
  });

  test("EN: layer1 lookDiff contract drives base/lip macro slots without selfieImage", async () => {
    const baseTarget = readJson("fixtures/look_replicator/lookspec_base_coverage_full.json");
    const targetLookSpec = {
      ...baseTarget,
      breakdown: {
        ...baseTarget.breakdown,
        base: { ...baseTarget.breakdown.base, finish: "dewy", coverage: "full" },
        lip: { ...baseTarget.breakdown.lip, finish: "velvet" },
      },
    };

    const sr = readJson("fixtures/contracts/us/layer1BundleV0.sample.json").similarityReport;
    const similarityReportOverride = {
      ...sr,
      lookDiff: {
        ...(sr.lookDiff || {}),
        base: { ...(sr.lookDiff?.base || {}), finish: { user: "matte", target: "dewy", needsChange: true } },
        lip: { ...(sr.lookDiff?.lip || {}), finish: { user: "gloss", target: "velvet", needsChange: true } },
      },
    };

    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecOverride: targetLookSpec,
      enableSelfieLookSpec: true,
      provideSelfieImage: false,
      enableTriggerMatching: true,
      enableBaseActivitySlot: true,
      enableLipActivitySlot: true,
      enableEyeActivitySlot: false,
      similarityReportOverride,
    });

    expect(out.__selfieExtractCalls).toBe(0);
    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    expect(resultTechniqueIds.some((id) => id.startsWith("US_base_fix_"))).toBe(true);
    expect(resultTechniqueIds.some((id) => id.startsWith("US_lip_"))).toBe(true);
  });

  test("ZH: layer1 lookDiff contract drives macro slots and resolves to -zh without selfieImage", async () => {
    const baseTarget = readJson("fixtures/look_replicator/lookspec_base_coverage_full.json");
    const targetLookSpec = {
      ...baseTarget,
      breakdown: {
        ...baseTarget.breakdown,
        base: { ...baseTarget.breakdown.base, finish: "dewy", coverage: "full" },
        lip: { ...baseTarget.breakdown.lip, finish: "velvet" },
      },
    };

    const sr = readJson("fixtures/contracts/us/layer1BundleV0.sample.json").similarityReport;
    const similarityReportOverride = {
      ...sr,
      lookDiff: {
        ...(sr.lookDiff || {}),
        base: { ...(sr.lookDiff?.base || {}), finish: { user: "matte", target: "dewy", needsChange: true } },
        lip: { ...(sr.lookDiff?.lip || {}), finish: { user: "gloss", target: "velvet", needsChange: true } },
      },
    };

    const out = await runPipelineWithFixture({
      locale: "zh-CN",
      lookSpecOverride: targetLookSpec,
      enableSelfieLookSpec: true,
      provideSelfieImage: false,
      enableTriggerMatching: true,
      enableBaseActivitySlot: true,
      enableLipActivitySlot: true,
      enableEyeActivitySlot: false,
      similarityReportOverride,
    });

    expect(out.__selfieExtractCalls).toBe(0);
    const warnings = Array.isArray(out?.result?.warnings) ? out.result.warnings : [];
    expect(warnings.some((w) => String(w).includes("Technique language fallback"))).toBe(false);

    const resultTechniqueIds = collectResultTechniqueIds(out?.result);
    expect(resultTechniqueIds.some((id) => id.startsWith("US_base_fix_") && id.endsWith("-zh"))).toBe(true);
    expect(resultTechniqueIds.some((id) => id.startsWith("US_lip_") && id.endsWith("-zh"))).toBe(true);
  });

  test("EN: if layer1 lookDiff is present, pipeline does NOT call selfie extract even when selfieImage is provided", async () => {
    const baseTarget = readJson("fixtures/look_replicator/lookspec_base_coverage_full.json");
    const targetLookSpec = {
      ...baseTarget,
      breakdown: {
        ...baseTarget.breakdown,
        base: { ...baseTarget.breakdown.base, finish: "dewy", coverage: "full" },
        lip: { ...baseTarget.breakdown.lip, finish: "velvet" },
      },
    };

    const sr = readJson("fixtures/contracts/us/layer1BundleV0.sample.json").similarityReport;
    const similarityReportOverride = {
      ...sr,
      lookDiff: {
        ...(sr.lookDiff || {}),
        base: { ...(sr.lookDiff?.base || {}), finish: { user: "matte", target: "dewy", needsChange: true } },
        lip: { ...(sr.lookDiff?.lip || {}), finish: { user: "gloss", target: "velvet", needsChange: true } },
      },
    };

    const out = await runPipelineWithFixture({
      locale: "en-US",
      lookSpecOverride: targetLookSpec,
      enableSelfieLookSpec: true,
      provideSelfieImage: true,
      enableTriggerMatching: true,
      enableBaseActivitySlot: true,
      enableLipActivitySlot: true,
      enableEyeActivitySlot: false,
      similarityReportOverride,
      throwOnSelfieExtract: true,
    });

    expect(out.__selfieExtractCalls).toBe(0);
  });
});
