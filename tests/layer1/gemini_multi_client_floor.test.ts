import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

jest.mock("@google/genai", () => ({ GoogleGenAI: jest.fn() }));

function writeTempImage(): string {
  const p = path.join(os.tmpdir(), `pivota-gemini-multi-${process.pid}-${Date.now()}.png`);
  const onePxPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9qkAAAAASUVORK5CYII=";
  fs.writeFileSync(p, Buffer.from(onePxPngBase64, "base64"));
  return p;
}

describe("geminiMultiClient model flooring", () => {
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_ONE_CLICK_MODEL;
    delete process.env.PIVOTA_ONE_CLICK_MODEL_GEMINI;
    delete process.env.GEMINI_TRYON_IMAGE_MODEL;
    jest.resetModules();
  });

  test("one-click JSON auto-upgrades legacy Gemini defaults to gemini-3-flash-preview", async () => {
    process.env.GEMINI_API_KEY = "test_key";
    process.env.GEMINI_MODEL = "gemini-2.5-flash";

    const genai = require("@google/genai");
    const imagePath = writeTempImage();

    try {
      const generateContent = jest.fn().mockResolvedValue({ text: JSON.stringify({ ok: true }) });
      genai.GoogleGenAI.mockImplementation(() => ({ models: { generateContent } }));

      const { generateMultiImageJsonFromGemini } = require("../../src/layer1/llm/geminiMultiClient");
      const out = await generateMultiImageJsonFromGemini({
        promptText: "prompt",
        images: [{ label: "image_1", imagePath }],
        schema: z.object({ ok: z.boolean() }).strict(),
      });

      expect(out.ok).toBe(true);
      const call = generateContent.mock.calls[0][0];
      expect(call.model).toBe("gemini-3-flash-preview");
    } finally {
      fs.rmSync(imagePath, { force: true });
    }
  });

  test("try-on image generation defaults to gemini-3.1-flash-image-preview", async () => {
    process.env.GEMINI_API_KEY = "test_key";

    const genai = require("@google/genai");
    const imagePath = writeTempImage();

    try {
      const generateContent = jest.fn().mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: "image/png", data: "ZmFrZQ==" } }],
            },
          },
        ],
      });
      genai.GoogleGenAI.mockImplementation(() => ({ models: { generateContent } }));

      const { generateMultiImageImageFromGemini } = require("../../src/layer1/llm/geminiMultiClient");
      const out = await generateMultiImageImageFromGemini({
        promptText: "prompt",
        images: [{ label: "image_1", imagePath }],
      });

      expect(out.ok).toBe(true);
      const call = generateContent.mock.calls[0][0];
      expect(call.model).toBe("gemini-3.1-flash-image-preview");
    } finally {
      fs.rmSync(imagePath, { force: true });
    }
  });
});
