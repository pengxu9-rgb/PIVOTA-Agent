const {
  DROP_REASON,
  buildAnchorFingerprint,
  buildAnchorIdentity,
  deduplicateCandidates,
  detectSelfReference,
  detectUrlAsName,
  filterSelfReferences,
  nameSimilarity,
  normalizeBrand,
  normalizeProductName,
  normalizeUrl,
  sanitizeCandidateFields,
  sanitizeCandidates,
  stripRecommendationSuffix,
  hasSyntheticRecommendationSuffix,
} = require('../src/auroraBff/skills/dupe_utils');

test('normalizeBrand lowercases and strips punctuation', () => {
  expect(normalizeBrand('The Ordinary')).toBe('ordinary');
  expect(normalizeBrand('La Roche-Posay')).toBe('la roche-posay');
  expect(normalizeBrand('CeraVe')).toBe('cerave');
  expect(normalizeBrand(null)).toBe('');
  expect(normalizeBrand('')).toBe('');
});

test('normalizeProductName removes spec and marketing words', () => {
  const result = normalizeProductName('Daily Rescue Energizing Lightweight Lotion Moisturizer 50ml NEW');
  expect(result).not.toContain('50ml');
  expect(result).not.toContain('new');
  expect(result).toContain('daily');
  expect(result).toContain('rescue');
});

test('normalizeProductName strips legacy dupe suffix tokens', () => {
  const result = normalizeProductName('The Ordinary Niacinamide 10% + Zinc 1% (budget dupe)');
  expect(result).not.toContain('budget');
  expect(result).not.toContain('dupe');
  expect(result).toContain('niacinamide');
  expect(stripRecommendationSuffix('Niacinamide 10% + Zinc 1% (similar option)')).toBe('Niacinamide 10% + Zinc 1%');
  expect(hasSyntheticRecommendationSuffix('Niacinamide 10% + Zinc 1% (premium option)')).toBe(true);
});

test('normalizeUrl strips tracking params and trailing slash', () => {
  const url = 'https://www.labseries.com/product/32020/123634/skincare/?utm_source=google&ref=abc';
  const norm = normalizeUrl(url);
  expect(norm).not.toContain('utm_source');
  expect(norm).not.toContain('ref=abc');
  expect(norm.endsWith('/')).toBe(false);
  expect(norm).toContain('www.labseries.com');
});

test('nameSimilarity returns 1.0 for identical names', () => {
  expect(nameSimilarity('Daily Rescue Lotion', 'Daily Rescue Lotion')).toBe(1);
});

test('nameSimilarity returns high score for near-identical names', () => {
  const similarity = nameSimilarity(
    'Daily Rescue Energizing Lightweight Lotion Moisturizer',
    'Daily Rescue Energizing Lightweight Lotion Moisturizer 50ml',
  );
  expect(similarity).toBeGreaterThan(0.9);
});

test('scenario 1: anchor product returned by LLM is filtered', () => {
  const anchor = {
    brand: 'Lab Series',
    name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
    url: 'https://www.labseries.com/product/32020/123634/skincare/moisturizerspf/daily-rescue',
    product_id: 'prod_123',
  };
  const candidates = [
    {
      brand: 'Lab Series',
      name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
      url: 'https://www.labseries.com/product/32020/123634/skincare/moisturizerspf/daily-rescue',
      bucket: 'dupe',
      confidence: 0.78,
    },
    {
      brand: 'Clinique',
      name: 'Moisture Surge 100H Auto-Replenishing Hydrator',
      url: 'https://www.clinique.com/product/moisture-surge',
      bucket: 'dupe',
      confidence: 0.82,
    },
  ];

  const { kept, dropped, stats } = filterSelfReferences(candidates, anchor);
  expect(kept).toHaveLength(1);
  expect(dropped).toHaveLength(1);
  expect(dropped[0].brand).toBe('Lab Series');
  expect(stats.self_ref_dropped_count).toBe(1);
  expect(kept[0].brand).toBe('Clinique');
});

