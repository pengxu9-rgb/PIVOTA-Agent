jest.mock('../../src/db', () => ({
  query: jest.fn(async () => { throw new Error('unexpected database access'); }),
  closePool: jest.fn(), withClient: jest.fn(),
}));
jest.mock('../../src/auroraBff/productRelationshipGraphSources', () => {
  const actual = jest.requireActual('../../src/auroraBff/productRelationshipGraphSources');
  return { ...actual, loadProductRelationshipGraphSourceInputs: jest.fn(),
    enrichProductRelationshipGraphProducts: jest.fn(async ({ products }) => ({
      products: actual.enrichProductsWithEvidence(products), ingredientRows: [], intelRows: [], diagnostics: {},
    })) };
});

const sources = require('../../src/auroraBff/productRelationshipGraphSources');
const { buildInputsFromDb } = require('../../scripts/build-product-relationship-graph');
const { buildEdgeForCandidate } = require('../../src/auroraBff/productRelationshipGraphBuilder');
const { buildEvidence } = require('../../scripts/review-relationship-candidate-labels');
const { withoutRelationshipPairContext } = require('../../src/auroraBff/relationshipCandidatePairContext');
const NOW = '2026-10-02T00:00:00.000Z';
function listing(key, brand, price = 50) {
  return { product_ref: `product:sig_${key}`, product_id: `source_${key}`, source_product_id: `source_${key}`,
    pivota_signature_id: `sig_${key}`, product_key: `cp_${key}`, merchant_id: 'real_seller', platform: 'shopify',
    name: 'Daily Barrier Face Serum', brand, category: 'serum', category_taxonomy: ['skincare','serum'],
    description: 'Hydrating facial serum supports the skin barrier with a lightweight gel texture.',
    price, price_currency: 'USD', observed_at: NOW, evidence_grade: 'B', _source_type: 'products_cache',
    source_refs: [{ type: 'products_cache', authoritative: true, url: `https://synthetic.example/${key}` }] };
}
const a = listing('a', 'Aster'); const b = listing('b', 'Birch'); const target = listing('target', 'Cedar', 20);
const legacy = [{ kb_key: a.product_ref, original: a, verified: true, verified_at: NOW,
  dupes: [{ ...target, evidence_grade: 'A', source_refs: [{ type:'aurora_dupe_kb', authoritative:true }] }], comparables:[] }];
const candidateFor = (map, anchor) => map[anchor.product_ref].find(row => row.product_key === target.product_key);
beforeEach(() => jest.clearAllMocks());

test.each(['source_refs', 'sourceRefs', '_source_type', 'source_type', 'sourceType', 'source'])(
  'removing pair authority in %s also removes its borrowed grade', (field) => {
    const input = { evidence_grade:'A', evidenceGrade:'A', [field]:field.toLowerCase().includes('refs')
      ? [{type:'aurora_dupe_kb', authoritative:true}] : 'aurora_dupe_kb' };
    const result = withoutRelationshipPairContext(input);
    expect(result).not.toHaveProperty('evidence_grade');
    expect(result).not.toHaveProperty('evidenceGrade');
  });

