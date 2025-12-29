function percentile(values, p) {
  const nums = Array.isArray(values) ? values.filter((v) => Number.isFinite(v)) : [];
  if (!nums.length) return null;
  const q = Number(p);
  if (!Number.isFinite(q)) return null;
  const sorted = nums.slice().sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const clamped = Math.min(1, Math.max(0, q));
  const rank = clamped * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * w;
}

function safeBool(v) {
  return v === true;
}

function extractNeedsChange(similarityReport) {
  const lookDiff = similarityReport?.lookDiff || null;
  return {
    "eye.linerDirection": safeBool(lookDiff?.eye?.linerDirection?.needsChange),
    "base.finish": safeBool(lookDiff?.base?.finish?.needsChange),
    "base.coverage": safeBool(lookDiff?.base?.coverage?.needsChange),
    "lip.finish": safeBool(lookDiff?.lip?.finish?.needsChange),
    "prep.intent": safeBool(lookDiff?.prep?.intent?.needsChange),
    "contour.intent": safeBool(lookDiff?.contour?.intent?.needsChange),
    "brow.intent": safeBool(lookDiff?.brow?.intent?.needsChange),
    "blush.intent": safeBool(lookDiff?.blush?.intent?.needsChange),
  };
}

const SLOT_RULE_IDS = [
  "EYE_LINER_ACTIVITY_SLOT",
  "BASE_ACTIVITY_SLOT",
  "LIP_ACTIVITY_SLOT",
  "PREP_ACTIVITY_SLOT",
  "CONTOUR_ACTIVITY_SLOT",
  "BROW_ACTIVITY_SLOT",
  "BLUSH_ACTIVITY_SLOT",
];

function extractSlotEmits(skeletons) {
  const list = Array.isArray(skeletons) ? skeletons : [];
  const seen = new Set(
    list
      .map((s) => String(s?.ruleId || "").trim())
      .filter(Boolean),
  );
  const out = {};
  for (const id of SLOT_RULE_IDS) out[id] = seen.has(id);
  return out;
}

function extractMacroIds(result) {
  const refs = Array.isArray(result?.techniqueRefs) ? result.techniqueRefs : [];
  const out = [];
  const seen = new Set();
  for (const r of refs) {
    const id = String(r?.id || "").trim();
    if (!id) continue;
    if (!id.startsWith("US_")) continue;
    if (id.startsWith("T_")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function safeString(v) {
  const s = String(v ?? "").trim();
  return s || null;
}

function inc(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

function normalizeGeminiCall(gemini, kind) {
  const g = gemini || null;
  const k = String(kind || "").trim();
  if (!g || !k) return { hasAny: false, attempted: false, ok: false, latencyMs: null, errorCode: null };

  // New schema: { reference/selfie: { enabled, attempted, ok, errorCode, latencyMs, retries, model }, limiter, ... }
  const call = g?.[k] || null;
  if (call && typeof call === "object" && "attempted" in call && "enabled" in call) {
    const attempted = call.attempted === true;
    const ok = call.ok === true;
    const latencyMs = Number.isFinite(call.latencyMs) ? call.latencyMs : null;
    const errorCode = call.ok === false ? safeString(call.errorCode) : null;
    return { hasAny: call.enabled === true || attempted, attempted, ok, latencyMs, errorCode };
  }

  // Legacy schema: { reference/selfie: { okCount, failCount, lastErrorCode, latencyMs } }
  const okCount = Number(g?.[k]?.okCount) || 0;
  const failCount = Number(g?.[k]?.failCount) || 0;
  const attempted = okCount + failCount > 0;
  const ok = okCount > 0;
  const latencyMs = Number.isFinite(g?.[k]?.latencyMs) ? g[k].latencyMs : null;
  const errorCode = failCount > 0 ? safeString(g?.[k]?.lastErrorCode) : null;
  return { hasAny: attempted, attempted, ok, latencyMs, errorCode };
}

function topNCounts(counts, n) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([id, count]) => ({ id, count }));
}

function summarizeRuns(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const n = list.length;
  const okCount = list.filter((r) => r?.ok === true).length;
  const okRate = n ? okCount / n : null;

  const totalMs = list.map((r) => r?.totalMs).filter((v) => Number.isFinite(v));

  const needsKeys = Object.keys(extractNeedsChange({ lookDiff: {} }));
  const needsTrueCounts = Object.fromEntries(needsKeys.map((k) => [k, 0]));

  const slotTrueCounts = Object.fromEntries(SLOT_RULE_IDS.map((k) => [k, 0]));

  const macroCounts = {};

  const geminiReferenceLatencies = [];
  const geminiSelfieLatencies = [];
  const errorCodeCounts = {};
  let referenceAttempts = 0;
  let selfieAttempts = 0;
  let referenceOk = 0;
  let selfieOk = 0;

  for (const r of list) {
    const needs = extractNeedsChange(r?.similarityReport);
    for (const k of needsKeys) if (needs[k]) needsTrueCounts[k] += 1;

    const slots = extractSlotEmits(r?.skeletons);
    for (const k of SLOT_RULE_IDS) if (slots[k]) slotTrueCounts[k] += 1;

    const macros = extractMacroIds(r?.result);
    for (const id of macros) inc(macroCounts, id);

    const g = r?.gemini || null;
    const ref = normalizeGeminiCall(g, "reference");
    const selfie = normalizeGeminiCall(g, "selfie");

    if (ref.hasAny) {
      referenceAttempts += 1;
      if (ref.ok) referenceOk += 1;
      if (Number.isFinite(ref.latencyMs)) geminiReferenceLatencies.push(ref.latencyMs);
      if (ref.attempted && !ref.ok) inc(errorCodeCounts, ref.errorCode || "UNKNOWN");
    }

    if (selfie.hasAny) {
      selfieAttempts += 1;
      if (selfie.ok) selfieOk += 1;
      if (Number.isFinite(selfie.latencyMs)) geminiSelfieLatencies.push(selfie.latencyMs);
      if (selfie.attempted && !selfie.ok) inc(errorCodeCounts, selfie.errorCode || "UNKNOWN");
    }
  }

  const needsChangeRates = Object.fromEntries(
    needsKeys.map((k) => [k, n ? needsTrueCounts[k] / n : null]),
  );
  const slotEmitRates = Object.fromEntries(SLOT_RULE_IDS.map((k) => [k, n ? slotTrueCounts[k] / n : null]));

  return {
    n,
    okCount,
    okRate,
    totalMsP50: percentile(totalMs, 0.5),
    totalMsP95: percentile(totalMs, 0.95),
    gemini: {
      referenceOkRate: referenceAttempts ? referenceOk / referenceAttempts : null,
      selfieOkRate: selfieAttempts ? selfieOk / selfieAttempts : null,
      errorCodeCounts,
      referenceLatencyMsP50: percentile(geminiReferenceLatencies, 0.5),
      referenceLatencyMsP95: percentile(geminiReferenceLatencies, 0.95),
      selfieLatencyMsP50: percentile(geminiSelfieLatencies, 0.5),
      selfieLatencyMsP95: percentile(geminiSelfieLatencies, 0.95),
    },
    needsChangeRates,
    slotEmitRates,
    macroIdCounts: {
      uniqueCount: Object.keys(macroCounts).length,
      top: topNCounts(macroCounts, 10),
    },
  };
}

module.exports = {
  percentile,
  extractNeedsChange,
  extractSlotEmits,
  extractMacroIds,
  summarizeRuns,
  SLOT_RULE_IDS,
};
