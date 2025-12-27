function normalizeMarket(market) {
  const s = String(market ?? '').trim().toUpperCase();
  if (s === 'US' || s === 'JP') return s;
  throw new Error(`Unsupported market: ${market}`);
}

function computeIntentTechniqueMappingReport({ market, intentsDict, techniqueIds }) {
  const m = normalizeMarket(market);
  const dict = intentsDict;
  const kbIds = techniqueIds instanceof Set ? techniqueIds : new Set(techniqueIds || []);

  const placeholderSet = new Set(Array.isArray(dict?.placeholders) ? dict.placeholders : []);
  const intents = Array.isArray(dict?.intents) ? dict.intents : [];

  const missingByIntent = new Map();
  let totalRefs = 0;
  let missingNonPlaceholderRefs = 0;

  for (const intent of intents) {
    const intentId = intent?.id ?? '(unknown)';
    const bucket = intent?.markets?.[m];
    const techniqueIdsForIntent = Array.isArray(bucket?.techniqueIds) ? bucket.techniqueIds : [];
    for (const tid of techniqueIdsForIntent) {
      totalRefs += 1;
      if (kbIds.has(tid)) continue;
      if (placeholderSet.has(tid)) continue;
      missingNonPlaceholderRefs += 1;
      const list = missingByIntent.get(intentId) ?? [];
      list.push(tid);
      missingByIntent.set(intentId, list);
    }
  }

  const missingIntentsRanked = Array.from(missingByIntent.entries())
    .map(([intentId, missingTechniqueIds]) => {
      const uniq = Array.from(new Set(missingTechniqueIds)).sort();
      return { intentId, missingCount: uniq.length, missingTechniqueIds: uniq };
    })
    .sort((a, b) => b.missingCount - a.missingCount || a.intentId.localeCompare(b.intentId));

  return {
    market: m,
    totalIntents: intents.length,
    totalRefs,
    placeholderCount: placeholderSet.size,
    kbCardCount: kbIds.size,
    missingNonPlaceholderRefs,
    missingByIntent,
    missingIntentsRanked,
  };
}

module.exports = {
  computeIntentTechniqueMappingReport,
};

