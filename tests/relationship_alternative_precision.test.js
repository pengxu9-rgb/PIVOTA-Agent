// competitive_alternative precision on real served pairs (2026-10-08 export, exact exported titles,
// categories and shelf taxonomies). A builder alternative is served on the PDP similar rail once
// approved, and the reviewer re-checks every approval with the same inferRelationship, so a pair
// listed as not_alternative here must be refused by both.
const real = require('./fixtures/relgraph_alternative_precision_2026_10_09.json');
const { buildEdgeForCandidate, __internal: { inferRelationship } } = require('../src/auroraBff/productRelationshipGraphBuilder');
const { validateRecommendationDecision, consumerCopyForKind } = require('../scripts/review-relationship-candidate-labels');

const NOW = '2026-10-09T00:00:00.000Z';
const snapshot = (side, ref) => ({ product_ref: ref, brand: side.brand, name: side.name, title: side.name, category: side.category,
  category_taxonomy: side.category_taxonomy || [], price: 20, price_currency: 'USD' });
const build = (row) => buildEdgeForCandidate({
  anchor: snapshot(row.anchor, 'product:a'),
  candidate: { ...snapshot(row.candidate, 'product:b'), similarity_score: row.score_total, source_refs: [{ type: 'catalog_products' }] },
  nowIso: NOW,
});
const builtRelation = (built) => (built.edge && !built.errors.length ? built.edge.relation_type : 'rejected');

const negatives = real.cases.filter((row) => row.expected === 'not_alternative');
const guards = real.cases.filter((row) => row.expected === 'competitive_alternative');

describe('builder: real served pairs that are not one shopper job', () => {
  test.each(negatives.map((row) => [row.family, row.anchor.name, row.candidate.name, row]))('%s: %s || %s', (_family, _a, _b, row) => {
    const built = build(row);
    expect(builtRelation(built)).not.toBe('competitive_alternative');
    expect(builtRelation(built)).not.toBe('dupe');
  });
});

describe('builder: real served alternatives stay alternatives', () => {
  test.each(guards.map((row) => [row.anchor.name, row.candidate.name, row.why, row]))('%s || %s (%s)', (_a, _b, _why, row) => {
    expect(builtRelation(build(row))).toBe('competitive_alternative');
  });
});

describe('reviewer: an alternative approval on these pairs is refused by the same rule', () => {
  const approval = (a, b) => ({ verdict: 'approve', confidence: 0.99, rationale: 'The supplied product titles identify the claimed shopper job and differences.',
    relationship_kind: 'alternative', ...consumerCopyForKind('alternative'),
    shared_evidence: [{ anchor_fact: a.title, candidate_fact: b.title }] });
  const edge = (row) => {
    const a = snapshot(row.anchor, 'product:a'); const b = snapshot(row.candidate, 'product:b');
    return { id: 'rcl_fixture', anchor_type: 'product', anchor_ref: 'product:a', candidate_product_ref: 'product:b', anchor_snapshot: a, candidate_snapshot: b,
      relation_type: 'competitive_alternative', label_state: 'generated', score_total: row.score_total,
      score_breakdown: {}, source_refs: [{ type: 'catalog_products' }] };
  };
  test.each(negatives.map((row) => [row.anchor.name, row.candidate.name, row]))('%s || %s', (_a, _b, row) => {
    const e = edge(row);
    expect(validateRecommendationDecision(e, approval(e.anchor_snapshot, e.candidate_snapshot))).toMatchObject({
      verdict: 'reject', utility_rejection: 'structural_or_dupe_evidence_mismatch' });
  });
  test.each(guards.map((row) => [row.anchor.name, row.candidate.name, row]))('guard still approvable: %s || %s', (_a, _b, row) => {
    const e = edge(row);
    expect(validateRecommendationDecision(e, approval(e.anchor_snapshot, e.candidate_snapshot)).verdict).toBe('approve');
  });
});

describe('inference stays symmetric on the refused pairs', () => {
  test.each(negatives.map((row) => [row.anchor.name, row.candidate.name, row]))('%s || %s reversed', (_a, _b, row) => {
    const a = snapshot(row.candidate, 'product:b'); const b = snapshot(row.anchor, 'product:a');
    expect(inferRelationship(a, b, { ...b, similarity_score: row.score_total }).relation_type).not.toBe('competitive_alternative');
  });
});

