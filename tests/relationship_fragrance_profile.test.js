// A fragrance alternative must share a scent, quoted from both products' own scent text. Pairs below
// are the prod 2026-10-10 review dry-run approvals (exact titles and categories), prod shelf rows,
// and the adversarial review's probes (review r1 on this change).
const {
  isFragranceProduct,
  scentFamilies,
  quotedFromScentText,
  fragranceAlternativeRejection,
} = require('../src/auroraBff/relationshipFragranceProfile');
const {
  validateRecommendationDecision,
  consumerCopyForKind,
  buildReviewPrompt,
  buildEvidence,
} = require('../scripts/review-relationship-candidate-labels');

const product = (brand, title, category, extra = {}) => ({ brand, title, name: title, category, price: 40, price_currency: 'USD', ...extra });
const families = (value) => [...scentFamilies(value)].sort();

describe('isFragranceProduct', () => {
  test.each([
    [product('Tomford Beauty', 'Black Orchid Eau de Parfum', 'fragrance')],
    [product('Upcircle Beauty', 'Santelle Eau De Parfum Sample Vial', 'fragrance')],
    [product('Kylie Cosmetics', 'Cosmic Kylie Jenner 2.0 Eau de Parfum', 'fragrance')],
    [product('Tomford Beauty', "Eau d'Ombré Leather Eau de Toilette", 'beauty')],
    [product('Byra Beauty', 'Deep Calm - Eau De Parfum 30ml', '')],
    [product('Tom Ford Beauty', 'Black Orchid', 'beauty/fragrance/perfume')],
    [product('Tom Ford Beauty', 'Bitter Peach', 'perfume')],
    [product('Maison X', 'Velvet Rose', 'beauty_parfum')],
    [product('Le Labo', 'Santal 33 Perfume Oil', 'fragrance')],
    [product('Maison X', 'Oud Satin EDP 50ml', 'beauty')],
    [product('Maison X', 'Neroli EDT', 'beauty')],
    [product('Maison X', 'Rose Extrait 30ml', 'beauty')],
    [product('4711', 'Original Eau de Cologne', 'beauty')],
    [product('Maison X', 'Acqua Cologne Intense', 'beauty')],
    [product('Sol de Janeiro', 'Cheirosa 62 Perfume Mist', 'body mist')],
    [product('Sol de Janeiro', 'Brazilian Crush Body Mist', 'beauty')],
    [product('Gisou', 'Honey Infused Hair Perfume', 'hair')],
    // Perfumes named after a scent that is also a product word (review r2): the product noun is last.
    [product('Maison Margiela', 'Replica Bubble Bath Eau de Toilette', 'fragrance')],
    [product('Maison X', 'Milk Eau de Parfum', 'fragrance')],
    [product('Maison X', 'Shower Fresh Eau de Parfum', 'fragrance')],
    [product('Maison X', 'Gel Eau de Toilette', 'fragrance')],
    [product('Maison X', 'Vanilla Musk Oil Rollerball', 'fragrance')],
    [product('Maison X', 'Santal Roll-On', 'fragrance')],
    [product('Tom Ford Beauty', 'Soleil Blanc All Over Body Spray', 'fragrance')],
    [product('Maison X', 'Amber Solid Perfume Balm', 'fragrance')],
  ].map(([p]) => [p.title, p]))('%s is a fragrance', (_title, p) => expect(isFragranceProduct(p)).toBe(true));

  test.each([
    [product('Tomford Beauty', 'Oud Wood Hand and Body Moisturizer', 'skincare')],
    [product('CeraVe', 'Fragrance-Free Moisturizing Lotion', 'moisturizer')],
    [product('Vanicream', 'Unscented Gentle Body Wash', 'body care')],
    [product('Fenty Beauty', 'Instant Reset Brightening Overnight Recovery Gel-Cream', 'skincare')],
    [product('Naturium', 'Phyto-Glow Lip Balm Lychee', 'Lip Balm')],
    // A 'fragrance' category is a shelf: these prod Tom Ford rows sit on it and are not perfumes.
    [product('Tomford Beauty', 'Oud Wood Conditioning Beard Oil', 'fragrance')],
    [product('Tomford Beauty', 'Oud Wood Hand and Body Moisturizer', 'fragrance')],
    [product('Tom Ford Beauty', 'Soleil Blanc Shimmering Body Oil', 'fragrance')],
    [product('Tom Ford Beauty', 'Neroli Portofino Candle', 'fragrance')],
    [product('Maison X', 'Rose Body Butter', 'fragrance')],
    [product('Maison X', 'Neroli Shower Foam', 'fragrance')],
    [product('Maison X', 'Oud Room Spray', 'fragrance')],
    // A perfume word next to another form is that form (review r1).
    [product('Maison X', 'Eau de Parfum Hand Cream', 'hand care')],
    [product('Maison X', 'Cologne Intense Body Wash', 'body care')],
    [product('Maison X', 'Rose Extrait Face Oil', 'face oil')],
    // A mist with a skin or hair function is not a perfume (review r1).
    [product('Supergoop!', 'PLAY Antioxidant Body Mist SPF 50', 'sunscreen')],
    [product('Ouai', 'Farewell Frizz Heat Protectant Hair Mist', 'hair')],
    [product('Sol de Janeiro', 'Unscented Hydrating Body Mist', 'body care')],
    [product('Maison X', 'Hydrating Toner', 'Fragrance-Free Skincare')],
    // Roll-ons with another job, and skincare actives on a fragrance shelf (review r3, prod audit).
    [product('Dove', 'Antiperspirant Deodorant Roll-On', 'deodorant')],
    [product('Maison X', 'Caffeine Eye Serum Rollerball', 'fragrance')],
    [product('Maison X', 'Tea Tree Spot Roll-On', 'skincare')],
    [product('Maison X', 'Vanilla Roll-On', 'body care')],
    [product('Naturium', 'Salicylic Acid Body Spray 2%', 'fragrance')],
    [product('Murad', 'Clarifying Body Spray', 'fragrance')],
  ].map(([p]) => [p.title, p]))('%s is not a fragrance', (_title, p) => expect(isFragranceProduct(p)).toBe(false));

  test('the name the model was shown counts even when title differs', () => {
    expect(isFragranceProduct({ title: 'Oud Wood', name: 'Oud Wood Eau de Parfum', category: 'beauty' })).toBe(true);
  });
});

