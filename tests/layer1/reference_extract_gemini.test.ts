import fs from "node:fs";
import os from "node:os";
import path from "node:path";

jest.mock("@google/genai", () => ({ GoogleGenAI: jest.fn() }));

function writeTempJpeg(): string {
  const p = path.join(os.tmpdir(), `pivota-gemini-reference-${process.pid}-${Date.now()}.png`);
  const onePxPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9qkAAAAASUVORK5CYII=";
  fs.writeFileSync(p, Buffer.from(onePxPngBase64, "base64"));
  return p;
}

describe("extractReferenceLookSpecGemini", () => {
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_TIMEOUT_MS;
    delete process.env.GEMINI_MAX_RETRIES;
    delete process.env.GEMINI_RETRY_BASE_DELAY_MS;
    delete process.env.GEMINI_DEBUG;
    jest.resetModules();
  });

  test("requests structured JSON and parses into LookSpecV0", async () => {
    process.env.GEMINI_API_KEY = "test_key";
    process.env.GEMINI_MODEL = "gemini-2.5-flash";

    const genai = require("@google/genai");
    const imgPath = writeTempJpeg();

    try {
      const generateContent = jest.fn().mockResolvedValue({
        text: JSON.stringify({
          lookTitle: "reference",
          styleTags: [],
          breakdown: {
            base: { intent: "unknown", finish: "matte", coverage: "sheer", keyNotes: [], evidence: [] },
            eye: {
              intent: "unknown",
              finish: "unknown",
              coverage: "unknown",
              keyNotes: [],
              evidence: [],
              linerDirection: { direction: "straight" },
            },
            lip: { intent: "unknown", finish: "gloss", coverage: "unknown", keyNotes: [], evidence: [] },
          },
          warnings: [],
        }),
      });

      genai.GoogleGenAI.mockImplementation(() => ({ models: { generateContent } }));

      const { LookSpecExtractCoreJsonSchema } = require("../../src/layer1/selfie/extractSelfieLookSpecGemini");
      const { extractReferenceLookSpecGemini } = require("../../src/layer1/reference/extractReferenceLookSpecGemini");

      const out = await extractReferenceLookSpecGemini({
        market: "US",
        locale: "en-US",
        imagePath: imgPath,
        promptText: "prompt",
      });

      expect(out.ok).toBe(true);
      expect(out.value.schemaVersion).toBe("v0");
      expect(out.value.market).toBe("US");
      expect(out.value.breakdown.eye.linerDirection.direction).toBe("straight");

      expect(generateContent).toHaveBeenCalledTimes(1);
      const call = generateContent.mock.calls[0][0];
      expect(call.config.responseMimeType).toBe("application/json");
      expect(call.config.temperature).toBe(0);
      expect(call.config.responseJsonSchema).toEqual(LookSpecExtractCoreJsonSchema);
    } finally {
      fs.rmSync(imgPath, { force: true });
    }
  });
});