test.each([false,true])('actual two-anchor rescore keeps verified pair proof and grade local (reversed %s)', async (reversed) => {
  const anchors = reversed ? [b,a] : [a,b];
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({ products: [...anchors,target], legacyDupes: legacy, intelRows:[] });
  const initial = sources.buildCandidatesByAnchorFromSources({ anchors, products:[target], legacyDupes:legacy, includeTransitiveRecall:false });
  const ownB = candidateFor(initial,b);
  expect(ownB.evidence_grade).toBe('B');
  expect(ownB.source_refs.some(ref => ref.type === 'aurora_dupe_kb')).toBe(false);
  const payload = await buildInputsFromDb({ limit:2, includeNeedNodes:false, includeTransitiveRecall:false });
  const resultA = candidateFor(payload.candidatesByAnchor,a); const resultB = candidateFor(payload.candidatesByAnchor,b);
  expect(resultA.curated_pair_evidence).toMatchObject({ anchor_ref:a.product_ref, candidate_ref:target.product_ref, verified:true });
  expect(resultA.source_refs.some(ref => ref.type === 'aurora_dupe_kb')).toBe(true);
  expect(resultB).not.toHaveProperty('curated_pair_evidence');
  expect(resultB.source_refs.some(ref => ref.type === 'aurora_dupe_kb')).toBe(false);
  expect(resultB.evidence_grade).toBe(ownB.evidence_grade);
  expect(resultB.evidence_quality).toBe(ownB.evidence_quality);
  expect(resultB.similarity_score).toBe(ownB.similarity_score);
  // Inspect the actual pending edge before review/human/dupe serving gates. Those
  // later guards must not conceal borrowed pair facts in candidate evidence.
  const edgeA = buildEdgeForCandidate({ anchor:a, candidate:resultA, nowIso:NOW });
  const edgeB = buildEdgeForCandidate({ anchor:b, candidate:resultB, nowIso:NOW });
  expect(edgeA.errors).toEqual([]); expect(edgeB.errors).toEqual([]);
  expect(edgeA.edge.provenance.curated_pair_evidence).toMatchObject({ anchor_ref:a.product_ref });
  expect(edgeB.edge.provenance).not.toHaveProperty('curated_pair_evidence');
  expect(edgeB.edge.evidence_grade).toBe('B');
  expect(edgeB.edge.score_breakdown.evidence_quality).toBe(ownB.evidence_quality);
  expect(edgeB.edge.source_refs.some(ref => ref.type === 'aurora_dupe_kb')).toBe(false);
  const request = sources.enrichProductRelationshipGraphProducts.mock.calls[0][0].products;
  expect(request.every(row => !row.curated_pair_evidence && !row._legacy_match && !row.legacy_dupe_kb_key)).toBe(true);
});

test('exact INCI and Insights hydrate both pair records while original price clocks and routes stay local', async () => {
  const formula = 'Water, Glycerin, Squalane, Ceramide NP';
  const ingredients = [a,b,target].map(row => ({ table:'public.beauty_sku_ingredients', product_key:row.product_key,
    sku_key:row.product_id, raw_inci:formula, updated_at:NOW }));
  const intel = [{ kb_key:target.product_ref, last_success_at:NOW, analysis:{ product_intel_v1:{
    canonical_product_ref:{ product_key:target.product_key, pivota_signature_id:target.pivota_signature_id },
    evidence_profile:'seller_only', confidence:{tier:'limited'},
    freshness:{generated_at:NOW}, product_intel_core:{ what_it_is:{ body:'Light facial barrier serum.' } },
  } } }];
  sources.enrichProductRelationshipGraphProducts.mockImplementationOnce(async ({ products }) => ({
    products:sources.enrichProductsWithEvidence(products,{ ingredientRows:ingredients, intelRows:intel }),
    ingredientRows:ingredients, intelRows:intel, diagnostics:{},
  }));
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({ products:[a,b,target], legacyDupes:legacy, intelRows:[] });
  const payload = await buildInputsFromDb({ limit:2, includeNeedNodes:false, includeTransitiveRecall:false });
  for (const anchor of [a,b]) {
    const row = candidateFor(payload.candidatesByAnchor,anchor);
    expect(row.ingredient_text).toBe(formula);
    expect(row.product_intel).toMatchObject({ evidence_profile:'seller_only', confidence:{tier:'limited'} });
    expect(row.product_ref).toBe(target.product_ref);
    expect(row.price).toBe(target.price); expect(row.price_currency).toBe('USD');
    expect(row.price_observed_at).toBe(NOW);
  }
  expect(candidateFor(payload.candidatesByAnchor,b).curated_pair_evidence).toBeUndefined();
  expect(candidateFor(payload.candidatesByAnchor,b).source_refs.some(ref => ref.type==='aurora_dupe_kb')).toBe(false);
});

