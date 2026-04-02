'use strict';

function pickFirstTrimmed(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function normalizeConcernQueryToken(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeRecoTargetStep(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!token) return '';
  if (token.includes('sunscreen') || token.includes('spf') || token.includes('sun')) return 'sunscreen';
  if (token.includes('moistur') || token.includes('cream') || token.includes('lotion') || token.includes('gel cream')) return 'moisturizer';
  if (token.includes('mask')) return 'mask';
  if (token.includes('serum')) return 'serum';
  if (token.includes('treatment') || token.includes('retinol') || token.includes('acid')) return 'treatment';
  if (token.includes('cleanser') || token.includes('wash')) return 'cleanser';
  return token;
}

function countConcernRoleSignalMatches(text, values = [], maxHits = 2) {
  const haystack = String(text || '').trim().toLowerCase();
  if (!haystack) return 0;
  let hits = 0;
  for (const raw of Array.isArray(values) ? values : []) {
    const token = normalizeConcernQueryToken(raw).toLowerCase();
    if (!token || !haystack.includes(token)) continue;
    hits += 1;
    if (hits >= maxHits) break;
  }
  return hits;
}

function scoreConcernRoleCandidate(row, role, { candidateStep, candidateText = '' } = {}) {
  const roleId = String(role?.role_id || '').trim();
  if (!roleId) return null;
  const preferredStep = normalizeRecoTargetStep(role?.preferred_step);
  const alternateSteps = Array.isArray(role?.alternate_steps)
    ? role.alternate_steps.map((value) => normalizeRecoTargetStep(value)).filter(Boolean)
    : [];
  const retrievalRoleId = pickFirstTrimmed(row?.retrieval_role_id, row?.role_id);
  const fitKeywordMatches = countConcernRoleSignalMatches(candidateText, role?.fit_keywords, 3);
  const queryTermMatches = countConcernRoleSignalMatches(candidateText, role?.query_terms, 3);
  const ingredientMatches = countConcernRoleSignalMatches(candidateText, role?.ingredient_hypotheses, 2);
  const productTypeMatches = countConcernRoleSignalMatches(candidateText, role?.product_type_hypotheses, 2);
  const exactStep = Boolean(candidateStep && preferredStep && candidateStep === preferredStep);
  const alternateStep = Boolean(candidateStep && alternateSteps.includes(candidateStep));
  const semanticFitMatched = fitKeywordMatches > 0 || queryTermMatches > 0 || ingredientMatches > 0 || productTypeMatches > 0;

  let score = 0;
  if (exactStep) score += preferredStep === 'treatment' ? 0.22 : 0.34;
  else if (alternateStep) score += preferredStep === 'treatment' ? 0.08 : 0.18;
  score += Math.min(0.27, fitKeywordMatches * 0.12);
  score += Math.min(0.18, queryTermMatches * 0.08);
  score += Math.min(0.16, ingredientMatches * 0.08);
  score += Math.min(0.12, productTypeMatches * 0.06);
  if (retrievalRoleId && retrievalRoleId === roleId) score += semanticFitMatched ? 0.08 : 0.02;
  if (preferredStep === 'treatment' && candidateStep === 'serum' && !semanticFitMatched) {
    score = Math.min(score, 0.34);
  }
  if (!semanticFitMatched && !exactStep && !alternateStep) {
    score = Math.min(score, 0.28);
  }
  return {
    role_id: roleId,
    role,
    score: Number(score.toFixed(4)),
    semantic_fit_matched: semanticFitMatched,
    exact_step: exactStep,
    alternate_step: alternateStep,
  };
}

module.exports = {
  scoreConcernRoleCandidate,
};