describe('scentFamilies', () => {
  test('names the families of the notes a quote lists', () => {
    expect(families('Top notes of bergamot and pink pepper; a base of sandalwood')).toEqual(['citrus', 'spicy', 'woody']);
    expect(families('heart of orange blossom and jasmine')).toEqual(['floral']);
    expect(families('heart of orange-blossom')).toEqual(['floral']);
    expect(families('Notes: Oud, Rosewood, Cardamom, Vetiver, Amber')).toEqual(['amber', 'spicy', 'woody']);
    expect(families('rich tobacco leaf')).toEqual(['leather']);
    expect(families('a floral bouquet')).toEqual(['floral']);
  });
  test('plurals and French spellings perfumers print', () => {
    expect(families('juicy pears and cherries')).toEqual(['fruity']);
    expect(families('crushed violets and lemons')).toEqual(['citrus', 'floral']);
    expect(families('dry woods')).toEqual(['woody']);
    expect(families('santal and musc blanc')).toEqual(['musk', 'woody']);
    expect(families('vanille, ambre, néroli')).toEqual(['amber', 'citrus', 'floral', 'gourmand']);
  });
  test('generic words are not notes', () => {
    for (const quote of ['Eau de Parfum', 'a fresh, clean feel', 'green packaging', 'long-lasting 30ml spray', 'salt-free', 'Sample Vial']) {
      expect([quote, families(quote)]).toEqual([quote, []]);
    }
  });
  test('the two shelf taxonomy tags are not notes (prod tags Oud Wood EDP floral); other text is kept', () => {
    expect(families('floral fragrance profiles')).toEqual([]);
    expect(families('floral_fragrance_profiles')).toEqual([]);
    expect(families('fresh citrus profiles')).toEqual([]);
    expect(families('fresh_citrus_profiles')).toEqual([]);
    expect(families('warm fragrance profiles, floral fragrance profiles')).toEqual([]);
    expect(families('floral fragrance profiles; notes of jasmine')).toEqual(['floral']);
    expect(families('a jasmine fragrance profile')).toEqual(['floral']);
    expect(families('woody fragrance profile')).toEqual(['woody']);
  });
  test('packaging colours and carrier oils are not notes (review r2)', () => {
    for (const quote of ['amber glass bottle', 'fractionated coconut oil', 'rose gold cap', 'mint green box', 'sweet almond oil', 'recyclable amber glass']) {
      expect([quote, families(quote)]).toEqual([quote, []]);
    }
    expect(families('notes of amber and coconut')).toEqual(['amber', 'fruity']);
    expect(families('a coconut milk accord')).toEqual(['fruity']);
    expect(families('a rose blush accord')).toEqual(['floral']);
  });
  test('a note inside a longer word is not that note', () => {
    expect(scentFamilies('with rosemary leaf').has('floral')).toBe(false);
    expect(scentFamilies('with rosemary leaf').has('aromatic')).toBe(true);
    expect(families('PixiFig')).toEqual([]);
    expect(families('PixiMimosa Sample')).toEqual([]);
    expect(families('Cloud Eau de Parfum')).toEqual([]);
    expect(scentFamilies('Lilac Dream').has('floral')).toBe(true);
    expect(scentFamilies('a mossy greenhouse accent').has('woody')).toBe(false);
  });
});

