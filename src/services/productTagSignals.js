function normalizeToken(value) {
  return String(value || '').trim().toLowerCase();
}

function splitTagIntoTokens(tag) {
  const norm = normalizeToken(tag);
  if (!norm) return [];
  const parts = norm.split(/[^a-z0-9\u00C0-\u024F\u4E00-\u9FFF]+/giu).filter(Boolean);
  return parts.length ? parts : [norm];
}

function extractTags(product) {
  const tags = product?.tags;
  if (Array.isArray(tags)) return tags.map((t) => String(t)).filter(Boolean);
  if (typeof tags === 'string' && tags.trim()) {
    return tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  const metaTags = product?.recommendation_meta?.tags_raw || product?.recommendation_meta?.tags;
  if (Array.isArray(metaTags)) return metaTags.map((t) => String(t)).filter(Boolean);
  return [];
}

function extractFacetValues(product) {
  const facets = product?.recommendation_meta?.facets;
  if (!facets || typeof facets !== 'object') return [];
  const out = [];
  for (const v of Object.values(facets)) {
    if (!v) continue;
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  return out.map((x) => String(x)).filter(Boolean);
}

function buildTokenSet(values) {
  const set = new Set();
  for (const v of values || []) {
    const tokens = splitTagIntoTokens(v);
    for (const t of tokens) {
      if (!t) continue;
      set.add(t);
    }
    const norm = normalizeToken(v);
    if (norm) set.add(norm);
    if (norm.includes(':')) {
      const rhs = norm.split(':').slice(1).join(':').trim();
      if (rhs) set.add(rhs);
    }
  }
  return set;
}

function extractProductSignals(product) {
  const tags = extractTags(product);
  const facetValues = extractFacetValues(product);
  return {
    tagTokens: buildTokenSet(tags),
    facetTokens: buildTokenSet(facetValues),
  };
}

function countOverlap(terms, tokenSet) {
  if (!Array.isArray(terms) || terms.length === 0) return 0;
  if (!tokenSet || typeof tokenSet.has !== 'function') return 0;
  let c = 0;
  for (const t of terms) {
    const norm = normalizeToken(t);
    if (!norm) continue;
    if (tokenSet.has(norm)) c += 1;
  }
  return c;
}

function scoreByTagFacetOverlap(terms, product) {
  const { tagTokens, facetTokens } = extractProductSignals(product);
  const tagOverlap = countOverlap(terms, tagTokens);
  const facetOverlap = countOverlap(terms, facetTokens);
  return {
    tagOverlap,
    facetOverlap,
    score: Math.min(3, tagOverlap) * 1.5 + Math.min(3, facetOverlap) * 2.0,
  };
}

function scorePairOverlap(baseProduct, candidateProduct) {
  const base = extractProductSignals(baseProduct);
  const cand = extractProductSignals(candidateProduct);

  let tagOverlap = 0;
  for (const t of base.tagTokens) if (cand.tagTokens.has(t)) tagOverlap += 1;
  let facetOverlap = 0;
  for (const t of base.facetTokens) if (cand.facetTokens.has(t)) facetOverlap += 1;

  // Cap to avoid over-weighting very verbose tags.
  return {
    tagOverlap,
    facetOverlap,
    score: Math.min(6, tagOverlap) * 0.6 + Math.min(6, facetOverlap) * 0.9,
  };
}

module.exports = {
  extractProductSignals,
  scoreByTagFacetOverlap,
  scorePairOverlap,
};