test.each(['source_refs', 'sourceRefs'])('shared formula evidence cannot borrow nested pair citations in %s', async (field) => {
  const formula = 'Water, Glycerin, Squalane, Ceramide NP';
  const withFormula = { ...target, ingredient_text:formula };
  const ownCitation = { type:'products_cache', authoritative:true, url:'https://synthetic.example/target-formula' };
  const pairCitation = { type:'aurora_dupe_kb', authoritative:true, name:'A-only reviewed pair' };
  const formulaLegacy = [{ ...legacy[0], dupes:[{ ...withFormula, evidence_grade:'A',
    source_refs:[pairCitation], ingredient_evidence:[{ table:'product_snapshot', product_key:target.product_key,
      ingredient_text:formula, observed_at:NOW, [field]:[ownCitation,pairCitation] }] }] }];
  const ingredients = [{ table:'public.beauty_sku_ingredients', product_key:target.product_key,
    sku_key:target.product_id, raw_inci:formula, updated_at:NOW }];
  sources.enrichProductRelationshipGraphProducts.mockImplementationOnce(async ({ products }) => ({
    products:sources.enrichProductsWithEvidence(products,{ ingredientRows:ingredients }),
    ingredientRows:ingredients, intelRows:[], diagnostics:{},
  }));
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({ products:[a,b,withFormula], legacyDupes:formulaLegacy, intelRows:[] });
  const payload = await buildInputsFromDb({ limit:2, includeNeedNodes:false, includeTransitiveRecall:false });
  const resultA = candidateFor(payload.candidatesByAnchor,a);
  const resultB = candidateFor(payload.candidatesByAnchor,b);
  expect(resultA.curated_pair_evidence).toMatchObject({ anchor_ref:a.product_ref, verified:true });
  expect(resultB).not.toHaveProperty('curated_pair_evidence');
  expect(resultB.ingredient_text).toBe(formula);
  const nestedRefs = resultB.ingredient_evidence.flatMap(row => [...(row.source_refs || []), ...(row.sourceRefs || [])]);
  expect(nestedRefs.some(ref => ref.type==='aurora_dupe_kb')).toBe(false);
  expect(nestedRefs).toContainEqual(ownCitation);
  expect(nestedRefs.some(ref => ref.type==='ingredient_kb')).toBe(true);
  const pending = buildEdgeForCandidate({ anchor:b, candidate:resultB, nowIso:NOW });
  expect(pending.errors).toEqual([]);
  const reviewerFacts = buildEvidence(pending.edge, new Map());
  expect(reviewerFacts.candidate.ingredient_evidence.flatMap(row => row.source_refs)
    .some(ref => ref.type==='aurora_dupe_kb')).toBe(false);
});

test('a new transitive pair cannot inherit its bridge pair proof, grade or source authority', () => {
  const bridge = { ...b, similarity_score:0.94, category_use_case_match:0.9,
    source_refs:[{type:'product_intel_kb',authoritative:true,url:'https://synthetic.example/bridge-only'}] };
  const secondHop = { ...target, similarity_score:0.92, category_use_case_match:0.9, evidence_grade:'A',
    _legacy_match:true, relation_hint:'dupe', legacy_dupe_kb_key:b.product_ref,
    curated_pair_evidence:{anchor_ref:b.product_ref,candidate_ref:target.product_ref,relation_type:'dupe',verified:true},
    source_refs:[...target.source_refs,{type:'aurora_dupe_kb',authoritative:true}],
    ingredient_evidence:[{table:'product_snapshot', ingredient_text:'Water, Glycerin',
      source_refs:[...target.source_refs,{type:'aurora_dupe_kb',authoritative:true}]}],
    transitive_bridge_ref:'product:previous', transitive_path_confidence:0.99 };
  const row = sources.__internal.buildTransitiveRecallCandidate({ anchor:a, bridge, candidate:secondHop });
  expect(row).not.toBeNull();
  for (const field of ['curated_pair_evidence','_legacy_match','legacy_dupe_kb_key','relation_hint']) expect(row).not.toHaveProperty(field);
  expect(row.evidence_grade).not.toBe('A');
  expect(row.source_refs.some(ref => ref.type==='aurora_dupe_kb' || ref.url==='https://synthetic.example/bridge-only')).toBe(false);
  expect(row.ingredient_evidence[0].source_refs).toEqual(target.source_refs);
  expect(row.source_refs).toContainEqual(expect.objectContaining({type:'relationship_graph_transitive_recall',authoritative:false}));
  expect(row.transitive_bridge_ref).toBe(b.product_ref);
  expect(row.transitive_path_confidence).toBeLessThan(0.99);
  const own = sources.__internal.scoreCandidateForAnchor(a,target);
  expect(row.similarity_score).toBeLessThanOrEqual(own.score_total);
  const edge = buildEdgeForCandidate({anchor:a,candidate:row,nowIso:NOW});
  expect(edge.errors).toEqual([]);
  expect(edge.edge.provenance).not.toHaveProperty('curated_pair_evidence');
  expect(edge.edge.evidence_grade).toBe('B');
});
