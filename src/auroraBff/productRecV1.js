const fs = require('node:fs');
const path = require('node:path');

const { resolveIngredientRecommendation, normalizeMarket } = require('./ingredientKbV2/resolve');
const { renderAllowedTemplate } = require('./claimsTemplates/render');

const DEFAULT_CATALOG_PATH = path.join(
  __dirname,
  '..',
  '..',
  'data',
  'external',
  'products',
  'product_catalog_seed.json',
);

const EVIDENCE_RANK = Object.freeze({
  A: 3,
  B: 2,
  C: 1,
});

const REPAIR_INGREDIENT_IDS = Object.freeze(['ceramide_np', 'panthenol']);

const FRAGILE_RISK_TAGS = new Set(['acid', 'retinoid', 'high_alcohol', 'fragrance', 'strong']);
const PREGNANCY_RISK_TAGS = new Set(['retinoid', 'strong']);

const catalogCache = {
  path: '',
  mtimeMs: -1,
  items: [],
};

function normalizeLang(lang) {
  const token = String(lang || '').trim().toLowerCase();
  if (token === 'zh' || token === 'cn' || token === 'zh-cn') return 'zh';
  return 'en';
}

function normalizeRiskTier(riskTier) {
  const token = String(riskTier || '').trim().toLowerCase();
  if (token === 'sensitive' || token === 'barrier_irritated' || token === 'pregnancy_unknown' || token === 'low') {
    return token;
  }
  return 'low';
}

function normalizeEvidenceGrade(value, fallback = 'B') {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'A' || token === 'B' || token === 'C') return token;
  return fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseCatalogProduct(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const productId = String(raw.product_id || '').trim();
  const name = String(raw.name || '').trim();
  if (!productId || !name) return null;
  const marketScope = asArray(raw.market_scope).map((item) => String(item || '').trim().toUpperCase()).filter(Boolean);
  return {
    product_id: productId,
    name,
    brand: String(raw.brand || '').trim() || null,
    market_scope: marketScope.length ? marketScope : ['EU', 'US'],
    ingredient_ids: asArray(raw.ingredient_ids).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean),
    risk_tags: asArray(raw.risk_tags).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean),
    usage_note_en: String(raw.usage_note_en || '').trim(),
    usage_note_zh: String(raw.usage_note_zh || '').trim(),
    cautions_en: asArray(raw.cautions_en).map((item) => String(item || '').trim()).filter(Boolean),
    cautions_zh: asArray(raw.cautions_zh).map((item) => String(item || '').trim()).filter(Boolean),
  };
}

function loadCatalog(catalogPath) {
  const targetPath = path.resolve(catalogPath || process.env.AURORA_PRODUCT_REC_CATALOG_PATH || DEFAULT_CATALOG_PATH);
  if (!fs.existsSync(targetPath)) return [];
  const stat = fs.statSync(targetPath);
  if (
    catalogCache.path === targetPath &&
    Number.isFinite(catalogCache.mtimeMs) &&
    catalogCache.mtimeMs === Number(stat.mtimeMs) &&
    Array.isArray(catalogCache.items)
  ) {
    return catalogCache.items;
  }
  const parsed = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  const items = asArray(parsed).map(parseCatalogProduct).filter(Boolean);
  catalogCache.path = targetPath;
  catalogCache.mtimeMs = Number(stat.mtimeMs);
  catalogCache.items = items;
  return items;
}

function getTopIssueType(issues) {
  const rows = asArray(issues)
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      issue_type: String(item.issue_type || '').trim().toLowerCase(),
      severity: Number(item.severity_0_4) || 0,
    }))
    .filter((item) => item.issue_type);
  if (!rows.length) return 'redness';
  rows.sort((a, b) => b.severity - a.severity);
  return rows[0].issue_type;
}

