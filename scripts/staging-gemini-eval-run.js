/**
 * STAGING / MANUAL ONLY — DO NOT RUN IN CI.
 *
 * Batch evaluation runner for Step 13 (staging evaluation + metrics).
 * - Reads a JSON array of pairs from `GEMINI_EVAL_PAIRS_JSON=/abs/path/pairs.json`
 * - Runs the production pipeline per pair with Gemini flags enabled (process-local)
 * - Prints a human summary + a machine-readable line: `REPORT_JSON=<json>`
 *
 * Exit codes:
 * - 0: completed and printed report
 * - 2: missing GEMINI_API_KEY / missing pairs file / invalid pairs (expected guardrail; no stacktrace)
 * - 1: unexpected error (may print error details)
 */

const fs = require("node:fs");
const path = require("node:path");

const { summarizeRuns, extractNeedsChange, extractSlotEmits, extractMacroIds } = require("./_utils/geminiEvalReport");

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

function toAbs(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function safeJsonParse(s) {
  return JSON.parse(String(s || ""));
}

function boolEnv(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(s);
}

function stableJsonStringify(obj) {
  return JSON.stringify(obj);
}

function pickTrueKeys(map) {
  const out = [];
  for (const [k, v] of Object.entries(map || {})) if (v === true) out.push(k);
  return out.sort();
}

async function runOne({ idx, pair, layer1Bundle }) {
  const t0 = Date.now();
  const market = String(pair.market || "US");
  const locale = String(pair.locale || "en-US");
  const preferenceMode = String(pair.preferenceMode || "structure");

  const referenceImagePath = String(pair.referenceImagePath || "").trim();
  const selfieImagePath = String(pair.selfieImagePath || "").trim();

  const { runLookReplicatePipeline } = require("../src/lookReplicator/lookReplicatePipeline");

  try {
    const out = await runLookReplicatePipeline({
      market,
      locale,
      preferenceMode,
      jobId: `staging_gemini_eval_${Date.now()}_${idx}`,
      referenceImage: { path: referenceImagePath, contentType: "image/jpeg" },
      selfieImage: { path: selfieImagePath, contentType: "image/jpeg" },
      layer1Bundle,
    });

    const totalMs = Date.now() - t0;
    const skeletons = out?.telemetrySample?.replayContext?.adjustmentSkeletons || [];
    const gemini = out?.telemetrySample?.gemini || null;
    const similarityReport = gemini?.lookDiff ? { lookDiff: gemini.lookDiff } : null;
    const result = out?.result || null;

    return {
      ok: true,
      totalMs,
      market,
      locale,
      preferenceMode,
      gemini,
      similarityReport,
      skeletons,
      result,
      error: null,
    };
  } catch (err) {
    const totalMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err || "");
    return {
      ok: false,
      totalMs,
      market,
      locale,
      preferenceMode,
      gemini: null,
      similarityReport: null,
      skeletons: [],
      result: null,
      error: msg.slice(0, 220),
    };
  }
}

