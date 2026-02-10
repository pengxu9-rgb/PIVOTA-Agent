const fs = require('node:fs');
const path = require('node:path');
const { ensureCosmeticSafeClaims, DEFAULT_DISALLOWED_CLAIMS, genericSafeClaim, normalizeMarket } = require('./claimGuard');
const { assertValidIngredientKbV2 } = require('./types');

const DEFAULT_ARTIFACT_PATH = path.join(__dirname, '..', '..', '..', 'artifacts', 'ingredient_kb_v2.json');

const cache = {
  artifactPath: '',
  mtimeMs: -1,
  dataset: null,
  lastError: null,
};

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function inferRiskTier({ barrierStatus, sensitivity, contraindications } = {}) {
  const barrier = normalizeToken(barrierStatus);
  const sens = normalizeToken(sensitivity);
  const contraindicationText = Array.isArray(contraindications) ? contraindications.join(' ').toLowerCase() : '';

  if (/(pregnan|pregnancy|breastfeed|哺乳|妊娠|授乳)/i.test(contraindicationText)) return 'pregnancy_unknown';
  if (barrier.includes('impaired') || barrier.includes('damaged') || barrier.includes('fragile')) return 'barrier_irritated';
  if (sens.includes('high') || sens.includes('reactive') || sens.includes('sensitive')) return 'sensitive';
  return 'standard';
}

function parseArtifact(artifactPath) {
  if (!artifactPath || !fs.existsSync(artifactPath)) return null;
  const stats = fs.statSync(artifactPath);
  if (
    cache.dataset &&
    cache.artifactPath === artifactPath &&
    Number.isFinite(cache.mtimeMs) &&
    cache.mtimeMs === Number(stats.mtimeMs)
  ) {
    return cache.dataset;
  }

  try {
    const raw = fs.readFileSync(artifactPath, 'utf8');
    const json = JSON.parse(raw);
    const dataset = assertValidIngredientKbV2(json);
    cache.artifactPath = artifactPath;
    cache.mtimeMs = Number(stats.mtimeMs);
    cache.dataset = dataset;
    cache.lastError = null;
    return dataset;
  } catch (error) {
    cache.artifactPath = artifactPath;
    cache.mtimeMs = Number(stats.mtimeMs);
    cache.dataset = null;
    cache.lastError = error;
    return null;
  }
}