test('scenario 2: same brand same name different URL is filtered', () => {
  const anchor = {
    brand: 'Lab Series',
    name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
    url: 'https://www.labseries.com/product/32020/123634/skincare/daily-rescue',
  };
  const candidates = [
    {
      brand: 'Lab Series',
      name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
      url: 'https://www.sephora.com/product/lab-series-daily-rescue',
      bucket: 'dupe',
      confidence: 0.75,
    },
  ];

  const { kept, dropped } = filterSelfReferences(candidates, anchor);
  expect(kept).toHaveLength(0);
  expect(dropped).toHaveLength(1);
  expect(dropped[0]._drop_reason).toBe(DROP_REASON.SAME_BRAND_EXACT_LABEL);
});

test('scenario 2a: same brand candidate with leading brand prefix is filtered as exact label match', () => {
  const anchor = {
    brand: 'The Ordinary',
    name: 'Niacinamide 10% + Zinc 1%',
    display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
    category: 'Serum',
  };
  const candidates = [
    {
      brand: 'The Ordinary',
      name: 'The Ordinary Niacinamide 10% + Zinc 1%',
      category: 'Serum',
      confidence: 0.84,
    },
  ];

  const { kept, dropped } = filterSelfReferences(candidates, anchor);
  expect(kept).toHaveLength(0);
  expect(dropped).toHaveLength(1);
  expect(dropped[0]._drop_reason).toBe(DROP_REASON.SAME_BRAND_EXACT_LABEL);
});

test('scenario 2b: brand-missing catalog candidate with exact full-name match is filtered', () => {
  const anchor = {
    brand: 'The Ordinary',
    name: 'Niacinamide 10% + Zinc 1%',
    display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
    category: 'Serum',
  };
  const candidates = [
    {
      product_id: '9886499864904',
      name: 'The Ordinary Niacinamide 10% + Zinc 1%',
      category: 'Serum',
      url: 'https://agent.pivota.cc/products/9886499864904?merchant_id=merch_efbc46b4619cfbdf&entry=aurora_chatbox',
    },
  ];

  const { kept, dropped } = filterSelfReferences(candidates, anchor);
  expect(kept).toHaveLength(0);
  expect(dropped).toHaveLength(1);
  expect(dropped[0]._drop_reason).toBe(DROP_REASON.NO_BRAND_FULL_NAME_MATCH);
});

test('scenario 2c: brand-missing legacy synthetic suffix candidate is filtered', () => {
  const anchor = {
    brand: 'The Ordinary',
    name: 'Niacinamide 10% + Zinc 1%',
    display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
    category: 'Serum',
  };
  const candidates = [
    {
      name: 'The Ordinary Niacinamide 10% + Zinc 1% (budget dupe)',
      category: 'Serum',
      confidence: 0.78,
    },
  ];

  const { kept, dropped } = filterSelfReferences(candidates, anchor);
  expect(kept).toHaveLength(0);
  expect(dropped).toHaveLength(1);
  expect(dropped[0]._drop_reason).toBe(DROP_REASON.NO_BRAND_FULL_NAME_MATCH);
});

test('scenario 3: same brand different product line is allowed', () => {
  const anchor = {
    brand: 'Lab Series',
    name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
    url: 'https://www.labseries.com/product/daily-rescue',
  };
  const candidates = [
    {
      brand: 'Lab Series',
      name: 'MAX LS Age-Less Power V Lifting Cream',
      url: 'https://www.labseries.com/product/max-ls-power-v',
      bucket: 'premium_alternative',
      confidence: 0.65,
      why_not_the_same_product: 'Different product line (MAX LS anti-aging vs Daily Rescue energizing)',
    },
  ];

  const { kept, dropped } = filterSelfReferences(candidates, anchor);
  expect(kept).toHaveLength(1);
  expect(dropped).toHaveLength(0);
  expect(kept[0].why_not_the_same_product).toBeTruthy();
});

