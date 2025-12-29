const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function writeTempJpeg() {
  const p = path.join(os.tmpdir(), `pivota-gemini-reference-pipeline-${process.pid}-${Date.now()}.jpg`);
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

describe("lookReplicatePipeline: gemini reference lookspec plumbing (fail-closed)", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("uses gemini reference lookSpec when enabled", async () => {
    const envBackup = { ...process.env };
    const referenceImagePath = writeTempJpeg();

    try {
      process.env.API_MODE = "MOCK";
      process.env.LAYER1_ENABLE_GEMINI_REFERENCE_LOOKSPEC = "1";
      process.env.LAYER2_ENABLE_TRIGGER_MATCHING = "1";
      process.env.LAYER2_ENABLE_EXTENDED_AREAS = "1"; // include techniqueRefs in result
      delete process.env.LAYER2_ENABLE_SELFIE_LOOKSPEC;

      const referenceLookSpec = readJson("fixtures/look_replicator/lookspec_eye_liner_up.json");

      await new Promise((resolve, reject) => {
        jest.isolateModules(() => {
          try {
            jest.doMock("../../src/layer1/reference/extractReferenceLookSpecGemini", () => ({
              extractReferenceLookSpecGemini: async () => ({ ok: true, value: referenceLookSpec }),
            }));

            jest.doMock("../../src/layer2/extractLookSpec", () => ({
              extractLookSpec: async () => {
                throw new Error("REFERENCE_FALLBACK_CALLED");
              },
            }));

            const { runLookReplicatePipeline } = require("../../src/lookReplicator/lookReplicatePipeline");
            const layer1Bundle = readJson("fixtures/contracts/us/layer1BundleV0.sample.json");

            runLookReplicatePipeline({
              market: "US",
              locale: "en-US",
              preferenceMode: "structure",
              jobId: "e2e_gemini_reference_plumbing",
              referenceImage: { path: referenceImagePath, contentType: "image/jpeg" },
              layer1Bundle,
            })
              .then((out) => {
                const ids = collectResultTechniqueIds(out?.result);
                expect(Array.isArray(ids)).toBe(true);
                expect(ids.length).toBeGreaterThan(0);
                expect(out?.telemetrySample?.gemini?.reference?.okCount).toBe(1);
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

  test("fail-closed: when gemini reference extraction fails, falls back to existing extractLookSpec", async () => {
    const envBackup = { ...process.env };
    const referenceImagePath = writeTempJpeg();

    try {
      process.env.API_MODE = "MOCK";
      process.env.LAYER1_ENABLE_GEMINI_REFERENCE_LOOKSPEC = "1";
      delete process.env.LAYER2_ENABLE_SELFIE_LOOKSPEC;

      const referenceLookSpec = readJson("fixtures/look_replicator/lookspec_base_coverage_full.json");

      await new Promise((resolve, reject) => {
        jest.isolateModules(() => {
          try {
            jest.doMock("../../src/layer1/reference/extractReferenceLookSpecGemini", () => ({
              extractReferenceLookSpecGemini: async () => ({ ok: false, error: { code: "REQUEST_FAILED", message: "boom" } }),
            }));

            const extractLookSpec = jest.fn().mockResolvedValue(referenceLookSpec);
            jest.doMock("../../src/layer2/extractLookSpec", () => ({
              extractLookSpec,
            }));

            const { runLookReplicatePipeline } = require("../../src/lookReplicator/lookReplicatePipeline");
            const layer1Bundle = readJson("fixtures/contracts/us/layer1BundleV0.sample.json");

            runLookReplicatePipeline({
              market: "US",
              locale: "en-US",
              preferenceMode: "structure",
              jobId: "e2e_gemini_reference_fail_closed",
              referenceImage: { path: referenceImagePath, contentType: "image/jpeg" },
              layer1Bundle,
            })
              .then((out) => {
                expect(out?.result?.schemaVersion).toBe("v0");
                expect(extractLookSpec).toHaveBeenCalledTimes(1);
                expect(out?.telemetrySample?.gemini?.reference?.failCount).toBe(1);
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
