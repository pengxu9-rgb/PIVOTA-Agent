function normalizeToken(v) {
  return String(v ?? "").trim();
}

function normalizeList(v) {
  return Array.isArray(v) ? v.map((x) => normalizeToken(x)).filter(Boolean) : [];
}

function normalizeEnum(v, allowed) {
  const s = String(v ?? "").trim();
  return allowed.includes(s) ? s : null;
}

function normalizeOnboardingProfileV0(input) {
  if (!input || typeof input !== "object") return null;

  const skinType = normalizeEnum(input.skinType, ["oily", "dry", "combination", "neutral", "sensitive"]);
  const poreLevel = normalizeEnum(input.poreLevel, ["minimal", "moderate", "visible"]);
  const acneStatus = normalizeEnum(input.acneStatus, ["none", "occasional", "frequent", "severe"]);

  return {
    version: "v0",
    skinType,
    poreLevel,
    acneStatus,
    oilyZones: normalizeList(input.oilyZones),
    dryZones: normalizeList(input.dryZones),
    sensitivityTriggers: normalizeList(input.sensitivityTriggers),
    acneDistribution: normalizeList(input.acneDistribution),
    makeupIssues: normalizeList(input.makeupIssues),
    highRiskAreas: normalizeList(input.highRiskAreas),
    updatedAt: normalizeToken(input.updatedAt) || null,
  };
}

function deriveOnboardingSignalsV0(profile) {
  const p = profile || {};
  const issues = new Set(Array.isArray(p.makeupIssues) ? p.makeupIssues : []);
  const highRisk = new Set(Array.isArray(p.highRiskAreas) ? p.highRiskAreas : []);

  const skinType = p.skinType || null;
  const poreVisible = p.poreLevel === "visible" || issues.has("pore-visible");
  const hasAcne = Boolean(p.acneStatus && p.acneStatus !== "none") || issues.has("acne-cover");
  const needsOilControl = skinType === "oily" || skinType === "combination" || issues.has("oily-melt");
  const needsHydration = skinType === "dry" || issues.has("cakey");
  const isSensitive = skinType === "sensitive" || (Array.isArray(p.sensitivityTriggers) && p.sensitivityTriggers.length > 0);
  const oxidation = issues.has("oxidation");
  const transfer = issues.has("transfer");

  return {
    skinType,
    poreVisible,
    hasAcne,
    needsOilControl,
    needsHydration,
    isSensitive,
    oxidation,
    transfer,
    highRiskAreas: Array.from(highRisk),
    makeupIssues: Array.from(issues),
  };
}

module.exports = {
  normalizeOnboardingProfileV0,
  deriveOnboardingSignalsV0,
};