test('scenario 4: different brand extreme name similarity with same category is filtered', () => {
  const anchor = {
    brand: 'Lab Series',
    name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
    category: 'moisturizer',
  };
  const candidates = [
    {
      brand: 'LabSeries Store',
      name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
      category: 'moisturizer',
      bucket: 'dupe',
      confidence: 0.8,
    },
  ];

  const { kept, dropped } = filterSelfReferences(candidates, anchor);
  expect(kept).toHaveLength(0);
  expect(dropped).toHaveLength(1);
  expect(dropped[0]._drop_reason).toBe(DROP_REASON.CROSS_BRAND_EXTREME_SIMILARITY);
});

test('scenario 5: same canonical product ref different merchant is filtered', () => {
  const anchor = {
    brand: 'Lab Series',
    name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
    product_id: 'canonical_abc_123',
    merchant_id: 'merchant_A',
  };
  const candidates = [
    {
      brand: 'Lab Series',
      name: 'Daily Rescue Energizing Lotion',
      product_id: 'canonical_abc_123',
      merchant_id: 'merchant_B',
      bucket: 'dupe',
      confidence: 0.9,
    },
  ];

  const { kept, dropped } = filterSelfReferences(candidates, anchor);
  expect(kept).toHaveLength(0);
  expect(dropped[0]._drop_reason).toBe(DROP_REASON.SAME_CANONICAL_REF);
});

test('scenario 6: empty candidates array returns empty kept', () => {
  const anchor = { brand: 'Lab Series', name: 'Daily Rescue' };
  const { kept, dropped, stats } = filterSelfReferences([], anchor);
  expect(kept).toHaveLength(0);
  expect(dropped).toHaveLength(0);
  expect(stats.candidate_count_before).toBe(0);
  expect(stats.candidate_count_after).toBe(0);
});

test('scenario 7: post-filter insufficient candidates removes all self refs', () => {
  const anchor = {
    brand: 'Lab Series',
    name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
    url: 'https://www.labseries.com/product/daily-rescue',
  };
  const candidates = [
    {
      brand: 'Lab Series',
      name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
      url: 'https://www.labseries.com/product/daily-rescue',
      bucket: 'dupe',
      confidence: 0.78,
    },
    {
      brand: 'Lab Series',
      name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
      url: 'https://www.sephora.com/lab-series-daily-rescue',
      bucket: 'cheaper_alternative',
      confidence: 0.7,
    },
  ];

  const { kept, stats } = filterSelfReferences(candidates, anchor);
  expect(kept).toHaveLength(0);
  expect(stats.self_ref_dropped_count).toBe(2);
});

test('scenario 8: detectSelfReference catches leaked self-ref by URL', () => {
  const anchorIdentity = buildAnchorIdentity({
    brand: 'Lab Series',
    name: 'Daily Rescue Lotion',
    url: 'https://www.labseries.com/product/daily-rescue',
  });
  const anchorFingerprint = buildAnchorFingerprint({
    brand: 'Lab Series',
    name: 'Daily Rescue Lotion',
    url: 'https://www.labseries.com/product/daily-rescue',
  });
  const leakedCandidate = {
    brand: 'Lab Series',
    name: 'Daily Rescue Energizing Lotion',
    url: 'https://www.labseries.com/product/daily-rescue',
  };

  const detection = detectSelfReference(leakedCandidate, anchorIdentity, anchorFingerprint);
  expect(detection.isSelfRef).toBe(true);
  expect(detection.reason).toBe(DROP_REASON.SAME_NORMALIZED_URL);
});

test('scenario 8b: detectSelfReference catches leaked self-ref by same brand and high name similarity', () => {
  const anchorIdentity = buildAnchorIdentity({
    brand: 'Lab Series',
    name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
  });
  const anchorFingerprint = buildAnchorFingerprint({
    brand: 'Lab Series',
    name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
  });
  const leakedCandidate = {
    brand: 'Lab Series',
    name: 'Daily Rescue Energizing Lightweight Moisturizer Lotion',
  };

  const detection = detectSelfReference(leakedCandidate, anchorIdentity, anchorFingerprint);
  expect(detection.isSelfRef).toBe(true);
  expect(detection.reason).toBe(DROP_REASON.SAME_BRAND_HIGH_SIMILARITY);
});