function dedupeCitations(rows) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const key = `${String(row.hash || '').trim()}::${String(row.source_url || '').trim()}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      source_url: String(row.source_url || '').trim(),
      doc_title: String(row.doc_title || '').trim(),
      publisher: String(row.publisher || '').trim(),
      published_at: row.published_at || null,
      retrieved_at: row.retrieved_at || null,
      excerpt: String(row.excerpt || '').trim().slice(0, 240),
      hash: String(row.hash || '').trim(),
    });
  }
  return out.slice(0, 8);
}

function matchesMarket(itemMarketScope, market) {
  const scopes = Array.isArray(itemMarketScope) ? itemMarketScope : [];
  if (!scopes.length) return true;
  if (scopes.includes('GLOBAL')) return true;
  return scopes.includes(market);
}

function isClaimBlockedForRisk(flags, riskTier) {
  if (!riskTier) return false;
  const tokens = Array.isArray(flags) ? flags.map((item) => normalizeToken(item)) : [];
  if (!tokens.length) return false;
  if (tokens.includes('all_sensitive') && (riskTier === 'sensitive' || riskTier === 'barrier_irritated')) return true;
  return tokens.includes(normalizeToken(riskTier));
}

function fallbackResult({ market, riskTier } = {}) {
  return {
    evidence_grade: 'C',
    market_scope: [market],
    citations: [],
    allowed_claims: [genericSafeClaim({ market })],
    disallowed_claims: [...DEFAULT_DISALLOWED_CLAIMS],
    safety_flags: [],
    do_not_mix: [],
    policy_refs: [],
    risk_tier: riskTier || 'standard',
    evidence_limited: true,
  };
}

function resolveIngredientRecommendation({
  ingredientId,
  market,
  riskTier,
  artifactPath,
} = {}) {
  const normalizedMarket = normalizeMarket(market);
  const normalizedRisk = riskTier || 'standard';
  const effectiveArtifactPath = artifactPath || process.env.INGREDIENT_KB_V2_PATH || DEFAULT_ARTIFACT_PATH;
  const dataset = parseArtifact(effectiveArtifactPath);
  if (!dataset || !Array.isArray(dataset.ingredients)) return fallbackResult({ market: normalizedMarket, riskTier: normalizedRisk });

  const key = normalizeToken(ingredientId);
  const ingredient = dataset.ingredients.find((item) => normalizeToken(item.ingredient_id) === key);
  if (!ingredient) return fallbackResult({ market: normalizedMarket, riskTier: normalizedRisk });

  const allClaims = Array.isArray(ingredient.claims) ? ingredient.claims.filter((item) => matchesMarket(item.market_scope, normalizedMarket)) : [];
  const blockedClaims = [];
  const eligibleClaims = [];
  for (const claim of allClaims) {
    if (isClaimBlockedForRisk(claim.risk_flags, normalizedRisk)) blockedClaims.push(claim);
    else eligibleClaims.push(claim);
  }

  const allowedClaimTexts = ensureCosmeticSafeClaims(
    eligibleClaims.map((item) => item.claim_text),
    { market: normalizedMarket, evidenceGrade: ingredient.evidence_grade },
  );
  const disallowedClaims = Array.from(
    new Set([
      ...blockedClaims.map((item) => String(item.claim_text || '').trim()).filter(Boolean),
      ...DEFAULT_DISALLOWED_CLAIMS,
    ]),
  ).slice(0, 10);

  const safetyNotes = Array.isArray(ingredient.safety_notes)
    ? ingredient.safety_notes.filter((item) => matchesMarket(item.market_scope, normalizedMarket))
    : [];
  const safetyFlags = Array.from(
    new Set(
      safetyNotes
        .map((item) => String(item.note_text || '').trim())
        .filter(Boolean),
    ),
  ).slice(0, 6);

  const citations = dedupeCitations([
    ...eligibleClaims.flatMap((item) => item.citations || []),
    ...safetyNotes.flatMap((item) => item.citations || []),
  ]);
  const policyRefs = dedupeCitations(
    dataset.market_policy_docs && dataset.market_policy_docs[normalizedMarket]
      ? dataset.market_policy_docs[normalizedMarket]
      : [],
  );

  let evidenceGrade = String(ingredient.evidence_grade || 'C').toUpperCase();
  let evidenceLimited =
    evidenceGrade === 'C' ||
    citations.length === 0 ||
    eligibleClaims.length === 0;
  let allowedClaims = allowedClaimTexts;
  if (evidenceLimited) {
    evidenceGrade = 'C';
    allowedClaims = [genericSafeClaim({ market: normalizedMarket })];
  }

  return {
    evidence_grade: evidenceGrade,
    market_scope: Array.isArray(ingredient.market_scope) && ingredient.market_scope.length ? ingredient.market_scope : [normalizedMarket],
    citations,
    allowed_claims: allowedClaims,
    disallowed_claims: disallowedClaims,
    safety_flags: safetyFlags,
    do_not_mix: Array.isArray(ingredient.do_not_mix) ? ingredient.do_not_mix.slice(0, 6) : [],
    policy_refs: policyRefs,
    risk_tier: normalizedRisk,
    evidence_limited: evidenceLimited,
  };
}

module.exports = {
  DEFAULT_ARTIFACT_PATH,
  normalizeMarket,
  inferRiskTier,
  resolveIngredientRecommendation,
  parseArtifact,
};