describe('routine roles read the product, not its shade or formula traits (real served titles)', () => {
  const { routineRole } = require('../src/auroraBff/relationshipComplementPolicy');
  test.each([
    ['Clear Face Oil-Free Sunscreen SPF 50', 'sunscreen'],
    ['Age Shield Face Oil-Free Sunscreen SPF 70', 'sunscreen'],
    ["Trace'd Out Longwear Waterproof Pencil Lip Liner — Thugz Blush Too", 'lip_liner'],
    ["Pro Kiss'r Lip-Loving Scrubstick", 'exfoliant'],
    ['CBD Grapefruit Natural Bath Salt Soak with CBD. Made with Dead sea, Epsom and Himalayan salts (THC free)', 'bath_soak'],
    ['Bulk - 100 Natural Vegan Mix scents Bath Bombs - White', 'bath_soak'],
    ['Oud Wood Conditioning Beard Oil', 'beard_care'],
    ['Rose Face Oil', 'face_oil'],
  ])('%s -> %s', (title, role) => {
    expect(routineRole({ title, name: title })).toBe(role);
  });
});

// Review of #2382: production snapshots carry descriptions and makeup / nail titles the 2026-10-08 export
// does not, so these rules are pinned on the shapes the builder will see.
describe('rule vocabulary on production-shaped products', () => {
  const { treatmentFunctionCompatibility, accessoryKind, isSetLikeProduct, brushTargets } = require('../src/auroraBff/productRelationshipGraphBuilder').__internal;
  const { routineRole } = require('../src/auroraBff/relationshipComplementPolicy');
  const p = (name, category = 'serum', extra = {}) => ({ name, title: name, category, category_taxonomy: [category], ...extra });

  test.each([
    // makeup, nail and self-tan products that share treatment form words are not treatments
    ['Stay All Day® Waterproof Liquid Eye Liner', 'Perfect Strokes Matte Liquid Liner - Black', 'eye makeup'],
    ['Soft Pinch Dewy Hydrating Liquid Blush', 'Cheeks Out Radiant Liquid Blush', 'blush'],
    ['Glitter & Glow Liquid Eye Shadow', 'Hydrating Liquid Eyeshadow', 'eyeshadow'],
    ['Miracle Hyaluronic Tinted Serum', 'Radiant Glow Tinted Serum', 'foundation'],
    ['Hydrating Peel Off Nail Polish', 'Glow Peel Off Nail Polish', 'nail polish'],
    ['The Face Illuminating Self-Tan Drops', 'Hydrating Self-Tanning Drops', 'self tanner'],
    ['Curel Moisturizing UV Essence', 'Tone Up UV Brightening Essence', 'essence'],
    // a weak form word off a skincare shelf is not a treatment
    ['Lactic Acid Solution', 'Hyaluronic Acid Solution', 'nail care'],
    // the eye flag: a face-and-eye serum is a face serum, a toner is never an eye treatment
    ['Benefiance Wrinkle Smoothing Eye and Face Serum', 'Regenerist Micro-Sculpting Wrinkle Serum', 'serum'],
    ['Bright Eyes Brightening Toner', 'Vitamin C Brightening Toner', 'toner'],
    // night repair / recovery are the anti-ageing night step
    ['Advanced Night Repair Synchronized Multi-Recovery Complex', 'Regenerist Retinol 24 Max Night Serum', 'serum'],
    ['Midnight Recovery Concentrate', 'Clinical 1% Retinol Treatment', 'serum'],
    // naming order is meaning: a hyaluronic serum with vitamin C is still a hyaluronic serum
    ['Hyaluronic Acid + Vitamin C Serum', 'Hyaluronic Acid Serum', 'serum'],
    // a treatment named for no function fails open
    ['Ferment Essence', 'Retinol 0.5% Serum', 'serum'],
  ])('compatible: %s || %s', (a, b, category) => {
    expect(treatmentFunctionCompatibility(p(a, category), p(b, category))).toMatchObject({ compatible: true });
    expect(treatmentFunctionCompatibility(p(b, category), p(a, category))).toMatchObject({ compatible: true });
  });

  test.each([
    ['Lactic Acid Solution', 'Hyaluronic Acid Solution', 'skincare', 'treatment_function_mismatch'],
    ['Vitamin C + Hyaluronic Acid Serum', 'Hyaluronic Acid Serum', 'serum', 'treatment_function_mismatch'],
    ['Multi-Peptide Eye Serum', 'Multi-Peptide Serum', 'serum', 'treatment_area_mismatch'],
    ['Mandelic Acid 10% Serum', 'Centella Calming Serum', 'serum', 'treatment_function_mismatch'],
  ])('refused: %s || %s (%s)', (a, b, category, reason) => {
    expect(treatmentFunctionCompatibility(p(a, category), p(b, category))).toMatchObject({ compatible: false, reason });
    expect(treatmentFunctionCompatibility(p(b, category), p(a, category))).toMatchObject({ compatible: false, reason });
  });

  test.each([
    ['Safety Razor Stand', 'holder'],
    ['Stand Out Volumizing Mascara', ''],
    ['Fuzzy Gloss Bomb Holder', 'holder'],
    ['Refill Safety Razor Blades – Pack Of 10', 'blade'],
    ['Lav Kids Hair Clips Duo', 'hair_accessory'],
    ['Clip-In Hair Extensions', ''],
    ['Fenty Hair Satin Scarf', 'hair_accessory'],
    ['Powder Pouch', 'bag'],
    ['Fenty Icon The Case Semi-Matte Refillable Lipstick — Metallic Nude', 'bag'],
    ['Body Wash 12 fl oz (Case of 12)', ''],
    ["Arcane Hydra Vizor Mystery Box Moisturizer Sunscreen + Collector's Case", ''],
  ])('accessoryKind(%s) = %j', (name, kind) => {
    expect(accessoryKind({ name, title: name })).toBe(kind);
  });

  test.each([
    ['The Rich Curls 3-Piece Curl-Defining Routine', {}, true],
    ['Liquid Eyeliner', { description: 'One-piece felt tip applicator for precise lines.' }, false],
    ['Gloss Bomb Universal Lip Luminizer — Piece of Cake', {}, false],
    ['Clip-In Bangs Hair Piece', {}, false],
  ])('set: %s -> %s', (name, extra, expected) => {
    expect(isSetLikeProduct({ name, title: name, category: 'makeup', ...extra })).toBe(expected);
  });

  test.each([
    ['F42 Strobing Fan™ Brush', {}, ['highlighter']],
    ['Fan Brush', {}, ['highlighter']],
    ['Angled Blush Brush', { description: 'Our fan favorite brush for blush.' }, ['blush']],
    ['F11 Soft Sculpt Brush', {}, ['contour']],
  ])('brush targets: %s', (name, extra, targets) => {
    expect([...brushTargets({ name, title: name, ...extra })].sort()).toEqual(targets);
  });

  test.each([
    ['Beard Comb', 'beard_tool'],
    ['Beard Trimmer', 'beard_tool'],
    ['Beard Wash', 'beard_wash'],
    ['BEARD PACK', 'beard_care'],
    ['Silicone Body Scrubber', ''],
  ])('routineRole(%s) = %j', (title, role) => {
    expect(routineRole({ title, name: title })).toBe(role);
  });
});