test('scenario 9: deduplicateCandidates removes duplicate identity candidates', () => {
  const candidates = [
    { brand: 'CeraVe', name: 'Moisturizing Cream', bucket: 'dupe', confidence: 0.85 },
    { brand: 'CeraVe', name: 'Moisturizing Cream', bucket: 'cheaper_alternative', confidence: 0.7 },
    { brand: 'Neutrogena', name: 'Hydro Boost Gel-Cream', bucket: 'cheaper_alternative', confidence: 0.75 },
  ];

  const { deduplicated, duplicateIssues } = deduplicateCandidates(candidates);
  expect(deduplicated).toHaveLength(2);
  expect(duplicateIssues).toHaveLength(1);
  expect(duplicateIssues[0].code).toBe('DUPLICATE_IDENTITY_CANDIDATES');
});

test('scenario 10: candidate with missing key_differences and tradeoff is caught structurally', () => {
  const candidate = {
    brand: 'Neutrogena',
    name: 'Hydro Boost',
    bucket: 'dupe',
    confidence: 0.8,
    key_similarities: ['Lightweight texture'],
    key_differences: [],
    tradeoff: '',
  };

  expect(candidate.key_differences.length).toBe(0);
  expect(candidate.tradeoff).toBe('');
});

test('filterSelfReferences tracks accurate stats', () => {
  const anchor = {
    brand: 'CeraVe',
    name: 'Moisturizing Cream',
    url: 'https://www.cerave.com/moisturizing-cream',
    product_id: 'cerave_mc_001',
  };
  const candidates = [
    { brand: 'CeraVe', name: 'Moisturizing Cream', product_id: 'cerave_mc_001', bucket: 'dupe', confidence: 0.9 },
    { brand: 'CeraVe', name: 'Moisturizing Cream', url: 'https://www.target.com/cerave-moisturizing-cream', bucket: 'dupe', confidence: 0.85 },
    { brand: 'Vanicream', name: 'Moisturizing Skin Cream', bucket: 'dupe', confidence: 0.82 },
    { brand: 'Eucerin', name: 'Original Healing Cream', bucket: 'cheaper_alternative', confidence: 0.75 },
  ];

  const { kept, stats } = filterSelfReferences(candidates, anchor);
  expect(stats.candidate_count_before).toBe(4);
  expect(stats.self_ref_dropped_count).toBe(2);
  expect(stats.candidate_count_after).toBe(2);
  expect(kept).toHaveLength(2);
});

test('brand missing but URL identical is filtered', () => {
  const anchor = {
    brand: 'Lab Series',
    name: 'Daily Rescue',
    url: 'https://www.labseries.com/product/daily-rescue',
  };
  const candidates = [
    {
      brand: '',
      name: 'Some Lotion',
      url: 'https://www.labseries.com/product/daily-rescue',
      bucket: 'dupe',
      confidence: 0.7,
    },
  ];

  const { kept, dropped } = filterSelfReferences(candidates, anchor);
  expect(kept).toHaveLength(0);
  expect(dropped[0]._drop_reason).toBe(DROP_REASON.NO_BRAND_SAME_URL);
});

test('brand missing but anchor+suffix name is filtered as self reference', () => {
  const anchor = {
    brand: 'The Ordinary',
    name: 'Niacinamide 10% + Zinc 1%',
  };
  const candidates = [
    {
      brand: null,
      name: 'Niacinamide 10% + Zinc 1% (premium option)',
      bucket: 'dupe',
      confidence: 0.7,
    },
  ];

  const { kept, dropped } = filterSelfReferences(candidates, anchor);
  expect(kept).toHaveLength(0);
  expect(dropped).toHaveLength(1);
  expect(dropped[0]._drop_reason).toBe(DROP_REASON.SAME_BRAND_SAME_NAME);
});

test('buildAnchorIdentity passes null for missing fields', () => {
  const identity = buildAnchorIdentity({ brand: 'CeraVe', name: 'Cream' });
  expect(identity.product_id).toBeNull();
  expect(identity.merchant_id).toBeNull();
  expect(identity.brand).toBe('CeraVe');
  expect(identity.name).toBe('Cream');
  expect(identity.display_name).toBeNull();
  expect(identity.url).toBeNull();
  expect(identity.category).toBeNull();
});

