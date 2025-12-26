import axios, { AxiosError } from "axios";
import { z } from "zod";

export type ImageInput =
  | { kind: "url"; url: string }
  | { kind: "bytes"; bytes: Buffer; contentType: string };

export class LlmError extends Error {
  public readonly code:
    | "LLM_CONFIG_MISSING"
    | "LLM_REQUEST_FAILED"
    | "LLM_TIMEOUT"
    | "LLM_PARSE_FAILED"
    | "LLM_SCHEMA_INVALID";

  public readonly cause?: unknown;

  constructor(
    code: LlmError["code"],
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

export interface LlmProvider {
  analyzeImageToJson<TSchema extends z.ZodTypeAny>(input: {
    prompt: string;
    image: ImageInput;
    schema: TSchema;
  }): Promise<z.infer<TSchema>>;
}

function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : undefined;
}

function toDataUrl(bytes: Buffer, contentType: string): string {
  const b64 = bytes.toString("base64");
  return `data:${contentType};base64,${b64}`;
}

function extractJsonObject(text: string): unknown {
  const raw = String(text || "").trim();
  if (!raw) throw new LlmError("LLM_PARSE_FAILED", "Empty model output");

  // Fast path: valid JSON already
  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }

  // Common failure mode: code fences or extra prose. Extract the first {...} block.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new LlmError("LLM_PARSE_FAILED", "Model output is not JSON");
  }
  const sliced = raw.slice(start, end + 1);
  try {
    return JSON.parse(sliced);
  } catch (err) {
    throw new LlmError("LLM_PARSE_FAILED", "Failed to parse JSON from model output", err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof LlmError) {
    return err.code === "LLM_TIMEOUT" || err.code === "LLM_REQUEST_FAILED" || err.code === "LLM_PARSE_FAILED";
  }
  return false;
}

export function createOpenAiCompatibleProvider(): LlmProvider {
  const baseUrl = getEnv("LLM_BASE_URL");
  const apiKey = getEnv("LLM_API_KEY");
  const model = getEnv("LLM_MODEL_NAME");

  if (!baseUrl || !apiKey || !model) {
    throw new LlmError(
      "LLM_CONFIG_MISSING",
      "Missing required env vars: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_NAME"
    );
  }

  const client = axios.create({
    baseURL: baseUrl.replace(/\/$/, ""),
    timeout: Number(getEnv("LLM_TIMEOUT_MS") || "20000"),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  return {
    async analyzeImageToJson({ prompt, image, schema }) {
      const imageUrl =
        image.kind === "url" ? image.url : toDataUrl(image.bytes, image.contentType);

      const maxAttempts = 1 + 2; // initial + 2 retries
      let lastErr: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await client.post("/v1/chat/completions", {
            model,
            temperature: 0.2,
            max_tokens: 900,
            messages: [
              {
                role: "system",
                content:
                  "You are a strict JSON generator. Output JSON only. No markdown, no extra keys, no prose.",
              },
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  { type: "image_url", image_url: { url: imageUrl } },
                ],
              },
            ],
          });

          const content =
            response.data?.choices?.[0]?.message?.content ??
            response.data?.choices?.[0]?.message?.content?.[0]?.text ??
            "";

          const json = extractJsonObject(String(content));
          const parsed = schema.safeParse(json);
          if (!parsed.success) {
            throw new LlmError(
              "LLM_SCHEMA_INVALID",
              "Model JSON did not match expected schema",
              parsed.error
            );
          }
          return parsed.data;
        } catch (err) {
          if (err instanceof LlmError && err.code === "LLM_SCHEMA_INVALID") {
            // Don't retry schema mismatch; it's deterministic given the output.
            throw err;
          }

          if (err instanceof AxiosError) {
            const status = err.response?.status;
            if (err.code === "ECONNABORTED") {
              lastErr = new LlmError("LLM_TIMEOUT", "LLM request timed out", err);
            } else {
              const msg = status
                ? `LLM request failed (HTTP ${status})`
                : "LLM request failed";
              lastErr = new LlmError("LLM_REQUEST_FAILED", msg, err);
            }
          } else {
            lastErr = err;
          }

          if (attempt < maxAttempts && isRetryableError(lastErr)) {
            await sleep(250 * attempt);
            continue;
          }
          throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
        }
      }

      throw lastErr instanceof Error ? lastErr : new Error("LLM request failed");
    },
  };
}