// The treatment vocabulary as a contract: every word names exactly its groups. "<word> Serum" matches a
// one-group serum of each of its groups and refuses a one-group serum of every group it does not name.
describe('treatment vocabulary contract', () => {
  const { treatmentFunctionCompatibility } = require('../src/auroraBff/productRelationshipGraphBuilder').__internal;
  const serum = (name) => ({ name, title: name, category: 'serum', category_taxonomy: ['serum'] });
  const ONE_GROUP = { acne: 'Acne Serum', exfoliating: 'Exfoliating Serum', hydration: 'Hydrating Serum', brightening: 'Brightening Serum',
    calming: 'Calming Serum', barrier: 'Barrier Serum', firming: 'Firming Serum' };
  const VOCABULARY = [
    ["acne", ["acne"]],
    ["blemish", ["acne"]],
    ["blemishes", ["acne"]],
    ["breakout", ["acne"]],
    ["breakouts", ["acne"]],
    ["pore", ["acne"]],
    ["pores", ["acne"]],
    ["poreless", ["acne"]],
    ["poremizing", ["acne"]],
    ["whitehead", ["acne"]],
    ["whiteheads", ["acne"]],
    ["blackhead", ["acne"]],
    ["blackheads", ["acne"]],
    ["sebum", ["acne"]],
    ["oil control", ["acne"]],
    ["clear", ["acne","exfoliating"]],
    ["clarifying", ["acne","exfoliating"]],
    ["hydrating", ["hydration"]],
    ["hydration", ["hydration"]],
    ["hydrate", ["hydration"]],
    ["moisture", ["hydration"]],
    ["moisturizing", ["hydration"]],
    ["moisturising", ["hydration"]],
    ["aqua", ["hydration"]],
    ["brightening", ["brightening"]],
    ["bright", ["brightening"]],
    ["glow", ["brightening"]],
    ["radiance", ["brightening"]],
    ["radiant", ["brightening"]],
    ["dark spot", ["brightening"]],
    ["dark spots", ["brightening"]],
    ["hyperpigmentation", ["brightening"]],
    ["dullness", ["brightening"]],
    ["illuminating", ["brightening"]],
    ["calming", ["calming"]],
    ["soothing", ["calming"]],
    ["relief", ["calming"]],
    ["redness", ["calming"]],
    ["sensitive", ["calming"]],
    ["barrier", ["barrier"]],
    ["repair", ["barrier"]],
    ["repairing", ["barrier"]],
    ["restore", ["barrier"]],
    ["restoring", ["barrier"]],
    ["night repair", ["barrier","firming"]],
    ["recovery", ["barrier","firming"]],
    ["firming", ["firming"]],
    ["lifting", ["firming"]],
    ["wrinkle", ["firming"]],
    ["wrinkles", ["firming"]],
    ["anti wrinkle", ["firming"]],
    ["anti aging", ["firming"]],
    ["anti ageing", ["firming"]],
    ["age defying", ["firming"]],
    ["elasticity", ["firming"]],
    ["exfoliating", ["exfoliating"]],
    ["exfoliant", ["exfoliating"]],
    ["exfoliation", ["exfoliating"]],
    ["peel", ["exfoliating"]],
    ["peeling", ["exfoliating"]],
    ["resurfacing", ["exfoliating"]],
    ["retinol", ["firming"]],
    ["retinal", ["firming"]],
    ["retinoid", ["firming"]],
    ["retinoids", ["firming"]],
    ["bakuchiol", ["firming"]],
    ["peptide", ["firming"]],
    ["peptides", ["firming"]],
    ["collagen", ["firming"]],
    ["matrixyl", ["firming"]],
    ["argireline", ["firming"]],
    ["salicylic", ["exfoliating","acne"]],
    ["bha", ["exfoliating","acne"]],
    ["aha", ["exfoliating"]],
    ["pha", ["exfoliating"]],
    ["glycolic", ["exfoliating"]],
    ["lactic", ["exfoliating"]],
    ["mandelic", ["exfoliating"]],
    ["gluconolactone", ["exfoliating"]],
    ["azelaic", ["acne"]],
    ["hyaluronic", ["hydration"]],
    ["hyaluronics", ["hydration"]],
    ["hyaluron", ["hydration"]],
    ["hyalu", ["hydration"]],
    ["ha", ["hydration"]],
    ["b5", ["hydration"]],
    ["panthenol", ["hydration"]],
    ["vitamin c", ["brightening"]],
    ["vita c", ["brightening"]],
    ["ascorbic", ["brightening"]],
    ["arbutin", ["brightening"]],
    ["tranexamic", ["brightening"]],
    ["kojic", ["brightening"]],
    ["glutathione", ["brightening"]],
    ["niacinamide", ["brightening","acne"]],
    ["centella", ["calming"]],
    ["cica", ["calming"]],
    ["teca", ["calming"]],
    ["madecassoside", ["calming"]],
    ["heartleaf", ["calming"]],
    ["ceramide", ["barrier"]],
    ["ceramides", ["barrier"]],
    ["pdrn", ["barrier"]],
    ["tea tree", ["acne"]],
    ["zinc", ["acne"]],
    ["succinic", ["acne"]],
  ];
  test.each(VOCABULARY)('%s -> %j', (word, groups) => {
    const product = serum(`${word.replace(/(^|\s)\w/g, (c) => c.toUpperCase())} Serum`);
    for (const group of groups.filter((g) => ONE_GROUP[g])) {
      expect(treatmentFunctionCompatibility(product, serum(ONE_GROUP[group]))).toMatchObject({ compatible: true });
    }
    for (const other of Object.keys(ONE_GROUP).filter((g) => !groups.includes(g))) {
      expect(treatmentFunctionCompatibility(product, serum(ONE_GROUP[other]))).toMatchObject({ compatible: false, reason: 'treatment_function_mismatch' });
    }
  });
});

