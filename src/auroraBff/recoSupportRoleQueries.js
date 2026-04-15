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
  if (normalized.includes('serum') || normalized.includes('essence') || normalized.includes('ampoule')) return 'serum';
  if (
    normalized.includes('moisturizer') ||
    normalized.includes('moisturiser') ||
    normalized.includes('cream') ||
    normalized.includes('lotion') ||
    normalized.includes('emulsion')
  ) {
    return 'moisturizer';
  }
  if (
    normalized.includes('treatment') ||
    normalized.includes('tone') ||
    normalized.includes('mark') ||
    normalized.includes('brighten') ||
    normalized.includes('spot') ||
    normalized.includes('acne') ||
    normalized.includes('blemish') ||
    normalized.includes('pore') ||
    normalized.includes('soothing') ||
    normalized.includes('cica') ||
    normalized.includes('panthenol')
  ) {
    return 'treatment';
  }
  return '';
}

function buildSupportRoleQueryScore(query = '', { step = '', oilySignal = false, barrierSignal = false } = {}) {
  const normalized = normalizeSupportRoleQueryToken(query).toLowerCase();
  if (!normalized) return 0;
  let score = 0;
  if (step === 'moisturizer') {
    if (/\b(moisturi[sz]er|cream|gel cream|lotion|emulsion|water cream|water gel)\b/.test(normalized)) score += 3;
    if (/\b(lightweight|oil free|oil-free|gel cream|water cream|water gel|breathable|non-greasy|non greasy)\b/.test(normalized)) score += 2;
    if (barrierSignal && /\b(barrier|repair|ceramide|ceramides|sensitive|soothing|fragrance free)\b/.test(normalized)) score += 3;
    if (/\boily skin\b/.test(normalized)) score += 2;
    if (/^lightweight moisturizer oily skin$/.test(normalized)) score += 3;
    if (/^oil free moisturizer$/.test(normalized)) score += 2.4;
    if (/^gel cream moisturizer$/.test(normalized)) score += 6;
    if (/^moisturizer$/.test(normalized)) score += 7;
    if (/^barrier repair moisturizer$/.test(normalized)) score += 4;
    if (/^ceramide cream sensitive skin$/.test(normalized)) score += 3.5;
    if (/^soothing moisturizer$/.test(normalized)) score += 2.6;
    if (/^barrier lotion(?: oily skin)?$/.test(normalized)) score += 1.2;
  } else if (step === 'sunscreen') {
    if (/\b(sunscreen|spf|broad spectrum|sun fluid|sun cream|sun lotion|uv)\b/.test(normalized)) score += 3;
    if (/\b(oil control|lightweight|oily skin|matte|non-greasy|non greasy|fluid|invisible|water[- ]?fit)\b/.test(normalized)) score += 2;
    if (/^oil control sunscreen$/.test(normalized)) score += 3;
    if (/^lightweight sunscreen oily skin$/.test(normalized)) score += 2.4;
    if (/^spf fluid oily skin$/.test(normalized)) score += 4.5;
    if (/^sunscreen$/.test(normalized)) score += 7;
    if (/^daily sunscreen$/.test(normalized)) score += 0.8;
    if (/^broad spectrum sunscreen$/.test(normalized)) score += 0.6;
  } else if (step === 'serum') {
    if (/\b(serum|essence|ampoule)\b/.test(normalized)) score += 3;
    if (/\b(hyaluronic|hydrating|hydrate|dehydrated|plumping|water[- ]?fit|dull skin|glycerin|panthenol)\b/.test(normalized)) score += 2;
    if (/^hyaluronic acid serum$/.test(normalized)) score += 4;
    if (/^hydrating serum(?: dehydrated skin)?$/.test(normalized)) score += 3;
    if (/^hydrating essence(?: dull skin)?$/.test(normalized)) score += 2.4;
    if (/^plumping hydrating serum$/.test(normalized)) score += 1.8;
  } else if (step === 'treatment') {
    if (/\b(treatment|serum|essence|ampoule)\b/.test(normalized)) score += 3;
    if (/\b(azelaic|niacinamide|salicylic|bha|vitamin c|tranexamic|cica|panthenol|madecassoside|soothing|redness|brightening|radiance|glow|dull|dark spot|post acne|mark|blemish|pore|tone correcting|uneven tone)\b/.test(normalized)) score += 2;
    if (/^soothing serum sensitive skin$/.test(normalized)) score += 3;
    if (/^post acne marks serum$/.test(normalized)) score += 3;
    if (/^dark spot serum$/.test(normalized)) score += 2.4;
    if (/^brightening serum$/.test(normalized)) score += 3.2;
    if (/^tone correcting serum$/.test(normalized)) score += 2.8;
    if (/^radiance serum$/.test(normalized)) score += 2.2;
    if (/^uneven tone treatment$/.test(normalized)) score += 2.5;
    if (/^cica serum redness$/.test(normalized)) score += 2.4;
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
  const hydrationSerumSignal = /\b(hydrat|dehydrat|hyaluronic|essence|plumping|water[- ]?fit|dull skin)\b/.test(signalText);
  const soothingTreatmentSignal = /\b(soothing|redness|calming|irritation|cica|panthenol|madecassoside)\b/.test(signalText);
  const toneTreatmentSignal = /\b(post[- ]?acne|marks?|dark spot|tone|brighten|radiance|glow|dull|hyperpigmentation|uneven)\b/.test(signalText);
  const acneTreatmentSignal = /\b(acne|blemish|clogged pore|congestion|salicylic|bha|clarifying)\b/.test(signalText);

  const preferredCandidates = [];
  const hasDullToneSignal = /\b(dull|radiance|glow|brighten|uneven tone)\b/.test(signalText);
  const explicitMarkConcern = /\b(post[- ]?(?:acne|breakout)|breakout marks?|acne marks?|dark spots?|hyperpigmentation|melasma)\b/.test(
    uniqueCaseInsensitiveStrings([
      concernText,
    ], 24)
      .map((value) => normalizeSupportRoleQueryToken(value))
      .filter(Boolean)
      .join(' ')
      .toLowerCase(),
  );
  if (step === 'treatment' && toneTreatmentSignal && hasDullToneSignal) {
    preferredCandidates.push('brightening serum', 'tone correcting serum', 'uneven tone treatment', 'radiance serum');
  }

  const candidates = [
    ...preferredCandidates,
    ...(Array.isArray(queryTerms)
      ? queryTerms.filter((query) => {
          const normalizedQuery = normalizeSupportRoleQueryToken(query).toLowerCase();
          if (!hasDullToneSignal || explicitMarkConcern) return true;
          return !/\b(post[- ]?acne|acne marks?|dark spots?|hyperpigmentation)\b/.test(normalizedQuery);
        })
      : []),
  ];
  if (step === 'moisturizer') {
    candidates.push('moisturizer');
    if (gelSignal || oilySignal) candidates.push('gel cream moisturizer');
    if (oilFreeSignal || oilySignal) candidates.push('oil free moisturizer');
    if (oilySignal) candidates.push('lightweight moisturizer oily skin');
    if (barrierSignal) candidates.push(oilySignal ? 'barrier lotion oily skin' : 'barrier lotion');
    candidates.push('lightweight moisturizer');
  } else if (step === 'sunscreen') {
    candidates.push('sunscreen');
    if (fluidSignal || oilySignal) candidates.push(oilySignal ? 'spf fluid oily skin' : 'spf fluid');
    candidates.push(oilySignal ? 'lightweight sunscreen oily skin' : 'lightweight sunscreen');
    if (oilySignal) candidates.push('oil control sunscreen');
    candidates.push('daily sunscreen');
    candidates.push('broad spectrum sunscreen');
  } else if (step === 'serum') {
    if (hydrationSerumSignal) {
      candidates.push('hyaluronic acid serum');
      candidates.push('hydrating serum dehydrated skin');
      candidates.push('hydrating serum');
      candidates.push('hydrating essence');
    }
    candidates.push('serum skincare');
  } else if (step === 'treatment') {
    if (soothingTreatmentSignal) {
      candidates.push('soothing serum sensitive skin');
      candidates.push('cica serum redness');
      candidates.push('panthenol treatment');
    }
    if (toneTreatmentSignal) {
      if (!hasDullToneSignal || explicitMarkConcern) {
        candidates.push('post acne marks serum');
        candidates.push('dark spot serum');
      }
      candidates.push('tone correcting serum');
      candidates.push('brightening serum');
      if (hasDullToneSignal) candidates.push('radiance serum');
    }
    if (acneTreatmentSignal) {
      candidates.push('salicylic acid serum clogged pores');
      candidates.push('acne treatment serum');
      candidates.push('blemish treatment');
    }
    candidates.push('treatment serum');
  }
  return uniqueCaseInsensitiveStrings(candidates, 16)
    .map((query, index) => ({
      query,
      score: buildSupportRoleQueryScore(query, { step, oilySignal, barrierSignal }),
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
