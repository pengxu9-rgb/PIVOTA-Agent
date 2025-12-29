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
    const refOkCount = Number(g?.reference?.okCount) || 0;
    const refFailCount = Number(g?.reference?.failCount) || 0;
    const selfieOkCount = Number(g?.selfie?.okCount) || 0;
    const selfieFailCount = Number(g?.selfie?.failCount) || 0;

    if (refOkCount + refFailCount > 0) {
      referenceAttempts += 1;
      if (refOkCount > 0) referenceOk += 1;
      const lat = g?.reference?.latencyMs;
      if (Number.isFinite(lat)) geminiReferenceLatencies.push(lat);
      if (refFailCount > 0) inc(errorCodeCounts, safeString(g?.reference?.lastErrorCode) || "UNKNOWN");
    }

    if (selfieOkCount + selfieFailCount > 0) {
      selfieAttempts += 1;
      if (selfieOkCount > 0) selfieOk += 1;
      const lat = g?.selfie?.latencyMs;
      if (Number.isFinite(lat)) geminiSelfieLatencies.push(lat);
      if (selfieFailCount > 0) inc(errorCodeCounts, safeString(g?.selfie?.lastErrorCode) || "UNKNOWN");
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

