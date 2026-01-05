const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const nock = require("nock");

const { generateMultiImageImageFromOpenAICompat } = require("../../src/lookReplicator/openaiCompatMultiModal");

function writeTmpPng(bytes, name) {
  const p = path.join(os.tmpdir(), `pivota-test-${process.pid}-${Date.now()}-${name}.png`);
  fs.writeFileSync(p, bytes);
  return p;
}

describe("openaiCompatMultiModal (try-on image) skipSimilarityCheck", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    nock.cleanAll();
  });

  test("skips full-frame similarity check when requested", async () => {
    process.env.OPENAI_BASE_URL = "http://relay.local";
    process.env.OPENAI_API_KEY = "test-key";

    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5Kj9sAAAAASUVORK5CYII=",
      "base64"
    );
    const selfiePath = writeTmpPng(pngBytes, "selfie");
    const targetPath = writeTmpPng(pngBytes, "target");
    const dataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;

    const scope = nock("http://relay.local")
      .post("/v1/chat/completions")
      .times(2)
      .reply(200, { choices: [{ message: { content: [{ type: "image_url", image_url: { url: dataUrl } }] } }] });

    const baseArgs = {
      promptText: "edit image",
      images: [
        { label: "TARGET_IMAGE", imagePath: targetPath },
        { label: "SELFIE_IMAGE", imagePath: selfiePath },
      ],
      model: "gemini-2.5-flash-image-preview",
    };

    const strict = await generateMultiImageImageFromOpenAICompat({ ...baseArgs, skipSimilarityCheck: false });
    expect(strict.ok).toBe(false);
    expect(strict.error.code).toBe("OUTPUT_TOO_SIMILAR");

    const loose = await generateMultiImageImageFromOpenAICompat({ ...baseArgs, skipSimilarityCheck: true });
    expect(loose.ok).toBe(true);
    expect(loose.value.data).toBeTruthy();

    expect(scope.isDone()).toBe(true);

    fs.rmSync(selfiePath, { force: true });
    fs.rmSync(targetPath, { force: true });
  });
});
