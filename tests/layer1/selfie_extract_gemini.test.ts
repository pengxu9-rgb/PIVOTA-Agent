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

describe("geminiClient.generateLookSpecFromImage hardening", () => {
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_TIMEOUT_MS;
    delete process.env.GEMINI_MAX_RETRIES;
    delete process.env.GEMINI_RETRY_BASE_DELAY_MS;
    delete process.env.GEMINI_DEBUG;
    jest.resetModules();
  });

  test("timeout returns ok=false REQUEST_FAILED (fail-closed)", async () => {
    process.env.GEMINI_API_KEY = "test_key";
    process.env.GEMINI_TIMEOUT_MS = "10";
    process.env.GEMINI_MAX_RETRIES = "0";

    const genai = require("@google/genai");
    const imgPath = writeTempJpeg();

    try {
      const generateContent = jest.fn().mockImplementation(() => new Promise(() => {}));
      genai.GoogleGenAI.mockImplementation(() => ({ models: { generateContent } }));

      const { generateLookSpecFromImage } = require("../../src/layer1/llm/geminiClient");
      const out = await generateLookSpecFromImage({
        imagePath: imgPath,
        promptText: "prompt",
        responseJsonSchema: { type: "object" },
      });

      expect(out.ok).toBe(false);
      expect(String(out.error.code)).toBe("REQUEST_FAILED");
      expect(String(out.error.message)).toMatch(/timed out|timeout/i);
    } finally {
      fs.rmSync(imgPath, { force: true });
    }
  });

  test("retries once on transient errors (503) and succeeds on second attempt", async () => {
    process.env.GEMINI_API_KEY = "test_key";
    process.env.GEMINI_TIMEOUT_MS = "1000";
    process.env.GEMINI_MAX_RETRIES = "1";
    process.env.GEMINI_RETRY_BASE_DELAY_MS = "1";

    const genai = require("@google/genai");
    const imgPath = writeTempJpeg();

    try {
      const generateContent = jest
        .fn()
        .mockRejectedValueOnce(new Error("503 Service Unavailable"))
        .mockResolvedValueOnce({ text: "{\"ok\":true}" });

      genai.GoogleGenAI.mockImplementation(() => ({ models: { generateContent } }));

      const { generateLookSpecFromImage } = require("../../src/layer1/llm/geminiClient");
      const out = await generateLookSpecFromImage({
        imagePath: imgPath,
        promptText: "prompt",
        responseJsonSchema: { type: "object" },
      });

      expect(out.ok).toBe(true);
      expect(generateContent).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(imgPath, { force: true });
    }
  });

  test("does not call Gemini or retry when GEMINI_API_KEY missing", async () => {
    process.env.GEMINI_MAX_RETRIES = "5";

    const genai = require("@google/genai");
    const imgPath = writeTempJpeg();

    try {
      const generateContent = jest.fn();
      genai.GoogleGenAI.mockImplementation(() => ({ models: { generateContent } }));

      const { generateLookSpecFromImage } = require("../../src/layer1/llm/geminiClient");
      const out = await generateLookSpecFromImage({
        imagePath: imgPath,
        promptText: "prompt",
        responseJsonSchema: { type: "object" },
      });

      expect(out.ok).toBe(false);
      expect(String(out.error.code)).toBe("MISSING_API_KEY");
      expect(genai.GoogleGenAI).toHaveBeenCalledTimes(0);
      expect(generateContent).toHaveBeenCalledTimes(0);
    } finally {
      fs.rmSync(imgPath, { force: true });
    }
  });
});
