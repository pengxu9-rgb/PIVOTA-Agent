// The serving guard hides AI-approved fragrance alternatives that no product text could justify.
// Pairs are prod live edges from the 2026-10-10 audit (exact titles; descriptions trimmed to the
// notes that decide the verdict). Measured on all 192 live fragrance-touching edges: exactly the 23
// audited lazy pairs are hidden, every human_approved edge is kept.
const {
  getRelationshipEdgeServingSuppressionReasons: reasonsFor,
  isRelationshipEdgeServingSafe,
} = require('../src/auroraBff/productRelationshipGraph');
const { fragranceServingSuppressionReason } = require('../src/auroraBff/relationshipFragranceProfile');

const snap = (ref, brand, name, category, extra = {}) => ({ product_ref: ref, brand, name, title: name, category, ...extra });
const edge = (anchor, candidate, overrides = {}) => ({
  id: 'prel_fixture', anchor_type: 'product', anchor_ref: anchor.product_ref, candidate_product_ref: candidate.product_ref,
  relation_type: 'competitive_alternative', label_state: 'ai_approved', market: 'US', vertical: 'beauty',
  anchor_snapshot: anchor, candidate_snapshot: candidate, ...overrides,
});
const fragranceReasons = (e) => reasonsFor(e).filter((reason) => reason.includes('fragrance'));

const pradaAmber = snap('product:sig_a1', 'Prada', 'Prada Amber Perfume', 'fragrance', { description: 'A warm amber and benzoin signature.' });
const ari = snap('product:sig_b2', 'Ariana Grande', 'Ari Perfume', 'fragrance', { description: 'Pear, raspberry and marshmallow over white musk and woods.' });
const idole = snap('product:sig_c3', 'Lancôme', 'Idole Perfume', 'fragrance', { description: 'Rose, jasmine and white musk with pear.' });
const oudLotion = snap('product:sig_d4', 'Tomford Beauty', 'Oud Wood Hand and Body Moisturizer', 'fragrance', { description: 'rare oud wood' });
const oudEdp = snap('product:sig_e5', 'Tomford Beauty', 'Oud Wood Eau de Parfum', 'fragrance', { description: 'rare oud wood and sandalwood' });

describe('fragrance serving guard', () => {
  test('an AI-approved perfume pair whose texts share no scent family is hidden (prod: Prada Amber <-> Ari)', () => {
    const e = edge(pradaAmber, ari);
    expect(fragranceReasons(e)).toEqual(['competitive_alternative_fragrance_no_shared_scent_family']);
    expect(isRelationshipEdgeServingSafe(e)).toBe(false);
  });
  test('a perfume pair whose texts share a family is kept (prod: Idole <-> Ari share fruity, musk)', () => {
    expect(fragranceReasons(edge(idole, ari))).toEqual([]);
  });
  test('a human decision is never hidden by this rule', () => {
    expect(fragranceReasons(edge(pradaAmber, ari, { label_state: 'human_approved' }))).toEqual([]);
  });
  test('a perfume against a body product from the same shelf is hidden', () => {
    expect(fragranceReasons(edge(oudEdp, oudLotion))).toEqual(['competitive_alternative_fragrance_category_mismatch']);
  });
  test.each(['dupe', 'niche_specialist'])('the %s lane carries its own reason prefix', (relationType) => {
    expect(fragranceReasons(edge(pradaAmber, ari, { relation_type: relationType }))).toContain(`${relationType}_fragrance_no_shared_scent_family`);
  });
  test('the related_product lane is not this rule\'s question', () => {
    expect(fragranceReasons(edge(pradaAmber, ari, { relation_type: 'related_product' }))).toEqual([]);
  });
  test('two non-fragrance products are untouched', () => {
    const a = snap('product:sig_f6', 'Naturium', 'Salicylic Acid Body Spray 2%', 'fragrance');
    const b = snap('product:sig_g7', 'Murad', 'Clarifying Body Spray', 'fragrance');
    expect(fragranceReasons(edge(a, b))).toEqual([]);
  });
  test('notes kept only in the raw snapshot intel (intel_text, product_intel core) count', () => {
    const intelOnly = snap('product:sig_h8', 'Maison X', 'Nuit Eau de Parfum', 'fragrance', {
      intel_text: 'A gourmand vanilla and tonka heart.',
    });
    const coreOnly = snap('product:sig_i9', 'Maison Y', 'Jour Eau de Parfum', 'fragrance', {
      product_intel: { product_intel_core: { why_it_stands_out: ['caramel and praline'], best_for: [] } },
    });
    expect(fragranceServingSuppressionReason(intelOnly, coreOnly)).toBe('');
    expect(fragranceServingSuppressionReason(intelOnly, ari)).toBe('');
    expect(fragranceServingSuppressionReason(pradaAmber, coreOnly)).toBe('fragrance_no_shared_scent_family');
  });
  test('a perfume with no scent text at all is hidden against any perfume (prod: note-less Dior Addict listing)', () => {
    const addict = snap('product:sig_j0', 'Dior', 'Addict Perfume', 'fragrance', { description: '' });
    expect(fragranceReasons(edge(idole, addict))).toEqual(['competitive_alternative_fragrance_no_shared_scent_family']);
  });
});