function getActionIngredientIds(actions) {
  return Array.from(
    new Set(
      asArray(actions)
        .map((item) => String(item && item.ingredient_id ? item.ingredient_id : '').trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function gradeMeets(actualGrade, minGrade) {
  const actual = EVIDENCE_RANK[normalizeEvidenceGrade(actualGrade, 'C')] || 0;
  const required = EVIDENCE_RANK[normalizeEvidenceGrade(minGrade, 'B')] || 0;
  return actual >= required;
}

function shouldFilterByRisk(product, riskTier) {
  const tags = new Set(asArray(product && product.risk_tags));
  if (riskTier === 'barrier_irritated' || riskTier === 'sensitive') {
    for (const tag of FRAGILE_RISK_TAGS) {
      if (tags.has(tag)) return true;
    }
  }
  if (riskTier === 'pregnancy_unknown') {
    for (const tag of PREGNANCY_RISK_TAGS) {
      if (tags.has(tag)) return true;
    }
  }
  return false;
}

function buildEvidenceByIngredient({
  ingredientIds,
  market,
  riskTier,
  minCitations,
  minEvidenceGrade,
  artifactPath,
} = {}) {
  const out = new Map();
  for (const ingredientId of asArray(ingredientIds)) {
    const normalizedId = String(ingredientId || '').trim().toLowerCase();
    if (!normalizedId) continue;
    const evidence = resolveIngredientRecommendation({
      ingredientId: normalizedId,
      market,
      riskTier,
      artifactPath,
    });
    const citations = asArray(evidence.citations);
    const citationsCount = citations.length;
    const evidenceGrade = normalizeEvidenceGrade(evidence.evidence_grade, 'C');
    const pass = citationsCount >= minCitations && gradeMeets(evidenceGrade, minEvidenceGrade) && evidenceGrade !== 'C';
    out.set(normalizedId, {
      ingredient_id: normalizedId,
      evidence_grade: evidenceGrade,
      citations,
      citations_count: citationsCount,
      pass,
      do_not_mix: asArray(evidence.do_not_mix),
      safety_flags: asArray(evidence.safety_flags),
    });
  }
  return out;
}

function toCitationIds(citations) {
  return asArray(citations)
    .map((item) => String((item && item.hash) || '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

function scoreCandidate({ overlapCount, evidenceGrade, citationsCount }) {
  const overlapScore = Number(overlapCount || 0) * 10;
  const evidenceScore = (EVIDENCE_RANK[normalizeEvidenceGrade(evidenceGrade, 'C')] || 0) * 20;
  const citationScore = Math.min(10, Number(citationsCount || 0));
  return overlapScore + evidenceScore + citationScore;
}

function buildProductOutput({
  product,
  issueType,
  ingredientId,
  evidence,
  market,
  lang,
  internalTestMode,
  fallbackToGeneric,
} = {}) {
  const ingredientName = String(ingredientId || '').trim() || (normalizeLang(lang) === 'zh' ? '该成分' : 'this ingredient');
  const whyRendered = fallbackToGeneric
    ? renderAllowedTemplate({ templateType: 'generic_safe', issueType, ingredientName, market, lang })
    : renderAllowedTemplate({ templateType: 'product_why_match', issueType, ingredientName, market, lang });
  const howRendered = renderAllowedTemplate({ templateType: 'how_to_use', issueType, ingredientName, market, lang });

  const cautionsSource = normalizeLang(lang) === 'zh' ? product.cautions_zh : product.cautions_en;
  const cautions = Array.from(
    new Set(
      [
        ...asArray(cautionsSource),
        ...asArray(evidence.do_not_mix).map((item) => (normalizeLang(lang) === 'zh' ? `避免同步叠加：${item}` : `Avoid pairing with: ${item}`)),
        ...asArray(evidence.safety_flags).map((item) => (normalizeLang(lang) === 'zh' ? `留意：${item}` : `Watch-out: ${item}`)),
      ].filter(Boolean),
    ),
  ).slice(0, 5);

  const usageNote = normalizeLang(lang) === 'zh' ? product.usage_note_zh : product.usage_note_en;
  const howToUse = usageNote ? `${howRendered.text} ${usageNote}`.slice(0, 240) : howRendered.text;

  const out = {
    product_id: product.product_id,
    name: product.name,
    ...(product.brand ? { brand: product.brand } : {}),
    why_match: whyRendered.text,
    why_match_template_key: whyRendered.template_key,
    why_match_template_fallback: Boolean(whyRendered.fallback),
    why_match_template_reason: String(whyRendered.reason || 'ok'),
    how_to_use: howToUse,
    cautions,
    evidence: {
      evidence_grade: normalizeEvidenceGrade(evidence.evidence_grade, 'C'),
      citation_ids: toCitationIds(evidence.citations),
      ingredient_id: ingredientId,
    },
  };

  if (internalTestMode) {
    out.internal_debug = {
      market,
      issue_type: issueType,
      template_fallback: whyRendered.fallback,
      why_match_reason: whyRendered.reason,
      citations_count: Number(evidence.citations_count || 0),
      evidence_grade: normalizeEvidenceGrade(evidence.evidence_grade, 'C'),
      citation_ids: toCitationIds(evidence.citations),
    };
  }

  return out;
}

function buildProductRecommendations({
  moduleId,
  issues,
  actions,
  market,
  lang,
  riskTier,
  qualityGrade,
  minCitations,
  minEvidenceGrade,
  repairOnlyWhenDegraded,
  internalTestMode,
  artifactPath,
  catalogPath,
} = {}) {
  const normalizedMarket = normalizeMarket(market);
  const normalizedLang = normalizeLang(lang);
  const normalizedRiskTier = normalizeRiskTier(riskTier);
  const minCitationsN = Number.isFinite(Number(minCitations)) ? Math.max(0, Math.trunc(Number(minCitations))) : 1;
  const minEvidence = normalizeEvidenceGrade(minEvidenceGrade, 'B');

  const catalog = loadCatalog(catalogPath);
  if (!catalog.length) {
    return { products: [], suppressed_reason: 'NO_MATCH', debug: { module_id: moduleId, catalog_items: 0 } };
  }

  const issueType = getTopIssueType(issues);
  const actionIngredientIds = getActionIngredientIds(actions);
  const evidenceMapBase = buildEvidenceByIngredient({
    ingredientIds: actionIngredientIds,
    market: normalizedMarket,
    riskTier: normalizedRiskTier,
    minCitations: minCitationsN,
    minEvidenceGrade: minEvidence,
    artifactPath,
  });

  const shouldForceRepairOnly = Boolean(repairOnlyWhenDegraded) && String(qualityGrade || '').trim().toLowerCase() === 'degraded';
  const evidenceIngredientIds = shouldForceRepairOnly
    ? Array.from(new Set([...actionIngredientIds, ...REPAIR_INGREDIENT_IDS]))
    : actionIngredientIds;
  const evidenceMap = shouldForceRepairOnly
    ? buildEvidenceByIngredient({
        ingredientIds: evidenceIngredientIds,
        market: normalizedMarket,
        riskTier: normalizedRiskTier,
        minCitations: minCitationsN,
        minEvidenceGrade: minEvidence,
        artifactPath,
      })
    : evidenceMapBase;
  const eligibleEvidence = Array.from(evidenceMap.values()).filter((item) => item.pass);
  const useRepairFallback = shouldForceRepairOnly;

  if (!eligibleEvidence.length && !useRepairFallback) {
    return {
      products: [],
      suppressed_reason: 'LOW_EVIDENCE',
      debug: {
        module_id: moduleId,
        market: normalizedMarket,
        risk_tier: normalizedRiskTier,
        issue_type: issueType,
        ingredient_ids: actionIngredientIds,
      },
    };
  }

  const candidates = [];
  let filteredByRisk = 0;
  let filteredByMarket = 0;
  let filteredByNoOverlap = 0;
  for (const product of catalog) {
    if (!asArray(product.market_scope).includes(normalizedMarket)) {
      filteredByMarket += 1;
      continue;
    }
    if (shouldFilterByRisk(product, normalizedRiskTier)) {
      filteredByRisk += 1;
      continue;
    }

    const productIngredients = asArray(product.ingredient_ids);
    const overlap = useRepairFallback
      ? productIngredients.filter((id) => REPAIR_INGREDIENT_IDS.includes(id) && evidenceMap.has(id))
      : productIngredients.filter((id) => evidenceMap.has(id) && evidenceMap.get(id).pass);
    if (!overlap.length) {
      filteredByNoOverlap += 1;
      continue;
    }

    const primaryIngredientId = overlap[0];
    const primaryEvidence = evidenceMap.get(primaryIngredientId) || {
      evidence_grade: 'C',
      citations: [],
      citations_count: 0,
      do_not_mix: [],
      safety_flags: [],
    };
    const output = buildProductOutput({
      product,
      issueType,
      ingredientId: primaryIngredientId,
      evidence: primaryEvidence,
      market: normalizedMarket,
      lang: normalizedLang,
      internalTestMode,
      fallbackToGeneric: useRepairFallback,
    });
    candidates.push({
      output,
      score: scoreCandidate({
        overlapCount: overlap.length,
        evidenceGrade: primaryEvidence.evidence_grade,
        citationsCount: primaryEvidence.citations_count,
      }),
    });
  }

  if (!candidates.length) {
    const suppressedReason = useRepairFallback
      ? 'DEGRADED'
      : filteredByRisk > 0 && filteredByNoOverlap === 0
        ? 'RISK_TIER'
        : 'NO_MATCH';
    return {
      products: [],
      suppressed_reason: suppressedReason,
      debug: {
        module_id: moduleId,
        market: normalizedMarket,
        risk_tier: normalizedRiskTier,
        issue_type: issueType,
        filtered_by_market: filteredByMarket,
        filtered_by_risk: filteredByRisk,
        filtered_by_no_overlap: filteredByNoOverlap,
        repair_fallback: useRepairFallback,
      },
    };
  }

  candidates.sort((a, b) => b.score - a.score);
  return {
    products: candidates.slice(0, 3).map((item) => item.output),
    suppressed_reason: null,
    debug: {
      module_id: moduleId,
      market: normalizedMarket,
      risk_tier: normalizedRiskTier,
      issue_type: issueType,
      candidate_count: candidates.length,
      repair_fallback: useRepairFallback,
    },
  };
}

module.exports = {
  DEFAULT_CATALOG_PATH,
  normalizeRiskTier,
  normalizeEvidenceGrade,
  loadCatalog,
  buildProductRecommendations,
};
