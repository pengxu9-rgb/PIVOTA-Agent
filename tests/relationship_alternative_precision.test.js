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
