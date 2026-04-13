function uniqueCaseInsensitiveStrings(values, max = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= Math.max(1, Number(max) || 1)) break;
  }
  return out;
}

function normalizeSupportRoleQueryToken(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSupportRoleStep(value = '') {
  const normalized = normalizeSupportRoleQueryToken(value).toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('sunscreen') || normalized.includes('spf') || normalized.includes('uv')) return 'sunscreen';
  if (
    normalized.includes('moisturizer') ||
    normalized.includes('moisturiser') ||
    normalized.includes('cream') ||
    normalized.includes('lotion') ||
    normalized.includes('emulsion')
  ) {
    return 'moisturizer';
  }
  return '';
}

function buildSupportRoleQueryScore(query = '', { step = '', oilySignal = false } = {}) {
  const normalized = normalizeSupportRoleQueryToken(query).toLowerCase();
  if (!normalized) return 0;
  let score = 0;
  if (step === 'moisturizer') {
    if (/\b(moisturi[sz]er|cream|gel cream|lotion|emulsion|water cream|water gel)\b/.test(normalized)) score += 3;
    if (/\b(lightweight|oil free|oil-free|gel cream|water cream|water gel|breathable|non-greasy|non greasy)\b/.test(normalized)) score += 2;
    if (/\boily skin\b/.test(normalized)) score += 2;
    if (/^lightweight moisturizer oily skin$/.test(normalized)) score += 3;
    if (/^oil free moisturizer$/.test(normalized)) score += 2.4;
    if (/^gel cream moisturizer$/.test(normalized)) score += 1.5;
    if (/^barrier lotion(?: oily skin)?$/.test(normalized)) score += 1.2;
  } else if (step === 'sunscreen') {
    if (/\b(sunscreen|spf|broad spectrum|sun fluid|sun cream|sun lotion|uv)\b/.test(normalized)) score += 3;
    if (/\b(oil control|lightweight|oily skin|matte|non-greasy|non greasy|fluid|invisible|water[- ]?fit)\b/.test(normalized)) score += 2;
    if (/^oil control sunscreen$/.test(normalized)) score += 3;
    if (/^lightweight sunscreen oily skin$/.test(normalized)) score += 2.4;
    if (/^spf fluid oily skin$/.test(normalized)) score += 1.8;
    if (/^daily sunscreen$/.test(normalized)) score += 0.8;
    if (/^broad spectrum sunscreen$/.test(normalized)) score += 0.6;
  }
  if (oilySignal && /\b(oily skin|oil control|oil free|lightweight|matte|non-greasy|non greasy)\b/.test(normalized)) {
    score += 1;
  }
  return score;
}

function buildSupportRoleQueryVariants({
  roleId = '',
  roleLabel = '',
  preferredStep = '',
  queryTerms = [],
  fitKeywords = [],
  semanticFamily = '',
  concernText = '',
  maxQueries = 4,
} = {}) {
  const step = normalizeSupportRoleStep(preferredStep || roleId || roleLabel);
  if (!step) return [];
  const signalText = uniqueCaseInsensitiveStrings([
    roleId,
    roleLabel,
    semanticFamily,
    concernText,
    ...(Array.isArray(queryTerms) ? queryTerms : []),
    ...(Array.isArray(fitKeywords) ? fitKeywords : []),
  ], 24)
    .map((value) => normalizeSupportRoleQueryToken(value))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const oilySignal =
    String(semanticFamily || '').trim().toLowerCase() === 'oil_control' ||
    /\b(oily skin|oil control|shine control|mattify|mattifying|sebum|non-greasy|non greasy|mid-day shine|greasy)\b/.test(signalText);
  const gelSignal = /\b(gel cream|water gel|water cream|gel lotion|emulsion)\b/.test(signalText);
  const oilFreeSignal = /\b(oil free|oil-free)\b/.test(signalText);
  const barrierSignal = /\b(barrier|ceramide|ceramides|lotion)\b/.test(signalText);
  const fluidSignal = /\b(fluid|invisible|water[- ]?fit|serum sunscreen|spf fluid)\b/.test(signalText);

  const candidates = [
    ...(Array.isArray(queryTerms) ? queryTerms : []),
  ];
  if (step === 'moisturizer') {
    if (oilySignal) candidates.push('lightweight moisturizer oily skin');
    if (oilFreeSignal || oilySignal) candidates.push('oil free moisturizer');
    if (gelSignal) candidates.push('gel cream moisturizer');
    if (barrierSignal) candidates.push(oilySignal ? 'barrier lotion oily skin' : 'barrier lotion');
    candidates.push('lightweight moisturizer');
  } else if (step === 'sunscreen') {
    if (oilySignal) candidates.push('oil control sunscreen');
    candidates.push(oilySignal ? 'lightweight sunscreen oily skin' : 'lightweight sunscreen');
    if (fluidSignal) candidates.push(oilySignal ? 'spf fluid oily skin' : 'spf fluid');
    candidates.push('daily sunscreen');
    candidates.push('broad spectrum sunscreen');
  }
  return uniqueCaseInsensitiveStrings(candidates, 16)
    .map((query, index) => ({
      query,
      score: buildSupportRoleQueryScore(query, { step, oilySignal }),
      index,
    }))
    .sort((left, right) => {
      const scoreDiff = Number(right.score || 0) - Number(left.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return Number(left.index || 0) - Number(right.index || 0);
    })
    .slice(0, Math.max(1, Number(maxQueries) || 1))
    .map((entry) => entry.query);
}

module.exports = {
  buildSupportRoleQueryVariants,
};
