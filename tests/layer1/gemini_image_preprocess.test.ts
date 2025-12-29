/* eslint-disable @typescript-eslint/no-var-requires */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { preprocessImageForGemini } = require("../../src/layer1/llm/geminiImagePreprocess");

describe("geminiImagePreprocess", () => {
  test("creates a resized JPEG in tmp (no throw)", async () => {
    const sharp = require("sharp");
    const inputPath = path.join(os.tmpdir(), `pivota-pre-in-${process.pid}-${Date.now()}.png`);
    const outPaths: string[] = [];

    try {
      await sharp({
        create: { width: 200, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
      })
        .png()
        .toFile(inputPath);

      const out = await preprocessImageForGemini({ imagePath: inputPath, maxEdge: 64, quality: 80, tmpDir: os.tmpdir() });
      expect(out.ok).toBe(true);
      expect(typeof out.path).toBe("string");
      outPaths.push(out.path);

      const meta = await sharp(out.path).metadata();
      expect(meta.format).toBe("jpeg");
      expect(typeof meta.width).toBe("number");
      expect(typeof meta.height).toBe("number");
      expect((meta.width || 0) <= 64).toBe(true);
      expect((meta.height || 0) <= 64).toBe(true);
    } finally {
      fs.rmSync(inputPath, { force: true });
      for (const p of outPaths) fs.rmSync(p, { force: true });
    }
  });
});