describe('quotedFromScentText', () => {
  const p = product('Henry Rose', "Henry Rose Jake's House Eau de Parfum", 'fragrance', {
    description: 'rosemary and clary sage over vetiver',
    category_taxonomy: ['fragrance', 'floral fragrance profiles'],
    tags: ['floral'],
  });
  test('whole-word spans of the name and description count', () => {
    expect(quotedFromScentText(p, 'clary sage')).toBe(true);
    expect(quotedFromScentText(p, 'vetiver')).toBe(true);
  });
  test('taxonomy, tags, brand and mid-word spans do not', () => {
    expect(quotedFromScentText(p, 'floral')).toBe(false);
    expect(quotedFromScentText(p, 'Rose')).toBe(false);
    expect(quotedFromScentText(p, 'rose')).toBe(false);
    expect(quotedFromScentText(product('Maison X', 'Primrose Eau de Parfum', 'fragrance'), 'rose')).toBe(false);
  });
  test('quotes match across whitespace runs', () => {
    expect(quotedFromScentText(p, 'clary   sage  over vetiver')).toBe(true);
  });
  test('notes only in intel highlights or best_for count (the evidence the model saw)', () => {
    expect(quotedFromScentText({ title: 'X Eau de Parfum', why_it_stands_out: ['A smoky oud and saffron accord'] }, 'smoky oud')).toBe(true);
    expect(quotedFromScentText({ title: 'X Eau de Parfum', best_for: ['fans of white musk'] }, 'white musk')).toBe(true);
  });
});

