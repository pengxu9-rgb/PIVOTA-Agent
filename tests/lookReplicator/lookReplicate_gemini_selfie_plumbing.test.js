const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function writeTempJpeg() {
  const p = path.join(os.tmpdir(), `pivota-gemini-pipeline-${process.pid}-${Date.now()}.jpg`);
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return p;
}

function readJson(relPathFromRepoRoot) {
  const abs = path.join(__dirname, "..", "..", relPathFromRepoRoot);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function collectResultTechniqueIds(result) {
  const refs = Array.isArray(result?.techniqueRefs) ? result.techniqueRefs : [];
  return refs.map((r) => String(r?.id || "").trim()).filter(Boolean);
}

describe("lookReplicatePipeline: gemini selfie lookspec plumbing (fail-closed)", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("uses gemini selfie lookSpec to compute lookDiff and emit base slot", async () => {
    const envBackup = { ...process.env };
    const referenceImagePath = writeTempJpeg();

    try {
      process.env.API_MODE = "MOCK";
      process.env.LAYER2_ENABLE_SELFIE_LOOKSPEC = "1";
      process.env.LAYER1_ENABLE_GEMINI_SELFIE_LOOKSPEC = "1";
      process.env.LAYER2_ENABLE_TRIGGER_MATCHING = "1";
      process.env.LAYER2_ENABLE_BASE_ACTIVITY_SLOT = "1";
      delete process.env.LAYER2_ENABLE_EYE_ACTIVITY_SLOT;
      delete process.env.LAYER2_ENABLE_LIP_ACTIVITY_SLOT;

      const referenceLookSpec = readJson("fixtures/look_replicator/lookspec_base_coverage_full.json");
      referenceLookSpec.breakdown.base.finish = "dewy";
      referenceLookSpec.breakdown.base.coverage = "full";
      referenceLookSpec.breakdown.lip.finish = "velvet";

      const selfieLookSpec = {
        ...referenceLookSpec,
        breakdown: {
          ...referenceLookSpec.breakdown,
          base: { ...referenceLookSpec.breakdown.base, finish: "matte", coverage: "sheer" },
          lip: { ...referenceLookSpec.breakdown.lip, finish: "gloss" },
        },
      };

      let geminiCalls = 0;

      await new Promise((resolve, reject) => {
        jest.isolateModules(() => {
          try {
            jest.doMock("../../src/layer1/selfie/extractSelfieLookSpecGemini", () => ({
              extractSelfieLookSpecGemini: async () => {
                geminiCalls += 1;
                return { ok: true, value: selfieLookSpec };
              },
            }));

            jest.doMock("../../src/layer2/extractLookSpec", () => ({
              extractLookSpec: async (input) => {
                if (input?.imageKind === "selfie") throw new Error("SELFIE_FALLBACK_CALLED");
                return referenceLookSpec;
              },
            }));

            const { runLookReplicatePipeline } = require("../../src/lookReplicator/lookReplicatePipeline");
            const layer1Bundle = readJson("fixtures/contracts/us/layer1BundleV0.sample.json");

            runLookReplicatePipeline({
              market: "US",
              locale: "en-US",
              preferenceMode: "structure",
              jobId: "e2e_gemini_plumbing",
              referenceImage: { path: referenceImagePath, contentType: "image/jpeg" },
              selfieImage: { path: referenceImagePath, contentType: "image/jpeg" },
              layer1Bundle,
            })
              .then((out) => {
                const ids = collectResultTechniqueIds(out?.result);
                expect(geminiCalls).toBe(1);
                expect(ids.some((id) => id.startsWith("US_base_fix_"))).toBe(true);
                expect(out?.telemetrySample?.gemini?.selfie?.enabled).toBe(true);
                expect(out?.telemetrySample?.gemini?.selfie?.ok).toBe(true);
                expect(out?.telemetrySample?.gemini?.lookDiffSource).toBe("gemini");
                resolve();
              })
              .catch(reject);
          } catch (e) {
            reject(e);
          }
        });
      });
    } finally {
      process.env = envBackup;
      fs.rmSync(referenceImagePath, { force: true });
    }
  });

  test("fail-closed: when gemini fails, do not emit base slot macros", async () => {
    const envBackup = { ...process.env };
    const referenceImagePath = writeTempJpeg();

    try {
      process.env.API_MODE = "MOCK";
      process.env.LAYER2_ENABLE_SELFIE_LOOKSPEC = "1";
      process.env.LAYER1_ENABLE_GEMINI_SELFIE_LOOKSPEC = "1";
      process.env.LAYER2_ENABLE_TRIGGER_MATCHING = "1";
      process.env.LAYER2_ENABLE_BASE_ACTIVITY_SLOT = "1";
      delete process.env.LAYER2_ENABLE_EYE_ACTIVITY_SLOT;
      delete process.env.LAYER2_ENABLE_LIP_ACTIVITY_SLOT;

      const referenceLookSpec = readJson("fixtures/look_replicator/lookspec_base_coverage_full.json");

      await new Promise((resolve, reject) => {
        jest.isolateModules(() => {
          try {
            jest.doMock("../../src/layer1/selfie/extractSelfieLookSpecGemini", () => ({
              extractSelfieLookSpecGemini: async () => ({ ok: false, error: { code: "REQUEST_FAILED", message: "boom" } }),
            }));

            jest.doMock("../../src/layer2/extractLookSpec", () => ({
              extractLookSpec: async (input) => {
                if (input?.imageKind === "selfie") throw new Error("SELFIE_FALLBACK_CALLED");
                return referenceLookSpec;
              },
            }));

            const { runLookReplicatePipeline } = require("../../src/lookReplicator/lookReplicatePipeline");
            const layer1Bundle = readJson("fixtures/contracts/us/layer1BundleV0.sample.json");

            runLookReplicatePipeline({
              market: "US",
              locale: "en-US",
              preferenceMode: "structure",
              jobId: "e2e_gemini_fail_closed",
              referenceImage: { path: referenceImagePath, contentType: "image/jpeg" },
              selfieImage: { path: referenceImagePath, contentType: "image/jpeg" },
              layer1Bundle,
            })
              .then((out) => {
                const ids = collectResultTechniqueIds(out?.result);
                expect(ids.some((id) => id.startsWith("US_base_fix_"))).toBe(false);
                expect(out?.telemetrySample?.gemini?.selfie?.enabled).toBe(true);
                expect(out?.telemetrySample?.gemini?.selfie?.ok).toBe(false);
                expect(out?.telemetrySample?.gemini?.selfie?.errorCode).toBe("REQUEST_FAILED");
                expect(out?.telemetrySample?.gemini?.lookDiffSource).toBe(null);
                resolve();
              })
              .catch(reject);
          } catch (e) {
            reject(e);
          }
        });
      });
    } finally {
      process.env = envBackup;
      fs.rmSync(referenceImagePath, { force: true });
    }
  });
});