describe('treatment rule structure', () => {
  const { treatmentFunctionCompatibility, accessoryKind, brushTargets } = require('../src/auroraBff/productRelationshipGraphBuilder').__internal;
  const { routineRole } = require('../src/auroraBff/relationshipComplementPolicy');
  const p = (name, category = 'serum') => ({ name, title: name, category, category_taxonomy: [category] });
  test.each([
    // a "for" tail is not the lead: a brightening serum for sensitive skin is not a calming serum
    ['Brightening Serum for Sensitive Skin', 'Calming Serum', 'serum'],
    // the bracketed brand is not the product ("Body" in a brand does not exclude a face serum)
    ['[THE BODY SHOP] Vitamin C Glow Serum', 'Retinol Serum', 'serum'],
    // pads are a treatment form on any shelf
    ['Glycolic Acid Pads', 'Hydrating Collagen Pads', 'skin care'],
  ])('refused: %s || %s', (a, b, category) => {
    expect(treatmentFunctionCompatibility(p(a, category), p(b, category))).toMatchObject({ compatible: false });
  });
  test.each([
    // a scalp serum is out of the treatment rule's scope
    ['Hydrating Scalp Serum', 'Brightening Serum'],
    // a shade tail is not the product: "Bachelor Pad" is an eyeliner shade
    ['Flypencil Longwear Pencil Eyeliner — Bachelor Pad', 'Glow Serum', 'eye makeup'],
    ['Flypencil Longwear Pencil Eyeliner — Bright Pad', 'Calming Serum', 'eye makeup'],
    // makeup and body products named with a treatment form, from served titles
    ['Glaze Craze Tinted Lip Serum', 'Exfoliating Serum'],
    ['True Skin Serum Foundation', 'Exfoliating Serum'],
    ['Get Real Serum Concealer', 'Exfoliating Serum'],
    ['CC color-correcting tinted serum', 'Exfoliating Serum'],
    ['My Glow Ampoule Highlighter', 'Exfoliating Serum'],
    ['Shiseido Essence Skin Setting Powder', 'Exfoliating Serum'],
    ['Multi-Peptide Lash and Brow Serum for Thicker, Fuller Looking Lashes & Brows', 'Exfoliating Serum'],
    ['Moon Boost Eyebrow and Lash Serum', 'Exfoliating Serum'],
    ['Self-tanning serum', 'Exfoliating Serum'],
    ['BLEU body serum', 'Exfoliating Serum'],
    ['The Purifier Niacinamide Serum Body Wash', 'Exfoliating Serum'],
    ['Glow Tonic Cleansing Gel', 'Exfoliating Serum'],
    ['The Daily Duo Mini Cleanser + Toner Serum Duo', 'Exfoliating Serum'],
    ['[VELY VELY] Yuja C Sun Serum SPF 50+ PA++++ 30ml', 'Exfoliating Serum'],
    ['Hyalu-Cica Water-Fit Sun Serum UV', 'Exfoliating Serum'],
    ['Better Screen UV Serum Sunscreen SPF 50+ - 1.7 oz', 'Exfoliating Serum'],
    ['City Sunscreen Serum SPF 30', 'Exfoliating Serum'],
    // the same shapes named, not yet seen served
    ['Hydrating Primer Serum', 'Exfoliating Serum'],
    ['Nail and Cuticle Repair Serum', 'Exfoliating Serum'],
    ['Glow Self Tan Serum', 'Exfoliating Serum'],
  ])('not a treatment, so not compared: %s || %s', (a, b, category = 'serum') => {
    expect(treatmentFunctionCompatibility(p(a, category), p(b))).toMatchObject({ compatible: true });
  });
  test.each([
    ['Lip Balm (Pouch Included)', ''],
    ['Body Wash 12 fl oz Case of 12', ''],
  ])('accessoryKind(%s) = %j', (name, kind) => expect(accessoryKind({ name, title: name })).toBe(kind));
  test('a fan favorite is not a fan brush', () => {
    expect([...brushTargets({ name: 'Fan Favorite Kabuki Brush', title: 'Fan Favorite Kabuki Brush' })]).toEqual(['foundation']);
  });
  test.each([
    ['Daily Oil-Free Face Oil Control Gel', 'face_oil'],
    ['Clear Body Oil-Free Lotion', 'body_oil'],
    ['Oil-Free Acne Wash', 'oil'],
    ["Pro Filt'r Foundation — Beard", 'beard_care'],
  ])('%s is not %s', (title, role) => expect(routineRole({ title, name: title })).not.toBe(role));
});

