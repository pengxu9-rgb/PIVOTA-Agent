jest.mock('../../src/db', () => ({ query: jest.fn(async () => { throw new Error('unexpected DB read'); }), closePool:jest.fn(), withClient:jest.fn() }));
jest.mock('../../src/auroraBff/productRelationshipGraphSources', () => {
  const actual = jest.requireActual('../../src/auroraBff/productRelationshipGraphSources');
  return { ...actual, loadProductRelationshipGraphSourceInputs:jest.fn(),
    buildCandidatesByAnchorFromSources:jest.fn(actual.buildCandidatesByAnchorFromSources),
    enrichProductRelationshipGraphProducts:jest.fn() };
});
jest.mock('../../src/auroraBff/productRelationshipGraphTargetRecall', () => ({
  ...jest.requireActual('../../src/auroraBff/productRelationshipGraphTargetRecall'),
  loadProductRelationshipGraphTargetRecall:jest.fn(),
}));
const sources = require('../../src/auroraBff/productRelationshipGraphSources');
const actual = jest.requireActual('../../src/auroraBff/productRelationshipGraphSources');
const recall = require('../../src/auroraBff/productRelationshipGraphTargetRecall');
const { buildInputsFromDb } = require('../../scripts/build-product-relationship-graph');
const { buildEdgeForCandidate } = require('../../src/auroraBff/productRelationshipGraphBuilder');
const formula = 'Water, Glycerin, Squalane, Ceramide NP, Panthenol, Niacinamide, Sodium Hyaluronate';
function listing(key, brand, overrides = {}) {
  return { product_ref:`product:${key}`, product_key:key, product_id:key, merchant_id:'fixture_shop', platform:'shopify',
    name:'Daily Barrier Face Serum', brand, category:'serum',
    description:'Hydrating facial serum supports the skin barrier with a lightweight gel texture.',
    price:50, price_currency:'USD', observed_at:'2026-10-03T00:00:00Z', evidence_grade:'B',
    source_refs:[{type:'products_cache', authoritative:true, url:`https://synthetic.example/${key}`}], _source_type:'products_cache', ...overrides };
}
const anchor=listing('a','Aster');
const candidates=[listing('b','Birch',{price:20}), listing('c','Cedar',{price:21}),
  listing('d','Elm',{name:'Hydrating Barrier Face Serum',price:22}), listing('e','Fir',{price:23})];
const baseOptions={ limit:1, affectedRefs:['a'], includeNeedNodes:false, includeTransitiveRecall:false, maxPerAnchor:2 };
beforeEach(() => {
  jest.clearAllMocks();
  sources.buildCandidatesByAnchorFromSources.mockImplementation(actual.buildCandidatesByAnchorFromSources);
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({products:[anchor,...candidates],legacyDupes:[],intelRows:[]});
  recall.loadProductRelationshipGraphTargetRecall.mockResolvedValue({products:[],candidatesByAnchor:{},diagnostics:{}});
  sources.enrichProductRelationshipGraphProducts.mockImplementation(async ({products}) => ({
    products:products.map(row=>['a','d'].includes(row.product_key)?{...row,ingredient_text:formula}:row),
    ingredientRows:[],intelRows:[],diagnostics:{},
  }));
});

test('formula-rich listing lost at the old cap is hydrated and wins unchanged final ranking', async () => {
  const baseline=await buildInputsFromDb(baseOptions);
  expect(baseline.candidatesByAnchor[anchor.product_ref].map(row=>row.product_key)).toEqual(['b','c']);
  expect(sources.enrichProductRelationshipGraphProducts.mock.calls[0][0].products.map(row=>row.product_key)).not.toContain('d');
  const expanded=await buildInputsFromDb({...baseOptions,expandTargetRecall:true});
  expect(sources.enrichProductRelationshipGraphProducts.mock.calls[1][0].products.map(row=>row.product_key)).toContain('d');
  expect(expanded.candidatesByAnchor[anchor.product_ref]).toHaveLength(2);
  expect(expanded.candidatesByAnchor[anchor.product_ref][0]).toMatchObject({product_key:'d',ingredient_text:formula});
  expect(expanded.sourceDiagnostics.builder_options).toMatchObject({max_per_anchor:2,prehydration_candidate_limit:6});
  const edge=buildEdgeForCandidate({anchor:expanded.anchors[0],candidate:expanded.candidatesByAnchor[anchor.product_ref][0],nowIso:'2026-10-03T00:00:00Z'});
  expect(edge.errors).toEqual([]);
  expect(edge.edge.relation_type).toBe('dupe');
  expect(edge.edge).not.toHaveProperty('ai_approved');
});

test('opt-out keeps the old admission cap and ignores a requested wider shortlist', async () => {
  const payload=await buildInputsFromDb({...baseOptions,candidateShortlistLimit:96});
  expect(sources.buildCandidatesByAnchorFromSources.mock.calls[0][0].maxPerAnchor).toBe(2);
  expect(payload.sourceDiagnostics.builder_options).not.toHaveProperty('prehydration_candidate_limit');
});