describe('fragranceAlternativeRejection', () => {
  const santelle = product('Upcircle Beauty', 'Santelle Eau De Parfum Sample Vial', 'fragrance', { description: 'notes of bergamot and lemon, warm sandalwood and cedar' });
  const blackOrchid = product('Tomford Beauty', 'Black Orchid Eau de Parfum', 'fragrance', { description: 'dark chocolate and vanilla, patchouli and sandalwood' });
  test('title-only evidence between two perfumes is refused (prod dry-run approval)', () => {
    expect(fragranceAlternativeRejection(santelle, blackOrchid, [{ anchor_fact: 'Santelle Eau De Parfum Sample Vial', candidate_fact: 'Black Orchid Eau de Parfum' }]))
      .toBe('fragrance_scent_profile_unmatched');
  });
  test('quotes naming notes in different families are refused', () => {
    expect(fragranceAlternativeRejection(santelle, blackOrchid, [{ anchor_fact: 'notes of bergamot and lemon', candidate_fact: 'dark chocolate and vanilla' }]))
      .toBe('fragrance_scent_profile_unmatched');
  });
  test('quotes sharing a scent family pass', () => {
    expect(fragranceAlternativeRejection(santelle, blackOrchid, [
      { anchor_fact: 'Eau De Parfum', candidate_fact: 'Eau de Parfum' },
      { anchor_fact: 'warm sandalwood and cedar', candidate_fact: 'patchouli and sandalwood' },
    ])).toBeNull();
  });
  test('a shared note that is not in the product text is refused', () => {
    expect(fragranceAlternativeRejection(santelle, blackOrchid, [{ anchor_fact: 'smoky oud', candidate_fact: 'patchouli and sandalwood' }]))
      .toBe('fragrance_scent_profile_unmatched');
  });
  test('a perfume and a body product from the same fragrance shelf are not alternatives, shared note or not', () => {
    const oudEdp = product('Tomford Beauty', 'Oud Wood Eau de Parfum', 'fragrance');
    const oudLotion = product('Tomford Beauty', 'Oud Wood Hand and Body Moisturizer', 'fragrance');
    expect(fragranceAlternativeRejection(oudEdp, oudLotion, [{ anchor_fact: 'Oud Wood', candidate_fact: 'Oud Wood' }]))
      .toBe('fragrance_category_mismatch');
  });
  test('a perfume with no perfume signal is held to the scent rule, not refused as a mismatch', () => {
    const br540 = product('Maison Francis Kurkdjian', 'Baccarat Rouge 540', 'other', { description: 'saffron, amberwood and fir resin' });
    const cloud = product('Ariana Grande', 'Cloud Eau de Parfum', 'fragrance', { description: 'amber and musk' });
    expect(fragranceAlternativeRejection(br540, cloud, [{ anchor_fact: 'Baccarat Rouge 540', candidate_fact: 'Cloud Eau de Parfum' }]))
      .toBe('fragrance_scent_profile_unmatched');
    expect(fragranceAlternativeRejection(br540, cloud, [{ anchor_fact: 'fir resin', candidate_fact: 'amber and musk' }])).toBeNull();
  });
  test('two non-fragrance products are not this rule\'s question', () => {
    const fentyGel = product('Fenty Beauty', 'Instant Reset Brightening Overnight Recovery Gel-Cream', 'skincare');
    const oudLotion = product('Tomford Beauty', 'Oud Wood Hand and Body Moisturizer', 'skincare');
    expect(fragranceAlternativeRejection(fentyGel, oudLotion, [])).toBeNull();
  });
});

