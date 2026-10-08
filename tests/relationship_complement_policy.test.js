// related_product means complement, for the builder that proposes it and the reviewer that judges it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const real = require('./fixtures/relgraph_served_2026_10_08_identity_relation.json');
const { classifyComplementPair, routineRole } = require('../src/auroraBff/relationshipComplementPolicy');
const { buildEdgeForCandidate, __internal: { inferRelationship } } = require('../src/auroraBff/productRelationshipGraphBuilder');
const { validateRecommendationDecision, runReview, consumerCopyForKind } = require('../scripts/review-relationship-candidate-labels');

const NOW = '2026-10-08T12:00:00.000Z';
const fromReal = (side) => ({ brand: side.brand, title: side.name, name: side.name, category: side.category, price: 30, price_currency: 'USD' });
const edge = (a, b, relation_type = 'related_product') => ({ id: 'rcl_fixture', anchor_type: 'product', anchor_ref: 'product:a', candidate_product_ref: 'product:b',
  anchor_snapshot: a, candidate_snapshot: b, relation_type, label_state: 'generated', score_total: 0.8,
  score_breakdown: { category_use_case_match: 0.8 }, source_refs: [{ type: 'catalog_products' }] });
const complementApproval = (a, b) => ({ verdict: 'approve', confidence: 0.95, rationale: 'The supplied titles name two routine steps used together.',
  relationship_kind: 'complement', ...consumerCopyForKind('complement'), shared_evidence: [{ anchor_fact: a.title, candidate_fact: b.title }] });

describe('builder relation on real served related_product rows (2026-10-08)', () => {
  test.each(real.relations.map((row) => [row.anchor.name, row.candidate.name, row.expected_relation, row]))('%s || %s -> %s', (_a, _b, expected, row) => {
    const a = fromReal(row.anchor); const b = fromReal(row.candidate);
    expect(row.served_as).toBe('related_product');
    expect(inferRelationship(a, b, { ...b, similarity_score: 0.8 }).relation_type).toBe(expected);
  });
});

describe('builder: same-brand distinct products', () => {
  const house = (title, category = 'skincare') => ({ product_id: title, brand: 'House', title, name: title, category, price: 30, price_currency: 'USD' });
  const signals = (b) => ({ ...b, similarity_score: 0.9, category_use_case_match: 0.9, source_refs: [{ type: 'catalog_products' }] });
  test('known, different routine roles -> related_product (complement)', () => {
    const built = buildEdgeForCandidate({ anchor: house('Calming Foam Cleanser'), candidate: signals(house('Calming Toner')), nowIso: NOW });
    expect(built.edge.relation_type).toBe('related_product');
    expect(built.metrics.routineRelation).toMatchObject({ kind: 'complement', anchor_role: 'cleanser', candidate_role: 'toner' });
  });
  test('the same shopper job -> competitive_alternative, even when structural substitution evidence is thin', () => {
    const inferred = inferRelationship(house('Himalaya Pinksalt Shampoo'), house('Cherry Blossom Moisture Shampoo'), { similarity_score: 0.7 });
    expect(inferred).toMatchObject({ relation_type: 'competitive_alternative', routineRelation: { kind: 'same_job' } });
  });
  test('unknown routine roles -> no relation is claimed', () => {
    const built = buildEdgeForCandidate({ anchor: house('Life Designer Journal', 'stationery'), candidate: signals(house('Pen Holder Clip', 'stationery')), nowIso: NOW });
    expect(built.edge).toBeNull();
    expect(built.metrics.utilityCompatibility).toEqual({ compatible: false, reason: 'related_product_without_complement_roles' });
  });
  test('cross-brand pairs never become related_product', () => {
    const a = house('Calming Foam Cleanser'); const b = { ...house('Calming Toner'), brand: 'Other' };
    expect(inferRelationship(a, b, signals(b)).relation_type).not.toBe('related_product');
  });
});

