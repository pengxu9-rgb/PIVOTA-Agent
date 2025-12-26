import nock from "nock";
import { z } from "zod";

import { createOpenAiCompatibleProvider, createProviderFromEnv } from "../../src/llm/provider";

describe("LLM provider (OpenAI-compatible)", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env.LLM_BASE_URL = "http://llm.local";
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_MODEL_NAME = "test-model";
  });

  afterEach(() => {
    process.env = { ...envBackup };
    nock.cleanAll();
  });

  test("rejects non-JSON model output", async () => {
    const scope = nock("http://llm.local")
      .post("/v1/chat/completions")
      .times(3) // provider retries on parse failures
      .reply(200, {
        choices: [{ message: { content: "not json" } }],
      });

    const provider = createOpenAiCompatibleProvider();

    await expect(
      provider.analyzeImageToJson({
        prompt: "Return JSON only",
        image: { kind: "url", url: "https://example.com/ref.jpg" },
        schema: z.object({ foo: z.string().min(1) }).strict(),
      })
    ).rejects.toMatchObject({ code: "LLM_PARSE_FAILED" });

    expect(scope.isDone()).toBe(true);
  });
});

describe("LLM provider (env selection)", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    nock.cleanAll();
  });

  test("uses Gemini when configured", async () => {
    process.env.PIVOTA_LAYER2_LLM_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GEMINI_BASE_URL = "http://gemini.local";
    process.env.PIVOTA_LAYER2_MODEL_GEMINI = "gemini-1.5-flash";

    nock("http://gemini.local")
      .post("/v1beta/models/gemini-1.5-flash:generateContent")
      .query(true)
      .reply(200, {
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ foo: "bar" }) }],
            },
          },
        ],
      });

    const provider = createProviderFromEnv("layer2_lookspec");
    const out = await provider.analyzeImageToJson({
      prompt: "Return JSON only",
      image: { kind: "bytes", bytes: Buffer.from("x"), contentType: "image/jpeg" },
      schema: z.object({ foo: z.string().min(1) }).strict(),
    });

    expect(out.foo).toBe("bar");
  });
});