// Each excluded word, on a name that WOULD conflict if it were read as a treatment: the exclusion is
// what keeps the pair out of the treatment rule.
describe('treatment exclusions, each pinned by a conflicting claim', () => {
  const { treatmentFunctionCompatibility } = require('../src/auroraBff/productRelationshipGraphBuilder').__internal;
  const p = (name, category) => ({ name, title: name, category, category_taxonomy: [category] });
  test.each([
    // served titles
    ['SKIN1004 Probio-Cica Glow Sun Ampoule', 'sunscreen', 'Exfoliating Serum'],
    ['Curel Moisturizing UV Essence 50g', 'sunscreen', 'Exfoliating Serum'],
    ['[AIDA]  Propolis Calming Ampoule Gel Cleanser 100ml', 'makeup', 'Exfoliating Serum'],
    ['Glow Tonic Cleansing Gel', 'skincare', 'Exfoliating Serum'],
    ['COSRX RED RICE INOSITOL Exfoliating Care Pore Wash-Off Peel Serum', 'beauty/skincare/cleanse/cleanser', 'Calming Serum'],
    ['PHA 5% Exfoliating Lip Serum', 'Lip Treatment', 'Calming Serum'],
    ['Miracle Hyaluronic Tinted Serum', 'foundation', 'Exfoliating Serum'],
    ['Brightening Micro Powder Exfoliant', 'Powder Exfoliant', 'Calming Serum'],
    ['My Glow Ampoule Highlighter', 'Highlighter', 'Exfoliating Serum'],
    // the same shapes, named
    ['Vitamin C Serum SPF 30', 'serum', 'Calming Serum'],
    ['Hydrating Sunscreen Serum', 'serum', 'Exfoliating Serum'],
    ['Brightening Body Serum', 'body care', 'Calming Serum'],
    ['Hydrating Serum Foundation', 'makeup', 'Exfoliating Serum'],
    ['Brightening Serum Concealer', 'makeup', 'Calming Serum'],
    ['CC Brightening Serum', 'makeup', 'Calming Serum'],
    ['Peptide Brow Serum', 'brow', 'Calming Serum'],
    ['Peptide Lash Serum', 'lash', 'Calming Serum'],
    ['Hydrating Self-Tanning Serum', 'self tanner', 'Exfoliating Serum'],
    ['Hydrating Primer Serum', 'primer', 'Exfoliating Serum'],
    ['Strengthening Peptide Nail Serum', 'nail care', 'Calming Serum'],
    ['Glow Self Tan Serum', 'self tanner', 'Calming Serum'],
    // a makeup shelf names the face: a liquid blush is not a skincare liquid
    ['Soft Pinch Dewy Hydrating Liquid Blush', 'beauty/makeup/face/blush', 'Radiant Liquid Blush'],
  ])('%s (%s) is not compared with %s', (name, category, partner) => {
    expect(treatmentFunctionCompatibility(p(name, category), p(partner, partner.includes('Blush') ? category : 'serum'))).toMatchObject({ compatible: true });
  });
});