test.each([['conflict',{ingredient_evidence_conflict:true}],['incomplete',{ingredient_evidence_incomplete:true}]])(
  'expanded retrieval does not make %s formula evidence dupe proof', async (_name, flags) => {
    sources.enrichProductRelationshipGraphProducts.mockImplementation(async ({products})=>({
      products:products.map(row=>row.product_key==='a'?{...row,ingredient_text:formula}:
        row.product_key==='d'?{...row,...flags}:row), ingredientRows:[],intelRows:[],diagnostics:{},
    }));
    const payload=await buildInputsFromDb({...baseOptions,expandTargetRecall:true});
    for(const candidate of payload.candidatesByAnchor[anchor.product_ref]) {
      const result=buildEdgeForCandidate({anchor:payload.anchors[0],candidate,nowIso:'2026-10-03T00:00:00Z'});
      expect(result.edge?.relation_type).not.toBe('dupe');
    }
  });

test('a final admitted pool cannot reintroduce an unhydrated curated listing', () => {
  const unadmitted=listing('outside','Outside',{price:10});
  const legacy=[{kb_key:anchor.product_ref,original:anchor,verified:true,verified_at:'2026-10-03T00:00:00Z',dupes:[unadmitted],comparables:[]}];
  const initial=actual.buildCandidatesByAnchorFromSources({anchors:[anchor],legacyDupes:legacy,includeTransitiveRecall:false});
  expect(initial[anchor.product_ref].some(row=>row.product_key==='outside')).toBe(true);
  const final=actual.buildCandidatesByAnchorFromSources({anchors:[anchor],productsByAnchor:{[anchor.product_ref]:[candidates[0]]},
    legacyDupes:legacy,includeLegacyExplicitCandidates:false,includeTransitiveRecall:false});
  expect(final[anchor.product_ref].map(row=>row.product_key)).toEqual(['b']);
});

test('expanded total cap includes transitive additions while legacy callers retain append behavior', () => {
  const a={...anchor,ingredient_text:formula}, b={...candidates[0],ingredient_text:formula}, c={...candidates[1],ingredient_text:formula};
  const options={anchors:[a,b],productsByAnchor:{[a.product_ref]:[b],[b.product_ref]:[c]},maxPerAnchor:1};
  expect(actual.buildCandidatesByAnchorFromSources(options)[a.product_ref].map(row=>row.product_ref))
    .toEqual([b.product_ref,c.product_ref]);
  const bounded=actual.buildCandidatesByAnchorFromSources({...options,enforceTotalCandidateLimit:true});
  expect(bounded[a.product_ref]).toHaveLength(1);
  expect(bounded[a.product_ref][0].product_ref).toBe(b.product_ref);
});

test('prehydration shortlist is bounded, cannot narrow the final cap, and handles malformed limits', () => {
  expect(actual.normalizeCandidateHydrationShortlistLimit(2)).toBe(6);
  expect(actual.normalizeCandidateHydrationShortlistLimit(2,8)).toBe(8);
  expect(actual.normalizeCandidateHydrationShortlistLimit(24,2)).toBe(24);
  expect(actual.normalizeCandidateHydrationShortlistLimit(2,Infinity)).toBe(6);
  expect(actual.normalizeCandidateHydrationShortlistLimit(24,1000000)).toBe(100);
  expect(actual.normalizeCandidateHydrationShortlistLimit(100,6)).toBe(100);
});

test('exact evidence slots alternate anchors and retrieval lanes', () => {
  const a={product_ref:'a'}, b={product_ref:'b'};
  expect(actual.interleaveCandidateHydrationTargets([a,b],[{a:['a0','a1'],b:['b0','b1']},{a:['ta0'],b:['tb0']}]))
    .toEqual(['a0','b0','ta0','tb0','a1','b1']);
});

test('global hydration bound distributes slots and excludes omitted exact canonical members', async () => {
  const anchors=Array.from({length:80},(_,i)=>listing(`anchor${i}`,`Brand${i}`));
  const map=Object.fromEntries(anchors.map((row,i)=>[row.product_ref,Array.from({length:96},(_,j)=>
    listing(`candidate${i}_${j}`,`Target${j}`,{product_ref:j===95?`product:candidate${i}_0`:`product:candidate${i}_${j}`, similarity_score:0.9-j/1000}))]));
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({products:anchors,legacyDupes:[],intelRows:[]});
  sources.buildCandidatesByAnchorFromSources.mockImplementation(options=>options.productsByAnchor||map);
  sources.enrichProductRelationshipGraphProducts.mockImplementation(async ({products})=>({products:products.map(row=>({...row,ingredient_text:formula})),
    ingredientRows:[],intelRows:[],diagnostics:{}}));
  const payload=await buildInputsFromDb({limit:80,includeNeedNodes:false,includeTransitiveRecall:false,maxPerAnchor:32,expandTargetRecall:true});
  const request=sources.enrichProductRelationshipGraphProducts.mock.calls[0][0].products;
  expect(request).toHaveLength(5000);
  expect(request.slice(0,80).map(row=>row.product_key)).toEqual(anchors.map(row=>row.product_key));
  const membership=new Set(request.map(row=>row.product_key));
  const sizes=Object.values(payload.candidatesByAnchor).map(rows=>rows.length);
  expect(Math.max(...sizes)-Math.min(...sizes)).toBeLessThanOrEqual(1);
  expect(Math.min(...sizes)).toBe(61);
  for(const rows of Object.values(payload.candidatesByAnchor)) for(const row of rows) expect(membership.has(row.product_key)).toBe(true);
  expect(Object.values(payload.candidatesByAnchor).flat().some(row=>row.product_key.endsWith('_95'))).toBe(false);
  expect(payload.sourceDiagnostics.targeted_evidence).toMatchObject({hydration_product_count:5000,selection_complete:false});
});
