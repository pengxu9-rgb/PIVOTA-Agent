/**
 * STAGING / MANUAL ONLY — DO NOT RUN IN CI.
 *
 * End-to-end dry run for:
 * Gemini (reference+selfie) → LookSpecV0 → lookDiff → Layer2 slots → techniqueRefs
 *
 * Requirements:
 * - Provide local image paths:
 *   - REFERENCE_IMAGE_PATH (required)
 *   - SELFIE_IMAGE_PATH (required)
 * - Provide GEMINI_API_KEY (required for this script)
 *
 * This script sets flags ONLY for this process and restores env on exit.
 * It prints a concise report and exits non-zero on missing prerequisites.
 */

const fs = require("node:fs");
const path = require("node:path");

const { extractReferenceLookSpecGemini } = require("../src/layer1/reference/extractReferenceLookSpecGemini");
const { extractSelfieLookSpecGemini } = require("../src/layer1/selfie/extractSelfieLookSpecGemini");
const { getMarketPack } = require("../src/markets/getMarketPack");

function parseEnvString(v) {
  const s = String(v ?? "").trim();
  return s || null;
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readJson(relPathFromRepoRoot) {
  const abs = path.join(__dirname, "..", relPathFromRepoRoot);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function collectWarnings(out) {
  const warnings = Array.isArray(out?.result?.warnings) ? out.result.warnings : [];
  return warnings.map((w) => String(w || "")).filter(Boolean);
}

function collectTechniqueIds(out) {
  const refs = Array.isArray(out?.result?.techniqueRefs) ? out.result.techniqueRefs : [];
  return refs.map((r) => String(r?.id || "").trim()).filter(Boolean);
}

function collectMacroIds(ids) {
  return ids.filter((id) => id.startsWith("US_"));
}

function normalizeLookToken(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s || "unknown";
}

function computeLookNeedsChange({ user, target }) {
  const u = normalizeLookToken(user);
  const t = normalizeLookToken(target);
  return u !== "unknown" && t !== "unknown" && u !== t;
}

function computeIntentNeedsChange({ user, target }) {
  const u = normalizeLookToken(user);
  const t = normalizeLookToken(target);
  return t !== "unknown" && u !== t;
}

function computeNeedsChangeOverview({ targetLookSpec, selfieLookSpec }) {
  const out = {};
  out.eye = computeLookNeedsChange({
    user: selfieLookSpec?.breakdown?.eye?.linerDirection?.direction,
    target: targetLookSpec?.breakdown?.eye?.linerDirection?.direction,
  });
  out.base = [
    computeLookNeedsChange({ user: selfieLookSpec?.breakdown?.base?.finish, target: targetLookSpec?.breakdown?.base?.finish }),
    computeLookNeedsChange({ user: selfieLookSpec?.breakdown?.base?.coverage, target: targetLookSpec?.breakdown?.base?.coverage }),
  ].some(Boolean);
  out.lip = computeLookNeedsChange({
    user: selfieLookSpec?.breakdown?.lip?.finish,
    target: targetLookSpec?.breakdown?.lip?.finish,
  });
  for (const a of ["prep", "contour", "brow", "blush"]) {
    out[a] = computeIntentNeedsChange({
      user: selfieLookSpec?.breakdown?.[a]?.intent,
      target: targetLookSpec?.breakdown?.[a]?.intent,
    });
  }
  return out;
}

async function main() {
  const referencePath = parseEnvString(process.env.REFERENCE_IMAGE_PATH);
  const selfiePath = parseEnvString(process.env.SELFIE_IMAGE_PATH);
  const apiKey = parseEnvString(process.env.GEMINI_API_KEY);

  if (!apiKey) {
    console.log("[staging:gemini:e2e] Missing GEMINI_API_KEY; cannot run staging e2e.");
    process.exit(2);
    return;
  }
  if (!referencePath || !selfiePath) {
    console.log("[staging:gemini:e2e] Missing REFERENCE_IMAGE_PATH or SELFIE_IMAGE_PATH.");
    process.exit(2);
    return;
  }
  if (!fileExists(referencePath) || !fileExists(selfiePath)) {
    console.log("[staging:gemini:e2e] One of the provided image paths does not exist or is not a file.");
    process.exit(2);
    return;
  }

  const market = parseEnvString(process.env.MARKET) || "US";
  const locale = parseEnvString(process.env.LOCALE) || "en-US";
  const preferenceMode = parseEnvString(process.env.PREFERENCE_MODE) || "structure";
  const pack = getMarketPack({ market, locale });
  const promptPack = pack.getPromptPack(locale);

  const envBackup = { ...process.env };

  try {
    process.env.LAYER2_ENABLE_SELFIE_LOOKSPEC = "1";
    process.env.LAYER1_ENABLE_GEMINI_SELFIE_LOOKSPEC = "1";
    process.env.LAYER1_ENABLE_GEMINI_REFERENCE_LOOKSPEC = "1";
    process.env.LAYER2_ENABLE_TRIGGER_MATCHING = "1";
    process.env.LAYER2_ENABLE_EXTENDED_AREAS = "1";
    process.env.LAYER2_ENABLE_EYE_ACTIVITY_SLOT = "1";
    process.env.LAYER2_ENABLE_BASE_ACTIVITY_SLOT = "1";
    process.env.LAYER2_ENABLE_LIP_ACTIVITY_SLOT = "1";

    const { runLookReplicatePipeline } = require("../src/lookReplicator/lookReplicatePipeline");

    // Optional helper context (keeps pipeline compatible with existing expectations).
    const layer1Bundle = readJson("fixtures/contracts/us/layer1BundleV0.sample.json");

    // For reporting needsChange in a stable way, run the same Gemini extractors directly.
    // This is staging/manual only; it does not affect pipeline behavior.
    const [referenceGemini, selfieGemini] = await Promise.all([
      extractReferenceLookSpecGemini({ market, locale, imagePath: referencePath, promptText: promptPack?.lookSpecExtract }),
      extractSelfieLookSpecGemini({ market, locale, imagePath: selfiePath, promptText: promptPack?.lookSpecExtract }),
    ]);

    const out = await runLookReplicatePipeline({
      market,
      locale,
      preferenceMode,
      jobId: `staging_gemini_${Date.now()}`,
      referenceImage: { path: referencePath, contentType: "image/jpeg" },
      selfieImage: { path: selfiePath, contentType: "image/jpeg" },
      layer1Bundle,
    });

    const warnings = collectWarnings(out);
    const ids = collectTechniqueIds(out);
    const macroIds = collectMacroIds(ids);
    const lookDiffSource = out?.telemetrySample?.gemini?.lookDiffSource || null;
    const needsChangeSummary =
      referenceGemini?.ok && selfieGemini?.ok
        ? computeNeedsChangeOverview({ targetLookSpec: referenceGemini.value, selfieLookSpec: selfieGemini.value })
        : { eye: false, base: false, lip: false, prep: false, contour: false, brow: false, blush: false };

    const scaryWarnings = warnings.filter((w) =>
      /Technique language fallback|Missing technique card|mismatch|NO_CANDIDATES/i.test(String(w)),
    );

    const report = [
      "=== staging:gemini:e2e ===",
      `market=${market} locale=${locale} preferenceMode=${preferenceMode}`,
      `lookDiffSource=${String(lookDiffSource || "(unknown)")}`,
      `gemini.reference.ok=${Boolean(referenceGemini?.ok)} gemini.selfie.ok=${Boolean(selfieGemini?.ok)}`,
      `needsChange={eye:${needsChangeSummary.eye},base:${needsChangeSummary.base},lip:${needsChangeSummary.lip},prep:${needsChangeSummary.prep},contour:${needsChangeSummary.contour},brow:${needsChangeSummary.brow},blush:${needsChangeSummary.blush}}`,
      `macroIds=${JSON.stringify(macroIds)}`,
      `warningsTotal=${warnings.length} scaryWarnings=${scaryWarnings.length}`,
    ].join("\n");

    console.log(report);

    if (scaryWarnings.length) {
      console.log("\n[staging:gemini:e2e] Scary warnings:");
      for (const w of scaryWarnings) console.log(`- ${w}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.log("[staging:gemini:e2e] FAILED");
    console.log(err instanceof Error ? err.message : String(err || ""));
    process.exitCode = 1;
  } finally {
    process.env = envBackup;
  }
}

main();
