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

function buildSupportRoleQueryScore(
  query = '',
  {
    step = '',
    oilySignal = false,
    barrierSignal = false,
    layeringSignal = false,
    fluidSignal = false,
  } = {},
) {
  const normalized = normalizeSupportRoleQueryToken(query).toLowerCase();
  if (!normalized) return 0;
  let score = 0;
  const finishFitSignal = layeringSignal || fluidSignal || oilySignal;
  if (step === 'moisturizer') {
    if (/\b(moisturi[sz]er|cream|gel cream|lotion|emulsion|water cream|water gel)\b/.test(normalized)) score += 3;
    if (/\b(lightweight|oil free|oil-free|gel cream|water cream|water gel|breathable|non-greasy|non greasy)\b/.test(normalized)) score += 2;
    if (layeringSignal && /\b(layering|makeup|under makeup|pilling)\b/.test(normalized)) score += 2.6;
    if (barrierSignal && /\b(barrier|repair|ceramide|ceramides|sensitive|soothing|fragrance free)\b/.test(normalized)) score += 3;
    if (/\boily skin\b/.test(normalized)) score += 2;
    if (/^lightweight moisturizer oily skin$/.test(normalized)) {
      score += oilySignal && layeringSignal ? 7 : 3;
    }
    if (/^oil free moisturizer$/.test(normalized)) score += 2.4;
    if (/^gel cream moisturizer$/.test(normalized)) score += 8;
    if (/^lightweight moisturizer$/.test(normalized)) score += layeringSignal ? 4.8 : 1.8;
    if (/^non-greasy moisturizer$/.test(normalized)) score += layeringSignal ? 3.2 : 1.6;
    if (/^makeup layering moisturizer$/.test(normalized)) score += layeringSignal ? 2.2 : 0.8;
    if (/^moisturizer$/.test(normalized)) score += barrierSignal ? 2 : layeringSignal ? 0.8 : 5;
    if (/^barrier repair moisturizer$/.test(normalized)) score += 4;
    if (/^ceramide cream sensitive skin$/.test(normalized)) score += 3.5;
    if (/^soothing moisturizer$/.test(normalized)) score += 2.6;
    if (/^barrier lotion(?: oily skin)?$/.test(normalized)) score += 1.2;
  } else if (step === 'sunscreen') {
    if (/\b(sunscreen|spf|broad spectrum|sun fluid|sun cream|sun lotion|uv)\b/.test(normalized)) score += 3;
    if (/\b(oil control|lightweight|oily skin|matte|non-greasy|non greasy|fluid|invisible|water[- ]?fit)\b/.test(normalized)) score += 2;
    if (layeringSignal && /\b(layering|makeup|under makeup|pilling)\b/.test(normalized)) score += 3.4;
    if ((fluidSignal || layeringSignal) && /\b(fluid|invisible|water[- ]?fit|serum sunscreen)\b/.test(normalized)) {
      score += 2.6;
    }
    if (/^sunscreen under makeup(?: oily skin)?$/.test(normalized)) score += layeringSignal ? 7.2 : 2.6;
    if (/^sunscreen oily skin$/.test(normalized)) score += oilySignal ? 6.2 : 1.4;
    if (/^oil control sunscreen$/.test(normalized)) score += oilySignal ? 5.4 : 3;
    if (/^lightweight sunscreen oily skin$/.test(normalized)) score += finishFitSignal ? 6.4 : 2.4;
    if (/^lightweight sunscreen$/.test(normalized)) score += finishFitSignal ? 4.6 : 2.2;
    if (/^matte sunscreen$/.test(normalized)) score += oilySignal ? 5.8 : 2.2;
    if (/^invisible sunscreen$/.test(normalized)) score += fluidSignal || layeringSignal ? 5.6 : 2.4;
    if (/^face sunscreen$/.test(normalized)) score += finishFitSignal ? 2.4 : 1.2;
    if (/^spf fluid oily skin$/.test(normalized)) score += finishFitSignal ? 7.8 : 4.5;
    if (/^spf fluid$/.test(normalized)) score += fluidSignal || layeringSignal ? 5.8 : 2.2;
    if (/^makeup friendly sunscreen$/.test(normalized)) score += layeringSignal ? 4.8 : 1.4;
    if (/^sunscreen$/.test(normalized)) score += finishFitSignal ? 0.3 : 10;
    if (/^daily sunscreen$/.test(normalized)) score += finishFitSignal ? 0.2 : 0.8;
    if (/^broad spectrum sunscreen$/.test(normalized)) score += finishFitSignal ? 0.2 : 0.6;
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

function getFinishFitSunscreenQueryPriority(
  query = '',
  {
    oilySignal = false,
  } = {},
) {
  const normalized = normalizeSupportRoleQueryToken(query).toLowerCase();
  if (!normalized) return Number.POSITIVE_INFINITY;
  const priority = oilySignal
    ? [
        'sunscreen oily skin',
        'sunscreen under makeup',
        'lightweight sunscreen oily skin',
        'matte sunscreen',
        'invisible sunscreen',
        'spf fluid oily skin',
        'oil control sunscreen',
        'makeup friendly sunscreen',
        'face sunscreen',
        'daily sunscreen',
        'broad spectrum sunscreen',
        'sunscreen',
      ]
    : [
        'sunscreen under makeup',
        'lightweight sunscreen',
        'invisible sunscreen',
        'spf fluid',
        'makeup friendly sunscreen',
        'face sunscreen',
        'daily sunscreen',
        'broad spectrum sunscreen',
        'sunscreen',
      ];
  const index = priority.indexOf(normalized);
  return index >= 0 ? index : Number.POSITIVE_INFINITY;
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
  const roleSpecificSignalText = uniqueCaseInsensitiveStrings([
    roleId,
    roleLabel,
    semanticFamily,
    ...(Array.isArray(queryTerms) ? queryTerms : []),
    ...(Array.isArray(fitKeywords) ? fitKeywords : []),
  ], 24)
    .map((value) => normalizeSupportRoleQueryToken(value))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const normalizedOilySignalText = signalText.replace(/\bnon[- ]greasy\b/g, ' ');
  const oilySignal =
    String(semanticFamily || '').trim().toLowerCase() === 'oil_control' ||
    /\b(oily skin|oil control|shine control|mattify|mattifying|sebum|mid-day shine|greasy)\b/.test(normalizedOilySignalText);
  const gelSignal = /\b(gel cream|water gel|water cream|gel lotion|emulsion)\b/.test(signalText);
  const oilFreeSignal = /\b(oil free|oil-free)\b/.test(signalText);
  const barrierSignal = /\b(barrier|ceramide|ceramides|lotion)\b/.test(signalText);
  const layeringSignal = /\b(layering|makeup|under makeup|pilling)\b/.test(roleSpecificSignalText);
  const fluidSignal = /\b(fluid|invisible|water[- ]?fit|serum sunscreen|spf fluid)\b/.test(signalText);
  const explicitFinishFitSunscreenSignal =
    /\b(finish[-_\s]?fit|under makeup|makeup|layering|pilling)\b/.test(roleSpecificSignalText);
  const finishFitSunscreenSignal = step === 'sunscreen' && (layeringSignal || explicitFinishFitSunscreenSignal);
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
    if (gelSignal || oilySignal || layeringSignal) candidates.push('gel cream moisturizer');
    if (oilFreeSignal || oilySignal) candidates.push('oil free moisturizer');
    if (layeringSignal) {
      candidates.push('lightweight moisturizer');
      candidates.push('non-greasy moisturizer');
      candidates.push('makeup layering moisturizer');
    }
    if (oilySignal) candidates.push('lightweight moisturizer oily skin');
    if (barrierSignal) candidates.push(oilySignal ? 'barrier lotion oily skin' : 'barrier lotion');
    if (!layeringSignal) candidates.push('lightweight moisturizer');
    candidates.push('moisturizer');
  } else if (step === 'sunscreen') {
    if (finishFitSunscreenSignal) {
      candidates.push(oilySignal ? 'sunscreen oily skin' : 'face sunscreen');
      candidates.push('sunscreen under makeup');
      candidates.push(oilySignal ? 'lightweight sunscreen oily skin' : 'lightweight sunscreen');
      if (oilySignal) candidates.push('matte sunscreen');
      if (fluidSignal || layeringSignal || oilySignal) candidates.push('invisible sunscreen');
      if (fluidSignal || layeringSignal || oilySignal) candidates.push(oilySignal ? 'spf fluid oily skin' : 'spf fluid');
      if (layeringSignal) candidates.push('makeup friendly sunscreen');
    } else {
      if (fluidSignal || layeringSignal || oilySignal) candidates.push(oilySignal ? 'spf fluid oily skin' : 'spf fluid');
      if (layeringSignal) candidates.push('sunscreen under makeup');
      candidates.push(oilySignal ? 'lightweight sunscreen oily skin' : 'lightweight sunscreen');
      if (oilySignal) candidates.push('oil control sunscreen');
      if (layeringSignal) candidates.push('makeup friendly sunscreen');
      candidates.push('daily sunscreen');
      candidates.push('broad spectrum sunscreen');
      candidates.push('sunscreen');
    }
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
  const effectiveMaxQueries = Math.max(1, Number(maxQueries) || 1);
  return uniqueCaseInsensitiveStrings(candidates, 16)
    .map((query, index) => ({
      query,
      score: buildSupportRoleQueryScore(query, { step, oilySignal, barrierSignal, layeringSignal, fluidSignal }),
      index,
    }))
    .sort((left, right) => {
      if (finishFitSunscreenSignal) {
        const priorityDiff = getFinishFitSunscreenQueryPriority(left.query, { oilySignal }) -
          getFinishFitSunscreenQueryPriority(right.query, { oilySignal });
        if (priorityDiff !== 0) return priorityDiff;
      }
      const scoreDiff = Number(right.score || 0) - Number(left.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return Number(left.index || 0) - Number(right.index || 0);
    })
    .slice(0, effectiveMaxQueries)
    .map((entry) => entry.query);
}

module.exports = {
  buildSupportRoleQueryVariants,
};
