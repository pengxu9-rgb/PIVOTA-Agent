const fs = require("node:fs");
const path = require("node:path");

function parseEnvString(v) {
  const s = String(v ?? "").trim();
  return s || null;
}

function guessMimeTypeFromPath(p) {
  const ext = String(path.extname(String(p || "")).toLowerCase());
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function extractResponseText(resp) {
  if (!resp) return "";
  if (typeof resp.text === "string") return resp.text;
  if (typeof resp.text === "function") return resp.text();
  if (typeof resp?.response?.text === "function") return resp.response.text();
  if (typeof resp?.response?.text === "string") return resp.response.text;
  return "";
}

async function generateLookSpecFromImage({ imagePath, promptText, responseJsonSchema }) {
  const apiKey = parseEnvString(process.env.GEMINI_API_KEY);
  const model = parseEnvString(process.env.GEMINI_MODEL) || "gemini-2.5-flash";

  if (!apiKey) {
    return { ok: false, error: { code: "MISSING_API_KEY", message: "Missing GEMINI_API_KEY" } };
  }

  let GoogleGenAI = null;
  try {
    ({ GoogleGenAI } = require("@google/genai"));
  } catch (err) {
    return { ok: false, error: { code: "MISSING_DEP", message: "Missing @google/genai dependency" } };
  }

  const imgPath = String(imagePath || "").trim();
  if (!imgPath) {
    return { ok: false, error: { code: "MISSING_IMAGE", message: "Missing imagePath" } };
  }

  try {
    const bytes = fs.readFileSync(imgPath);
    const mimeType = guessMimeTypeFromPath(imgPath);
    const data = bytes.toString("base64");

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType, data } }, { text: String(promptText || "") }],
        },
      ],
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema,
      },
    });

    const text = String(await extractResponseText(response));
    if (!text.trim()) {
      return { ok: false, error: { code: "EMPTY_RESPONSE", message: "Gemini returned empty response text" } };
    }

    return { ok: true, value: text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err || "");
    return { ok: false, error: { code: "REQUEST_FAILED", message: msg.slice(0, 220) } };
  }
}

module.exports = {
  generateLookSpecFromImage,
};

