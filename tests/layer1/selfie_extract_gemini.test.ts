import fs from "node:fs";
import os from "node:os";
import path from "node:path";

jest.mock("@google/genai", () => ({ GoogleGenAI: jest.fn() }));

function writeTempImage(): string {
  const p = path.join(os.tmpdir(), `pivota-gemini-selfie-${process.pid}-${Date.now()}.png`);
  const onePxPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9qkAAAAASUVORK5CYII=";
  fs.writeFileSync(p, Buffer.from(onePxPngBase64, "base64"));
  return p;
}

function writeTempTextFile(): string {
  const p = path.join(os.tmpdir(), `pivota-gemini-selfie-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(p, "hello", "utf8");
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
    const imgPath = writeTempImage();

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
    const imgPath = writeTempImage();

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
    delete process.env.GEMINI_RATE_PER_MIN;
    delete process.env.GEMINI_CONCURRENCY_MAX;
    delete process.env.GEMINI_CIRCUIT_FAIL_THRESHOLD;
    delete process.env.GEMINI_CIRCUIT_COOLDOWN_MS;
    delete process.env.GEMINI_DEBUG;
    jest.resetModules();
  });

  test("timeout returns ok=false REQUEST_FAILED (fail-closed)", async () => {
    process.env.GEMINI_API_KEY = "test_key";
    process.env.GEMINI_TIMEOUT_MS = "10";
    process.env.GEMINI_MAX_RETRIES = "0";

    const genai = require("@google/genai");
    const imgPath = writeTempImage();

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
    const imgPath = writeTempImage();

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
    const imgPath = writeTempImage();

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

  test("rate limited returns ok=false RATE_LIMITED and does not call SDK", async () => {
    process.env.GEMINI_API_KEY = "test_key";
    process.env.GEMINI_TIMEOUT_MS = "1000";
    process.env.GEMINI_MAX_RETRIES = "0";
    process.env.GEMINI_RATE_PER_MIN = "0";

    const genai = require("@google/genai");
    const imgPath = writeTempImage();

    try {
      const generateContent = jest.fn().mockResolvedValue({ text: "{\"ok\":true}" });
      genai.GoogleGenAI.mockImplementation(() => ({ models: { generateContent } }));

      const { generateLookSpecFromImage } = require("../../src/layer1/llm/geminiClient");
      const out = await generateLookSpecFromImage({
        imagePath: imgPath,
        promptText: "prompt",
        responseJsonSchema: { type: "object" },
      });

      expect(out.ok).toBe(false);
      expect(String(out.error.code)).toBe("RATE_LIMITED");
      expect(genai.GoogleGenAI).toHaveBeenCalledTimes(1); // client construction is local
      expect(generateContent).toHaveBeenCalledTimes(0);
    } finally {
      fs.rmSync(imgPath, { force: true });
    }
  });

  test("circuit opens after repeated failures and returns CIRCUIT_OPEN without calling SDK", async () => {
    process.env.GEMINI_API_KEY = "test_key";
    process.env.GEMINI_TIMEOUT_MS = "1000";
    process.env.GEMINI_MAX_RETRIES = "0";
    process.env.GEMINI_CIRCUIT_FAIL_THRESHOLD = "1";
    process.env.GEMINI_CIRCUIT_COOLDOWN_MS = "60000";

    const genai = require("@google/genai");
    const imgPath = writeTempImage();

    try {
      const generateContent = jest.fn().mockRejectedValue(new Error("503 Service Unavailable"));
      genai.GoogleGenAI.mockImplementation(() => ({ models: { generateContent } }));

      const { generateLookSpecFromImage } = require("../../src/layer1/llm/geminiClient");
      const out1 = await generateLookSpecFromImage({
        imagePath: imgPath,
        promptText: "prompt",
        responseJsonSchema: { type: "object" },
      });
      const out2 = await generateLookSpecFromImage({
        imagePath: imgPath,
        promptText: "prompt",
        responseJsonSchema: { type: "object" },
      });

      expect(out1.ok).toBe(false);
      expect(String(out1.error.code)).toBe("REQUEST_FAILED");
      expect(out2.ok).toBe(false);
      expect(String(out2.error.code)).toBe("CIRCUIT_OPEN");
      expect(generateContent).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(imgPath, { force: true });
    }
  });

  test("preprocess is invoked (best-effort) before SDK call", async () => {
    process.env.GEMINI_API_KEY = "test_key";
    process.env.GEMINI_TIMEOUT_MS = "1000";
    process.env.GEMINI_MAX_RETRIES = "0";

    const genai = require("@google/genai");
    const imgPath = writeTempImage();

    try {
      const preprocessImageForGemini = jest.fn().mockResolvedValue({
        ok: false,
        error: { code: "PREPROCESS_FAILED", message: "no-op" },
      });

      const generateContent = jest.fn().mockResolvedValue({ text: "{\"ok\":true}" });
      genai.GoogleGenAI.mockImplementation(() => ({ models: { generateContent } }));

      await new Promise<void>((resolve, reject) => {
        jest.isolateModules(() => {
          try {
            jest.doMock("../../src/layer1/llm/geminiImagePreprocess", () => ({ preprocessImageForGemini }));
            const { generateLookSpecFromImage } = require("../../src/layer1/llm/geminiClient");
            generateLookSpecFromImage({
              imagePath: imgPath,
              promptText: "prompt",
              responseJsonSchema: { type: "object" },
            })
              .then((out: any) => {
                expect(out.ok).toBe(true);
                expect(preprocessImageForGemini).toHaveBeenCalledTimes(1);
                expect(generateContent).toHaveBeenCalledTimes(1);
                resolve();
              })
              .catch(reject);
          } catch (e) {
            reject(e);
          }
        });
      });
    } finally {
      fs.rmSync(imgPath, { force: true });
    }
  });

  test("non-image input fails closed and does not call SDK", async () => {
    process.env.GEMINI_API_KEY = "test_key";
    process.env.GEMINI_TIMEOUT_MS = "1000";
    process.env.GEMINI_MAX_RETRIES = "0";

    const genai = require("@google/genai");
    const imgPath = writeTempTextFile();

    try {
      const generateContent = jest.fn().mockResolvedValue({ text: "{\"ok\":true}" });
      genai.GoogleGenAI.mockImplementation(() => ({ models: { generateContent } }));

      const { generateLookSpecFromImage } = require("../../src/layer1/llm/geminiClient");
      const out = await generateLookSpecFromImage({
        imagePath: imgPath,
        promptText: "prompt",
        responseJsonSchema: { type: "object" },
      });

      expect(out.ok).toBe(false);
      expect(String(out.error.code)).toBe("PREPROCESS_FAILED");
      expect(generateContent).toHaveBeenCalledTimes(0);
    } finally {
      fs.rmSync(imgPath, { force: true });
    }
  });
});