test('detectUrlAsName identifies URL in name field', () => {
  const result = detectUrlAsName(
    'https://www.labseries.com/product/32020/123634/skincare/moisturizerspf/daily-rescue-energizing-lightweight-lotion-moisturizer/daily-rescue (budget dupe)',
  );
  expect(result.isUrlName).toBe(true);
  expect(result.extractedName).toBeTruthy();
  expect(result.extractedName.toLowerCase()).toContain('daily');
});

test('detectUrlAsName returns false for normal product name', () => {
  const result = detectUrlAsName('Daily Rescue Energizing Lightweight Lotion Moisturizer');
  expect(result.isUrlName).toBe(false);
  expect(result.extractedName).toBeNull();
});

test('sanitizeCandidateFields fixes URL-as-name and preserves URL on nested product rows', () => {
  const candidate = {
    kind: 'dupe',
    product: {
      brand: 'Lab Series',
      name: 'https://www.labseries.com/product/32020/123634/skincare/moisturizerspf/daily-rescue-energizing-lightweight-lotion-moisturizer/daily-rescue (budget dupe)',
    },
    confidence: 0.78,
  };

  const { sanitized, issues } = sanitizeCandidateFields(candidate);
  expect(sanitized.product.name.startsWith('http')).toBe(false);
  expect(sanitized.product.url).toBeTruthy();
  expect(sanitized._name_extracted_from_url).toBe(true);
  expect(issues).toHaveLength(1);
  expect(issues[0].code).toBe('NAME_IS_URL');
});

test('sanitizeCandidates fixes all URL-as-name candidates in a batch', () => {
  const candidates = [
    {
      product: {
        brand: 'Lab Series',
        name: 'https://www.labseries.com/product/daily-rescue (budget dupe)',
      },
      bucket: 'dupe',
      confidence: 0.78,
    },
    {
      product: {
        brand: 'Lab Series',
        name: 'https://www.labseries.com/product/daily-rescue (similar option)',
      },
      bucket: 'dupe',
      confidence: 0.74,
    },
    {
      product: {
        brand: 'Clinique',
        name: 'Moisture Surge 100H Hydrator',
      },
      bucket: 'cheaper_alternative',
      confidence: 0.8,
    },
  ];

  const { sanitized, issues } = sanitizeCandidates(candidates);
  expect(sanitized).toHaveLength(3);
  expect(issues).toHaveLength(2);
  expect(sanitized[0].product.name.startsWith('http')).toBe(false);
  expect(sanitized[1].product.name.startsWith('http')).toBe(false);
  expect(sanitized[2].product.name).toBe('Moisture Surge 100H Hydrator');
});

test('sanitized URL-as-name candidates are then caught by self-reference filter', () => {
  const anchor = {
    brand: 'Lab Series',
    name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
    url: 'https://www.labseries.com/product/32020/123634/skincare/moisturizerspf/daily-rescue-energizing-lightweight-lotion-moisturizer/daily-rescue',
  };
  const candidates = [
    {
      product: {
        brand: 'Lab Series',
        name: 'https://www.labseries.com/product/32020/123634/skincare/moisturizerspf/daily-rescue-energizing-lightweight-lotion-moisturizer/daily-rescue (budget dupe)',
      },
      bucket: 'dupe',
      confidence: 0.78,
    },
  ];

  const { sanitized } = sanitizeCandidates(candidates);
  const { kept, dropped } = filterSelfReferences(sanitized, anchor);
  expect(dropped).toHaveLength(1);
  expect(kept).toHaveLength(0);
});

test('buildAnchorFingerprint normalizes fields', () => {
  const fingerprint = buildAnchorFingerprint({
    brand: 'The Ordinary',
    name: 'Niacinamide 10% + Zinc 1% 30ml',
    url: 'https://theordinary.com/product/niacinamide?utm_source=ig',
  });
  expect(fingerprint.brand_norm).toBe('ordinary');
  expect(fingerprint.name_norm).not.toContain('30ml');
  expect(fingerprint.url_norm).not.toContain('utm_source');
});