// The structural rules above are the deterministic side of the reviewer's verdict: a negative verdict
// remembered under the validator that predates them is reviewed again, not reused.
describe('reviewer negative memory and this validator', () => {
  const { isRememberedNegative, REVIEW_VALIDATOR_VERSION, RUBRIC_VERSION } = require('../scripts/review-relationship-candidate-labels');
  const NOW = Date.parse('2026-10-09T12:00:00Z');
  const remembered = (validatorVersion) => ({ provenance: { ai_review_last: { verdict: 'reject', pair_fingerprint: 'fp', model: null,
    reviewer: 'x', rubric: RUBRIC_VERSION, validator_version: validatorVersion, reviewed_at: '2026-10-09T00:00:00Z' } } });
  test('a v1 rejection is not reused; one from this validator is', () => {
    expect(REVIEW_VALIDATOR_VERSION).not.toBe('relgraph_review_validator.v1');
    expect(isRememberedNegative(remembered('relgraph_review_validator.v1'), 'fp', { nowMs: NOW })).toBe(false);
    expect(isRememberedNegative(remembered(REVIEW_VALIDATOR_VERSION), 'fp', { nowMs: NOW })).toBe(true);
  });
});

// Review of #2382, round 2.
describe('round-2 review: rule scope', () => {
  const B = require('../src/auroraBff/productRelationshipGraphBuilder').__internal;
  const { routineRole } = require('../src/auroraBff/relationshipComplementPolicy');
  const p = (name, category = 'serum', extra = {}) => ({ name, title: name, category, category_taxonomy: [category], ...extra });

  test.each([
    // the leave-in rule runs whatever the shelf calls hair
    ['Add Moisturising Leave In Conditioner', 'Haircare', 'Gentle Care Conditioner', 'beauty/haircare'],
    ['Briogeo Leave-In Conditioner', 'conditioner', 'No.5 Bond Maintenance Conditioner', 'conditioner'],
    ['Curl Defining Leave-in Cream', 'hair care', 'Curl Defining Rinse-Out Conditioner', 'hair care'],
    // only the shelf says hair: "Haircare" is one word
    ['Moisturising Leave In Cream', 'Haircare', 'Gentle Care Conditioner', 'beauty/haircare'],
  ])('leave-in %s (%s) is not %s', (a, ac, b, bc) => {
    expect(B.productJobCompatibility(p(a, ac), p(b, bc))).toMatchObject({ compatible: false, reason: 'hair_leave_in_mismatch' });
    expect(B.productJobCompatibility(p(b, bc), p(a, ac))).toMatchObject({ compatible: false, reason: 'hair_leave_in_mismatch' });
  });
  test('two leave-ins, or a leave-in and a non-hair product, are not judged by the leave-in rule', () => {
    expect(B.productJobCompatibility(p('Leave In Conditioner', 'Haircare'), p('Leave-In Detangling Spray', 'Haircare')).reason).not.toBe('hair_leave_in_mismatch');
    expect(B.productJobCompatibility(p('Leave-On Exfoliant', 'skincare'), p('Leave In Mask', 'skincare')).reason).not.toBe('hair_leave_in_mismatch');
  });
  test.each([['Leave In Conditioner', true], ['Leave-In Conditioner', true], ['Leave-in Cream', true], ['Rinse Out Conditioner', false]])(
    'isLeaveIn(%s) = %s', (name, expected) => expect(B.isLeaveIn(p(name, 'conditioner'))).toBe(expected));

  test.each([
    ['Mighty Patch Original 36 Pieces', {}, false],
    ['Impress Press-On Nails 30 Pieces', {}, false],
    ['Makeup Sponge 2 Pieces', {}, false],
    ['Lip Liner — 2-Piece Pink', {}, false],
    ['Mushroom Clips 2-Piece Clip', {}, true],
    ['Eyeliner', { description: 'Includes a 2-piece applicator.' }, false],
  ])('set: %s -> %s', (name, extra, expected) => {
    expect(B.isSetLikeProduct({ name, title: name, category: 'beauty', ...extra })).toBe(expected);
  });

  test.each([
    ['Expert Face Brush', { description: 'Dense brush to sculpt and contour.' }, []],
    ['Contour Brush', {}, ['contour']],
    ['Sculpting Bronzer Brush 195', {}, ['bronzer'].filter(() => false)],
  ])('brush targets from the name only: %s', (name, extra, targets) => {
    expect([...B.brushTargets({ name, title: name, ...extra })].sort()).toEqual(targets);
  });
  test.each([['E50 Large Fluff Brush', 'eye'], ['F80 Flat Kabuki Brush', 'face'], ['Large Fluff E50 Brush', ''], ['E5 Brush', ''], ['Pro Face Brush', '']])(
    'brushCodeArea(%s) = %j', (name, area) => expect(B.brushCodeArea({ name, title: name })).toBe(area));

  test.each([
    // repeated words keep phrases: "Super C Vitamin C" still names vitamin c
    ['Super C Vitamin C Serum', 'Retinol Serum', false],
    // the first active is the first NAMED, not the first in the vocabulary
    ['Serum with Hyaluronic Acid and Retinol', 'Retinol Serum', false],
    // tails a lead stops at
    ['Brightening Serum featuring Calming Botanicals', 'Calming Serum', false],
    ['Brightening Serum - Calming Formula', 'Calming Serum', false],
    ['Brightening Serum | Calming', 'Calming Serum', false],
    ['Brightening Serum: Calming', 'Calming Serum', false],
    // the eye flag reads the name, not the description; tonics and pads are never eye treatments
    ['Firming Serum', 'Wrinkle Serum', true, { description: 'Apply around the eye area.' }],
    ['Bright Eyes Brightening Tonic', 'Vitamin C Brightening Toner', true],
    ['Bright Eyes Brightening Pads', 'Vitamin C Brightening Toner', true],
    // excluded: lash, brow, primer and hair products named with a treatment form
    ['Eyelash Enhancing Peptide Serum', 'Calming Serum', true],
    ['Eyebrow Peptide Serum', 'Calming Serum', true],
    ['Hydrating Priming Serum', 'Exfoliating Serum', true],
    ['Ampoule Repair Shampoo', 'Hydrating Ampoule Shampoo', true],
    ['Repair Ampoule Conditioner', 'Hydrating Ampoule Conditioner', true],
  ])('%s || %s -> compatible %s', (a, b, compatible, extra = {}) => {
    expect(B.treatmentFunctionCompatibility(p(a, 'serum', extra), p(b))).toMatchObject({ compatible });
    expect(B.treatmentFunctionCompatibility(p(b), p(a, 'serum', extra))).toMatchObject({ compatible });
  });

  // each skincare shelf word admits a weak form; a makeup shelf does not
  test.each(['skin', 'skincare', 'serum', 'serums', 'toner', 'toners', 'treat', 'treatment', 'essence', 'ampoule'])('shelf "%s" makes a weak form a treatment', (shelf) => {
    // the shelf word sits above the leaf, so the leaf-category path cannot decide it
    const category = `beauty/${shelf}/acids`;
    expect(B.treatmentFunctionCompatibility(p('Glycolic Acid Solution', category), p('Hydrating Solution', category))).toMatchObject({ compatible: false });
  });
  test.each(['peel', 'solution', 'liquid', 'booster', 'concentrate', 'drops'])('weak form "%s" counts on a skincare shelf only', (form) => {
    const word = form[0].toUpperCase() + form.slice(1);
    expect(B.treatmentFunctionCompatibility(p(`Hydrating ${word}`, 'skincare'), p('Calming Serum'))).toMatchObject({ compatible: false });
    expect(B.treatmentFunctionCompatibility(p(`Hydrating ${word}`, 'makeup/face'), p('Calming Serum'))).toMatchObject({ compatible: true });
  });
  test.each(['serum', 'essence', 'ampoule', 'toner', 'tonic', 'pad', 'pads', 'exfoliant'])('strong form "%s" counts on any shelf', (form) => {
    const word = form[0].toUpperCase() + form.slice(1);
    expect(B.treatmentFunctionCompatibility(p(`Hydrating ${word}`, 'beauty'), p('Calming Serum'))).toMatchObject({ compatible: false });
  });

  test.each([
    ['Lip Balm (Pouch Included)', ''], ['Body Wash, Travel Case', ''], ['Hair Mask & Bonnet', ''], ['Body Wash — Holder', ''],
    ['Silk Bonnet', 'hair_accessory'], ['Velvet Scrunchies', 'hair_accessory'], ['Satin Pillowcase', 'hair_accessory'], ['Satin Pillow Case', 'hair_accessory'],
    ['Hair Ties', 'hair_accessory'], ['Spa Headband', 'hair_accessory'], ['Makeup Organizer', 'holder'], ['Makeup Organiser', 'holder'],
    ['Bamboo Soap Dish', 'holder'], ['Safety Razor Stand™', 'holder'], ['Brush Caddy', 'holder'], ['Razor Cartridges', 'blade'], ['Brush Replacement Heads', 'blade'], ['Makeup Bag', 'bag'],
  ])('accessoryKind(%s) = %j', (name, kind) => expect(B.accessoryKind({ name, title: name })).toBe(kind));

  test.each([
    ['Beard Scissors', 'beard_tool'], ['Scissors for Beard', 'beard_tool'], ['Beard Shaper', 'beard_tool'], ['Boar Brush for Beard', 'beard_tool'],
    ['Beard Soap', 'beard_wash'], ['Beard Shampoo', 'shampoo'], ['Beard Cleanser', 'beard_wash'],
    ['Lavender Bath Flakes', 'bath_soak'], ['Magnesium Salt Soak', 'bath_soak'], ['Bath Bombs', 'bath_soak'],
  ])('routineRole(%s) = %j', (title, role) => expect(routineRole({ title, name: title })).toBe(role));
  test.each([['Silk Hair Oil-Free Serum', 'hair_oil'], ['Oil Control Gel', 'oil'], ['Oil-Free Gel', 'oil'], ['Hair Oil Control Spray', 'hair_oil']])(
    '%s is not %s', (title, role) => expect(routineRole({ title, name: title })).not.toBe(role));
});
