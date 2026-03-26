function buildResolverQueryCandidates({
  queryText,
  sanitizeSearchQueryForRelevance,
  extractSearchAnchorTokens,
} = {}) {
  const raw = String(queryText || '').trim();
  if (!raw) return [];

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  pushCandidate(raw);
  const sanitized =
    typeof sanitizeSearchQueryForRelevance === 'function'
      ? sanitizeSearchQueryForRelevance(raw)
      : raw;
  pushCandidate(sanitized);

  const anchorTokens =
    typeof extractSearchAnchorTokens === 'function'
      ? extractSearchAnchorTokens(raw)
      : [];
  if (Array.isArray(anchorTokens) && anchorTokens.length > 0) {
    pushCandidate(anchorTokens.join(' '));
    for (const token of anchorTokens.slice(0, 3)) {
      pushCandidate(token);
    }
  }

  return candidates.slice(0, 5);
}

module.exports = {
  buildResolverQueryCandidates,
};
