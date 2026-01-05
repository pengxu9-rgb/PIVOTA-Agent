jest.mock("../../src/lookReplicator/openaiCompatMultiModal", () => {
  return {
    generateMultiImageImageFromOpenAICompat: jest.fn(),
  };
});

jest.mock("../../src/lookReplicator/tryOnFaceComposite", () => {
  return {
    applyTryOnFaceComposite: jest.fn(),
  };
});

const { generateMultiImageImageFromOpenAICompat } = require("../../src/lookReplicator/openaiCompatMultiModal");
const { applyTryOnFaceComposite } = require("../../src/lookReplicator/tryOnFaceComposite");
const { runTryOnGenerateImageOpenAICompat } = require("../../src/lookReplicator/tryOnGenerateImageOpenAICompat");

describe("tryOnGenerateImageOpenAICompat (no-op retry)", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    jest.clearAllMocks();
  });

  test("retries generation when blended output is too similar", async () => {
    process.env.LOOK_REPLICATOR_TRYON_MODEL_OPENAI = "gemini-2.5-flash-image-preview";
    process.env.LOOK_REPLICATOR_TRYON_FACE_BLEND = "1";
    process.env.LOOK_REPLICATOR_TRYON_VARIATION_ATTEMPTS = "2";

    generateMultiImageImageFromOpenAICompat
      .mockResolvedValueOnce({
        ok: true,
        value: { mimeType: "image/png", data: Buffer.from("x").toString("base64"), ext: "png" },
        meta: { model: "gemini-2.5-flash-image-preview", attempted: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { mimeType: "image/png", data: Buffer.from("y").toString("base64"), ext: "png" },
        meta: { model: "gemini-2.5-flash-image-preview", attempted: true },
      });

    applyTryOnFaceComposite
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "OUTPUT_TOO_SIMILAR", message: "too similar" },
        meta: { diffScore: 4, dhashDist: 1 },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { mimeType: "image/png", dataB64: Buffer.from("z").toString("base64") },
        meta: { diffScore: 10, dhashDist: 12 },
      });

    const res = await runTryOnGenerateImageOpenAICompat({
      targetImagePath: "/tmp/target.jpg",
      selfieImagePath: "/tmp/selfie.jpg",
      currentRenderImagePath: null,
      userRequest: null,
      contextJson: null,
      faceBox: null,
      faceMaskPath: null,
    });

    expect(res.ok).toBe(true);
    expect(generateMultiImageImageFromOpenAICompat).toHaveBeenCalledTimes(2);
    expect(applyTryOnFaceComposite).toHaveBeenCalledTimes(2);
    expect(res.meta.variationAttempt).toBe(2);
    expect(res.meta.variationAttempts).toBe(2);
  });
});