describe('shared complement policy', () => {
  test.each([
    ['Sun Cream SPF 50', 'sunscreen'], ['Missha M Perfect Cover BB Cream SPF 42', 'bb_cream'], ['Hand Wash', 'body_wash'],
    ['Rosemary Scalp Deep Cleansing Shampoo', 'shampoo'], ['Hand Cream', 'body_moisturizer'], ['Chrome Peel Off Nail Polish', 'nail_polish'],
    ['Glycolic Peeling Gel', 'exfoliant'], ['Acne Pimple Master Patch', 'patch'], ['Nutri-Define Cream Mask', 'mask'], ['Vita Niacinamide Dark Spot Serum Mask', 'mask'], ['Vita C Plus Spot Correcting Toner Pads', 'toner'], ['Lip Color Matte', 'lipstick'], ['Pen Holder Clip', ''],
  ])('routine role of %s is %s', (title, role) => expect(routineRole({ title })).toBe(role));
  test('kinds', () => {
    expect(classifyComplementPair({ title: 'Foam Cleanser' }, { title: 'Toner' }).kind).toBe('complement');
    expect(classifyComplementPair({ title: 'Foam Cleanser' }, { title: 'Gel Cleanser' })).toMatchObject({ kind: 'same_job', suggested_relation_type: 'competitive_alternative' });
    expect(classifyComplementPair({ title: 'Foam Cleanser' }, { title: 'Toner' }, { substitutable: true }).kind).toBe('same_job');
    expect(classifyComplementPair({ title: 'Journal' }, { title: 'Toner' })).toMatchObject({ kind: 'unresolved', reason: 'complement_role_evidence_unresolved' });
  });
});

describe('reviewer keeps related_product == complement and records a same-job finding without relabelling', () => {
  const organist = real.relations.find((row) => row.anchor.name.includes('Himalaya Pinksalt Shampoo'));
  const a = fromReal(organist.anchor); const b = fromReal(organist.candidate);
  test('a same-job related_product is rejected with suggested_relation_type', () => {
    const checked = validateRecommendationDecision(edge(a, b), complementApproval(a, b));
    expect(checked).toMatchObject({ verdict: 'reject', utility_rejection: 'same_step_substitutes_are_not_complements', suggested_relation_type: 'competitive_alternative' });
  });
  test('an unresolved-role rejection carries no suggestion', () => {
    const x = fromReal(real.relations.find((row) => row.anchor.name.startsWith('The Three Question Journal')).anchor);
    const y = fromReal(real.relations.find((row) => row.anchor.name.startsWith('The Three Question Journal')).candidate);
    const checked = validateRecommendationDecision(edge(x, y), complementApproval(x, y));
    expect(checked.utility_rejection).toBe('complement_role_evidence_unresolved');
    expect(checked).not.toHaveProperty('suggested_relation_type');
  });
  test('a real complement is still approved', () => {
    const vita = real.relations.find((row) => row.anchor.name.startsWith('Vita C Plus'));
    const x = fromReal(vita.anchor); const y = fromReal(vita.candidate);
    expect(validateRecommendationDecision(edge(x, y), complementApproval(x, y)).verdict).toBe('approve');
  });
  test('the persisted review output records the finding; the row is neither relabelled nor written', async () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-complement-'));
    const previousApply = process.env.RELGRAPH_AI_REVIEW_APPLY;
    process.env.RELGRAPH_AI_REVIEW_APPLY = '1';
    try {
      const out = path.join(dir, 'review.json');
      const queryFn = jest.fn(async (sql) => ({ rows: /FROM relationship_candidate_labels/.test(sql) && /SELECT/.test(sql) ? [edge(a, b)] : [] }));
      const provider = { analyzeTextToJson: jest.fn(async () => complementApproval(a, b)) };
      const result = await runReview({ cutoff: NOW, minScore: 0, limit: 1, queryFn, provider, out, apply: true });
      const persisted = JSON.parse(fs.readFileSync(out, 'utf8'));
      expect(persisted.decisions[0]).toMatchObject({ relation_type: 'related_product', verdict: 'reject',
        utility_rejection: 'same_step_substitutes_are_not_complements', suggested_relation_type: 'competitive_alternative',
        new_label_state: 'generated', applied: false });
      expect(result.summary.suggested_relation_type_counts).toEqual({ competitive_alternative: 1 });
      expect(queryFn.mock.calls.some(([sql]) => /UPDATE relationship_candidate_labels/.test(sql))).toBe(false);
    } finally {
      if (previousApply === undefined) delete process.env.RELGRAPH_AI_REVIEW_APPLY;
      else process.env.RELGRAPH_AI_REVIEW_APPLY = previousApply;
      fs.rmSync(dir, { recursive: true, force: true });
      jest.restoreAllMocks();
    }
  });
});
