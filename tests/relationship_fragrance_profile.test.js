// A fragrance alternative must share a scent, quoted from both products. Pairs below are the prod
// 2026-10-10 review dry-run approvals (exact titles and categories) plus note-bearing controls.
const {
  isFragranceProduct,
  scentFamilies,
  fragranceAlternativeRejection,
} = require('../src/auroraBff/relationshipFragranceProfile');
const { validateRecommendationDecision, consumerCopyForKind } = require('../scripts/review-relationship-candidate-labels');

const product = (brand, title, category, extra = {}) => ({ brand, title, name: title, category, price: 40, price_currency: 'USD', ...extra });

describe('isFragranceProduct', () => {
  test.each([
    [product('Tomford Beauty', 'Black Orchid Eau de Parfum', 'fragrance')],
    [product('Upcircle Beauty', 'Santelle Eau De Parfum Sample Vial', 'fragrance')],
    [product('Kylie Cosmetics', 'Cosmic Kylie Jenner 2.0 Eau de Parfum', 'fragrance')],
    [product('Tomford Beauty', "Eau d'Ombré Leather Eau de Toilette", 'beauty')],
    [product('Sol de Janeiro', 'Cheirosa 62 Perfume Mist', 'body mist')],
    [product('Byra Beauty', 'Deep Calm - Eau De Parfum 30ml', '')],
    [product('Tom Ford Beauty', 'Black Orchid', 'beauty/fragrance/perfume')],
    [product('Tom Ford Beauty', 'Bitter Peach', 'perfume')],
    [product('Le Labo', 'Santal 33 Perfume Oil', 'fragrance')],
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
    [product('Sol de Janeiro', 'Unscented Hydrating Body Mist', 'body care')],
  ].map(([p]) => [p.title, p]))('%s is not a fragrance', (_title, p) => expect(isFragranceProduct(p)).toBe(false));
});

describe('scentFamilies', () => {
  test('names the families of the notes a quote lists', () => {
    expect([...scentFamilies('Top notes of bergamot and pink pepper; a base of sandalwood')].sort()).toEqual(['citrus', 'spicy', 'woody']);
    expect([...scentFamilies('heart of orange blossom and jasmine')]).toEqual(['floral']);
    expect([...scentFamilies('Notes: Oud, Rosewood, Cardamom, Vetiver, Amber')].sort()).toEqual(['amber', 'spicy', 'woody']);
  });
  test('generic words are not notes', () => {
    for (const quote of ['Eau de Parfum', 'a fresh, clean feel', 'green packaging', 'long-lasting 30ml spray', 'salt-free', 'Sample Vial']) {
      expect([quote, [...scentFamilies(quote)]]).toEqual([quote, []]);
    }
  });
  test('shelf taxonomy profile tags are not notes (prod tags Oud Wood EDP floral)', () => {
    expect([...scentFamilies('floral fragrance profiles')]).toEqual([]);
    expect([...scentFamilies('warm_fragrance_profiles')]).toEqual([]);
    expect([...scentFamilies('floral fragrance profiles; notes of jasmine')]).toEqual(['floral']);
  });
  test('a note inside a longer word is not that note', () => {
    expect(scentFamilies('with rosemary leaf').has('floral')).toBe(false);
    expect(scentFamilies('with rosemary leaf').has('aromatic')).toBe(true);
    expect(scentFamilies('Lilac Dream').has('floral')).toBe(true);
    expect(scentFamilies('a mossy greenhouse accent').has('woody')).toBe(false);
  });
});