describe('the reviewer validator applies the fragrance rule to approvals', () => {
  const edge = (a, b, relationType = 'competitive_alternative') => ({
    id: 'rcl_fragrance', anchor_type: 'product', anchor_ref: 'product:a', candidate_product_ref: 'product:b',
    anchor_snapshot: { product_ref: 'product:a', ...a }, candidate_snapshot: { product_ref: 'product:b', ...b },
    relation_type: relationType, label_state: 'generated', score_total: 0.8, score_breakdown: {}, source_refs: [{ type: 'catalog_products' }],
    price_evidence: relationType === 'dupe' ? { fresh: true } : {},
  });
  const approval = (quotes, kind = 'alternative') => ({ verdict: 'approve', confidence: 0.9, rationale: 'Both products are eau de parfum with the quoted notes.',
    relationship_kind: kind, ...consumerCopyForKind(kind), shared_evidence: quotes });
  const flaura = product('Upcircle Beauty', 'Flaura + Santelle Eau De Parfum Sample Vials', 'fragrance',
    { description: 'Santelle opens with bergamot and settles into creamy sandalwood and cedar.', category_taxonomy: ['fragrance', 'floral fragrance profiles'] });
  const oudWood = product('Tomford Beauty', 'Oud Wood Parfum', 'fragrance',
    { description: 'Rare oud wood, sandalwood and vetiver with tonka bean and amber.', category_taxonomy: ['fragrance', 'warm fragrance profiles', 'floral fragrance profiles'] });

  test('title-only quotes: refused with fragrance_scent_profile_unmatched', () => {
    const e = edge(flaura, oudWood);
    expect(validateRecommendationDecision(e, approval([{ anchor_fact: flaura.title, candidate_fact: oudWood.title }])))
      .toMatchObject({ verdict: 'reject', utility_rejection: 'fragrance_scent_profile_unmatched' });
  });
  test('P1 (review r1): "floral" quoted out of both shelf tags is grounded but refused', () => {
    const e = edge(flaura, oudWood);
    for (const quote of ['floral', 'floral fragrance', 'floral fragrance profiles']) {
      expect([quote, validateRecommendationDecision(e, approval([{ anchor_fact: quote, candidate_fact: quote }])).utility_rejection])
        .toEqual([quote, 'fragrance_scent_profile_unmatched']);
    }
  });
  test('each side is held to its own scent text: a clean anchor quote cannot carry a taxonomy candidate quote', () => {
    const jasmine = product('Upcircle Beauty', 'Flaura + Santelle Eau De Parfum Sample Vials', 'fragrance', { description: 'Flaura is night-blooming jasmine and tuberose.', category_taxonomy: ['fragrance', 'floral fragrance profiles'] });
    const e = edge(jasmine, oudWood);
    expect(validateRecommendationDecision(e, approval([{ anchor_fact: 'night-blooming jasmine', candidate_fact: 'floral' }])).utility_rejection)
      .toBe('fragrance_scent_profile_unmatched');
  });
  test('notes the model saw only in intel highlights are judged from the evidence, not the bare snapshot', () => {
    const intelOnly = product('Maison X', 'Nuit Eau de Parfum', 'fragrance', {
      category_taxonomy: ['fragrance', 'floral fragrance profiles'],
      product_intel: { product_intel_core: { why_it_stands_out: ['sandalwood and smoked cedar at its base'] } },
    });
    const e = edge(intelOnly, oudWood);
    expect(validateRecommendationDecision(e, approval([{ anchor_fact: 'sandalwood and smoked cedar', candidate_fact: 'sandalwood and vetiver' }])).verdict)
      .toBe('approve');
  });
  test('verbatim note quotes sharing a family: approved', () => {
    const e = edge(flaura, oudWood);
    expect(validateRecommendationDecision(e, approval([{ anchor_fact: 'creamy sandalwood and cedar', candidate_fact: 'sandalwood and vetiver' }])).verdict)
      .toBe('approve');
  });
  test('mid-word and brand quotes are refused (review r1)', () => {
    const sage = product('Henry Rose', "Jake's House Eau de Parfum", 'fragrance', { description: 'rosemary and clary sage' });
    const roseJasmine = product('Maison X', 'Rose Jasmin Eau de Parfum', 'fragrance', { description: 'rose and jasmine' });
    const e = edge(sage, roseJasmine);
    expect(validateRecommendationDecision(e, approval([{ anchor_fact: 'rose', candidate_fact: 'rose and jasmine' }])).utility_rejection)
      .toBe('fragrance_scent_profile_unmatched');
    expect(validateRecommendationDecision(e, approval([{ anchor_fact: 'Henry Rose', candidate_fact: 'rose and jasmine' }])).verdict).toBe('reject');
  });
  test('a quote that is not in the product text is still refused by grounding first', () => {
    const e = edge(flaura, oudWood);
    expect(validateRecommendationDecision(e, approval([{ anchor_fact: 'smoky oud and sandalwood', candidate_fact: 'sandalwood and vetiver' }])))
      .toMatchObject({ verdict: 'reject', utility_rejection: 'recommendation_facts_not_supplied' });
  });
  test.each(['niche_specialist', 'dupe'])('a %s claim between perfumes is held to the same rule', (relationType) => {
    const e = edge(flaura, oudWood, relationType);
    const kind = relationType === 'dupe' ? 'dupe' : 'alternative';
    const verdict = validateRecommendationDecision(e, approval([{ anchor_fact: flaura.title, candidate_fact: oudWood.title }], kind));
    expect(verdict.verdict).toBe('reject');
    if (relationType === 'niche_specialist') expect(verdict.utility_rejection).toBe('fragrance_scent_profile_unmatched');
  });
  test('a non-fragrance alternative is unaffected', () => {
    const a = product('Anua', 'Anua Peach 77 Niacin Essence Toner (250ml)', 'toner');
    const b = product('Round Lab', '[ROUND LAB] Dokdo Toner 200ml | 500ml', 'toner');
    const e = edge(a, b);
    expect(validateRecommendationDecision(e, approval([{ anchor_fact: a.title, candidate_fact: b.title }])).verdict).toBe('approve');
  });
  test('an SPF body mist alternative is not a fragrance question', () => {
    const a = product('Supergoop!', 'PLAY Antioxidant Body Mist SPF 50', 'sunscreen');
    const b = product('Sun Bum', 'Original SPF 50 Sunscreen Spray', 'sunscreen');
    expect(fragranceAlternativeRejection(a, b, [])).toBeNull();
  });
  test('the prompt tells the model the fragrance rule', () => {
    const e = edge(flaura, oudWood);
    expect(buildReviewPrompt(buildEvidence(e, new Map()))).toMatch(/Fragrance \(eau de parfum\/toilette, perfume, cologne, body mist\): a shared category is not a substitute/);
  });
});
