import fs from "node:fs";
import os from "node:os";
import path from "node:path";

jest.mock("@google/genai", () => ({ GoogleGenAI: jest.fn() }));

function writeTempJpeg(): string {
  const p = path.join(os.tmpdir(), `pivota-gemini-selfie-${process.pid}-${Date.now()}.jpg`);
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return p;
}

describe("extractSelfieLookSpecGemini", () => {
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;
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
          lookTitle: "selfie",
          styleTags: [],
          breakdown: {
            base: { intent: "unknown", finish: "matte", coverage: "sheer", keyNotes: [], evidence: [] },
            eye: {
              intent: "unknown",
              finish: "unknown",
              coverage: "unknown",
              keyNotes: [],
              evidence: [],
              linerDirection: { direction: "up" },
            },
            lip: { intent: "unknown", finish: "gloss", coverage: "unknown", keyNotes: [], evidence: [] },
          },
          warnings: [],
        }),
      });

      genai.GoogleGenAI.mockImplementation(() => ({ models: { generateContent } }));

      const { extractSelfieLookSpecGemini, LookSpecExtractCoreJsonSchema } = require("../../src/layer1/selfie/extractSelfieLookSpecGemini");
      const out = await extractSelfieLookSpecGemini({
        market: "US",
        locale: "en-US",
        imagePath: imgPath,
        promptText: "prompt",
      });

      expect(out.ok).toBe(true);
      expect(out.value.schemaVersion).toBe("v0");
      expect(out.value.market).toBe("US");
      expect(out.value.breakdown.eye.linerDirection.direction).toBe("up");

      expect(generateContent).toHaveBeenCalledTimes(1);
      const call = generateContent.mock.calls[0][0];
      expect(call.config.responseMimeType).toBe("application/json");
      expect(call.config.temperature).toBe(0);
      expect(call.config.responseJsonSchema).toEqual(LookSpecExtractCoreJsonSchema);
    } finally {
      fs.rmSync(imgPath, { force: true });
    }
  });

  test("fail-closed when Gemini returns invalid JSON", async () => {
    process.env.GEMINI_API_KEY = "test_key";

    const genai = require("@google/genai");
    const imgPath = writeTempJpeg();

    try {
      const generateContent = jest.fn().mockResolvedValue({ text: "not-json" });
      genai.GoogleGenAI.mockImplementation(() => ({ models: { generateContent } }));

      const { extractSelfieLookSpecGemini } = require("../../src/layer1/selfie/extractSelfieLookSpecGemini");
      const out = await extractSelfieLookSpecGemini({
        market: "US",
        locale: "en-US",
        imagePath: imgPath,
        promptText: "prompt",
      });

      expect(out.ok).toBe(false);
      expect(String(out.error.code)).toBe("JSON_PARSE_FAILED");
    } finally {
      fs.rmSync(imgPath, { force: true });
    }
  });
});