async function main() {
  const apiKey = parseEnvString(process.env.GEMINI_API_KEY);
  if (!apiKey) {
    console.log("[staging:gemini:eval] Missing GEMINI_API_KEY; cannot run.");
    process.exit(2);
    return;
  }

  const pairsPathEnv = parseEnvString(process.env.GEMINI_EVAL_PAIRS_JSON);
  if (!pairsPathEnv) {
    console.log("[staging:gemini:eval] Missing GEMINI_EVAL_PAIRS_JSON=/abs/path/pairs.json");
    process.exit(2);
    return;
  }

  const pairsPath = toAbs(pairsPathEnv);
  if (!fileExists(pairsPath)) {
    console.log(`[staging:gemini:eval] Pairs file not found: ${pairsPath}`);
    process.exit(2);
    return;
  }

  let pairs;
  try {
    pairs = safeJsonParse(fs.readFileSync(pairsPath, "utf8"));
  } catch {
    console.log("[staging:gemini:eval] Failed to parse pairs JSON.");
    process.exit(2);
    return;
  }

  if (!Array.isArray(pairs) || pairs.length === 0) {
    console.log("[staging:gemini:eval] Pairs JSON must be a non-empty array.");
    process.exit(2);
    return;
  }

  for (const [i, p] of pairs.entries()) {
    const ref = String(p?.referenceImagePath || "").trim();
    const selfie = String(p?.selfieImagePath || "").trim();
    if (!ref || !selfie) {
      console.log(`[staging:gemini:eval] Invalid pair at idx=${i}: missing referenceImagePath/selfieImagePath.`);
      process.exit(2);
      return;
    }
    if (!fileExists(ref) || !fileExists(selfie)) {
      console.log(`[staging:gemini:eval] Invalid pair at idx=${i}: file path missing (ref/selfie).`);
      process.exit(2);
      return;
    }
  }

  const envBackup = { ...process.env };
  const debugEnabled = boolEnv(process.env.GEMINI_DEBUG) || boolEnv(process.env.LAYER1_SELFIE_DEBUG);

  try {
    process.env.LAYER1_ENABLE_GEMINI_REFERENCE_LOOKSPEC = "1";
    process.env.LAYER1_ENABLE_GEMINI_SELFIE_LOOKSPEC = "1";
    process.env.LAYER2_ENABLE_SELFIE_LOOKSPEC = "1";
    process.env.LAYER2_ENABLE_TRIGGER_MATCHING = "1";
    process.env.LAYER2_ENABLE_EXTENDED_AREAS = "1";

    // Optional: keep slot flags on for coverage (rules still gate emission on needsChange).
    process.env.LAYER2_ENABLE_EYE_ACTIVITY_SLOT = "1";
    process.env.LAYER2_ENABLE_BASE_ACTIVITY_SLOT = "1";
    process.env.LAYER2_ENABLE_LIP_ACTIVITY_SLOT = "1";

    // Provide a similarityReport container so lookDiff can be merged (matches existing staging script behavior).
    const layer1Bundle = require("../fixtures/contracts/us/layer1BundleV0.sample.json");

    const runs = [];
    for (let idx = 0; idx < pairs.length; idx++) {
      const pair = pairs[idx];
      // eslint-disable-next-line no-await-in-loop
      const rec = await runOne({ idx, pair, layer1Bundle });
      runs.push(rec);
      if (debugEnabled) {
        // eslint-disable-next-line no-console
        console.log(
          `[staging:gemini:eval] idx=${idx} ok=${rec.ok} market=${rec.market} locale=${rec.locale} totalMs=${rec.totalMs}`,
        );
      }
    }

    const summary = summarizeRuns(
      runs.map((r) => ({
        ok: r.ok,
        totalMs: r.totalMs,
        gemini: r.gemini,
        similarityReport: r.similarityReport,
        skeletons: r.skeletons,
        result: r.result,
      })),
    );

    const limiter = runs.find((r) => r?.gemini?.limiter)?.gemini?.limiter || null;

    const okRateStr = summary.okRate == null ? "null" : (summary.okRate * 100).toFixed(1) + "%";
    const lines = [
      "=== staging:gemini:eval summary ===",
      `n=${summary.n} okCount=${summary.okCount} okRate=${okRateStr}`,
      `totalMsP50=${summary.totalMsP50 ?? "null"} totalMsP95=${summary.totalMsP95 ?? "null"}`,
      `gemini.referenceOkRate=${summary.gemini.referenceOkRate ?? "null"} selfieOkRate=${summary.gemini.selfieOkRate ?? "null"}`,
      `gemini.referenceLatencyMsP50=${summary.gemini.referenceLatencyMsP50 ?? "null"} referenceLatencyMsP95=${summary.gemini.referenceLatencyMsP95 ?? "null"}`,
      `gemini.selfieLatencyMsP50=${summary.gemini.selfieLatencyMsP50 ?? "null"} selfieLatencyMsP95=${summary.gemini.selfieLatencyMsP95 ?? "null"}`,
      `errorCodeCounts=${stableJsonStringify(summary.gemini.errorCodeCounts)}`,
      `limiter=${stableJsonStringify(limiter)}`,
      `macroUnique=${summary.macroIdCounts.uniqueCount} macroTop=${stableJsonStringify(summary.macroIdCounts.top)}`,
    ];
    console.log(lines.join("\n"));

    console.log(`REPORT_JSON=${stableJsonStringify(summary)}`);

    console.log("\n=== spot-check (first 10) ===");
    const spot = runs.slice(0, 10);
    for (let i = 0; i < spot.length; i++) {
      const r = spot[i];
      const needsTrue = pickTrueKeys(extractNeedsChange(r.similarityReport));
      const slotsTrue = pickTrueKeys(extractSlotEmits(r.skeletons));
      const macros = extractMacroIds(r.result);
      const refErr =
        typeof r.gemini?.reference?.errorCode === "string"
          ? r.gemini.reference.errorCode
          : r.gemini?.reference?.failCount
            ? r.gemini?.reference?.lastErrorCode
            : null;
      const selfieErr =
        typeof r.gemini?.selfie?.errorCode === "string"
          ? r.gemini.selfie.errorCode
          : r.gemini?.selfie?.failCount
            ? r.gemini?.selfie?.lastErrorCode
            : null;
      console.log(
        `idx=${i} ok=${r.ok} market=${r.market} locale=${r.locale} totalMs=${r.totalMs} macroIds=${stableJsonStringify(
          macros,
        )} needsChange=${stableJsonStringify(needsTrue)} slots=${stableJsonStringify(slotsTrue)} geminiErr=${stableJsonStringify(
          { reference: refErr, selfie: selfieErr },
        )}`,
      );
    }

    if (runs.some((r) => !r.ok)) process.exitCode = 1;
  } catch (err) {
    console.error("[staging:gemini:eval] FAILED");
    console.error(err);
    process.exitCode = 1;
  } finally {
    process.env = envBackup;
  }
}

main();