describe('fragranceAlternativeRejection', () => {
  const santelle = product('Upcircle Beauty', 'Santelle Eau De Parfum Sample Vial', 'fragrance');
  const blackOrchid = product('Tomford Beauty', 'Black Orchid Eau de Parfum', 'fragrance');
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
  test('a perfume and a body product from the same fragrance shelf are not alternatives, shared note or not', () => {
    const oudEdp = product('Tomford Beauty', 'Oud Wood Eau de Parfum', 'fragrance');
    const oudLotion = product('Tomford Beauty', 'Oud Wood Hand and Body Moisturizer', 'fragrance');
    expect(fragranceAlternativeRejection(oudEdp, oudLotion, [{ anchor_fact: 'rare oud wood', candidate_fact: 'rare oud wood' }]))
      .toBe('fragrance_category_mismatch');
  });
  test('a perfume and a non-fragrance product are never alternatives', () => {
    const fentyGel = product('Fenty Beauty', 'Instant Reset Brightening Overnight Recovery Gel-Cream', 'skincare');
    const oudLotion = product('Tomford Beauty', 'Oud Wood Hand and Body Moisturizer', 'skincare');
    expect(fragranceAlternativeRejection(blackOrchid, oudLotion, [{ anchor_fact: 'oud', candidate_fact: 'oud' }])).toBe('fragrance_category_mismatch');
    expect(fragranceAlternativeRejection(fentyGel, oudLotion, [])).toBeNull();
  });
});

describe('the reviewer validator applies the fragrance rule to approvals', () => {
  const edge = (a, b, relationType = 'competitive_alternative') => ({
    id: 'rcl_fragrance', anchor_type: 'product', anchor_ref: 'product:a', candidate_product_ref: 'product:b',
    anchor_snapshot: { product_ref: 'product:a', ...a }, candidate_snapshot: { product_ref: 'product:b', ...b },
    relation_type: relationType, label_state: 'generated', score_total: 0.8, score_breakdown: {}, source_refs: [{ type: 'catalog_products' }],
  });
  const approval = (quotes) => ({ verdict: 'approve', confidence: 0.9, rationale: 'Both products are eau de parfum with the quoted notes.',
    relationship_kind: 'alternative', ...consumerCopyForKind('alternative'), shared_evidence: quotes });
  const flaura = product('Upcircle Beauty', 'Flaura + Santelle Eau De Parfum Sample Vials', 'fragrance',
    { description: 'Santelle opens with bergamot and settles into creamy sandalwood and cedar.' });
  const oudWood = product('Tomford Beauty', 'Oud Wood Parfum', 'fragrance',
    { description: 'Rare oud wood, sandalwood and vetiver with tonka bean and amber.' });

  test('title-only quotes: refused with fragrance_scent_profile_unmatched', () => {
    const e = edge(flaura, oudWood);
    expect(validateRecommendationDecision(e, approval([{ anchor_fact: flaura.title, candidate_fact: oudWood.title }])))
      .toMatchObject({ verdict: 'reject', utility_rejection: 'fragrance_scent_profile_unmatched' });
  });
  test('verbatim note quotes sharing a family: approved', () => {
    const e = edge(flaura, oudWood);
    expect(validateRecommendationDecision(e, approval([{ anchor_fact: 'creamy sandalwood and cedar', candidate_fact: 'sandalwood and vetiver' }])).verdict)
      .toBe('approve');
  });
  test('a note quote that is not in the product text is still refused by grounding first', () => {
    const e = edge(flaura, oudWood);
    expect(validateRecommendationDecision(e, approval([{ anchor_fact: 'smoky oud and sandalwood', candidate_fact: 'sandalwood and vetiver' }])))
      .toMatchObject({ verdict: 'reject', utility_rejection: 'recommendation_facts_not_supplied' });
  });
  test('a niche_specialist claim between perfumes is held to the same rule', () => {
    const e = edge(flaura, oudWood, 'niche_specialist');
    expect(validateRecommendationDecision(e, approval([{ anchor_fact: flaura.title, candidate_fact: oudWood.title }])))
      .toMatchObject({ verdict: 'reject' });
    expect(validateRecommendationDecision(e, approval([{ anchor_fact: flaura.title, candidate_fact: oudWood.title }])).utility_rejection)
      .toBe('fragrance_scent_profile_unmatched');
  });
  test('a non-fragrance alternative is unaffected', () => {
    const a = product('Anua', 'Anua Peach 77 Niacin Essence Toner (250ml)', 'toner');
    const b = product('Round Lab', '[ROUND LAB] Dokdo Toner 200ml | 500ml', 'toner');
    const e = edge(a, b);
    expect(validateRecommendationDecision(e, approval([{ anchor_fact: a.title, candidate_fact: b.title }])).verdict).toBe('approve');
  });
});
