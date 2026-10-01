const sample = require('./fixtures/relgraph_1001_recommendation_sample.json');
const { isSameFamilyVariant, optionRole } = require('../src/auroraBff/relationshipPairPolicy');
const { getRelationshipEdgeServingSuppressionReasons, relationshipEdgeToSimilarItem } = require('../src/auroraBff/productRelationshipGraph');
const { buildEdgeForCandidate, __internal: { inferRelationship } } = require('../src/auroraBff/productRelationshipGraphBuilder');
const { buildCandidatesByAnchorFromSources, __internal: { selectCandidateOpportunities } } = require('../src/auroraBff/productRelationshipGraphSources');
const { validateRecommendationDecision, applyApproval, runReview, consumerCopyForKind } = require('../scripts/review-relationship-candidate-labels');
const { relationshipEdgeToSignal } = require('../src/agentSignals/relationshipEdgeToSignal');
const NOW = '2026-10-01T10:37:00.000Z';
const snapshot = (brand, title, category = 'face cream', other = {}) => ({ product_id: title, brand, title, name: title, category, price: 50, price_currency: 'USD', ...other });
const edge = (a, b, relation_type = 'related_product') => ({ id: 'fixture', anchor_type: 'product', anchor_ref: 'product:a', candidate_product_ref: 'product:b', anchor_snapshot: a, candidate_snapshot: b, relation_type, label_state: 'ai_approved', score_total: 0.9, score_breakdown: { category_use_case_match: 0.9 }, source_refs: [{ type: 'catalog_products' }] });
const decision = (a, b, relationship_kind = 'alternative') => ({ verdict: 'approve', confidence: 0.99, rationale: 'The supplied product titles identify the claimed shopper job and differences.', relationship_kind, ...consumerCopyForKind(relationship_kind), shared_evidence: [{ anchor_fact: a.title, candidate_fact: b.title }] });

describe('actual 10-01 supplied sample: variants versus retained opportunities', () => {
  test.each(sample)('sample $i has expected variant behavior ($expected_kind)', (row) => {
    const a = snapshot(row.anchor_brand, row.anchor_title); const b = snapshot(row.candidate_brand, row.candidate_title);
    const blocked = getRelationshipEdgeServingSuppressionReasons(edge(a, b));
    expect(isSameFamilyVariant(a, b)).toBe(row.expected_kind === 'variant');
    expect(blocked.includes('related_product_same_family_variant')).toBe(row.expected_kind === 'variant');
    expect(getRelationshipEdgeServingSuppressionReasons({ ...edge(a, b), label_state: 'human_approved' })).toEqual([]);
  });
  test('measured sample labels remain distinct from full-run estimated quality', () => {
    const counts = sample.reduce((out, row) => ({ ...out, [row.expected_kind]: (out[row.expected_kind] || 0) + 1 }), {});
    expect(counts).toEqual({ variant: 18, alternative: 7, complement: 4, unknown: 1 });
  });
});

test.each([
  ['Festival False Eyelashes, Light Volume - Midnight', 'Festival False Eyelashes, Decorated - Vamp', true],
  ['Cotton Contour #Salted Cocoa', 'Cotton Contour #Hazel', true],
  ['Perfect Cover BB Cream #23 Beige', 'Perfect Cover BB Cream #27 Honey', true],
  ['Dew Sleeping Lip Mask, Berry', 'Dew Sleeping Lip Mask, Vanilla', true],
  ['Classic French Press On Nails - Blush', 'Premium Design Press On Nails - Rose', false],
  ['Herbal Regimen, Emulsion', 'Herbal Regimen, Eye Cream', false],
  ['Calming Routine - Essence', 'Calming Routine - Ampoule', false],
  ['Retinol Treatment - 0.2%', 'Retinol Treatment - 0.5%', false],
  ['Face Sunscreen - SPF 30', 'Face Sunscreen - SPF 50', false],
  ['Moisture Cream - Intense', 'Moisture Cream - Light', false],
  ['Cotton Mix Blusher 11g', 'Cotton Blusher 4g', false],
  ['Daily Serum for Dry Skin', 'Daily Serum for Oily Skin', false],
])('semantic variant decision: %s versus %s', (a, b, expected) => {
  expect(isSameFamilyVariant(snapshot('House', a), snapshot('House', b))).toBe(expected);
});

test('same-brand distinct-line nails enter the alternative relation; variants never enter review', () => {
  const a = snapshot('House', 'Classic French No Glue Press On Nails - Blush', 'press-on-nails');
  const b = snapshot('House', 'Premium Design No Glue Press On Nails - Jewel', 'press-on-nails');
  const candidate = { ...b, similarity_score: 0.9, category_use_case_match: 0.9, source_refs: [{type: 'catalog_products'}] };
  expect(buildEdgeForCandidate({ anchor: a, candidate, nowIso: NOW }).edge.relation_type).toBe('competitive_alternative');
  const same = { ...candidate, title: 'Classic French No Glue Press On Nails - Rose', name: 'Classic French No Glue Press On Nails - Rose' };
  expect(buildEdgeForCandidate({ anchor: a, candidate: same, nowIso: NOW })).toMatchObject({ edge: null, metrics: { utilityCompatibility: {reason: 'same_family_variant'} } });
  expect(validateRecommendationDecision(edge(a, b, 'competitive_alternative'), decision(a, b)).verdict).toBe('approve');
});

test.each([['Herbal Emulsion', 'Herbal Face Cream'], ['Calming Essence', 'Calming Ampoule'], ['Herbal Face Cream', 'Herbal Eye Cream']])('different routine roles retain complement candidates: %s/%s', (aName, bName) => {
  const a = snapshot('House', aName); const b = snapshot('House', bName);
  const candidate = { ...b, category_use_case_match: 0.9, similarity_score: 0.9, source_refs: [{type: 'catalog_products'}] };
  expect(buildEdgeForCandidate({anchor: a, candidate, nowIso: NOW}).edge.relation_type).toBe('related_product');
  expect(validateRecommendationDecision(edge(a, b), decision(a, b, 'complement')).verdict).toBe('approve');
});

test('names, price and category alone infer an alternative, not a dupe', () => {
  const a = snapshot('Luxury', 'Barrier Peptide Face Cream'); const b = snapshot('Value', 'Barrier Peptide Face Cream', 'face cream', {price: 20});
  const signals = { category_use_case_match: 0.95, similarity_score: 0.99 };
  expect(inferRelationship(a, b, signals).relation_type).toBe('competitive_alternative');
  expect(validateRecommendationDecision(edge(a, b, 'dupe'), decision(a, b, 'dupe')).utility_rejection).toBe('structural_or_dupe_evidence_mismatch');
  const inci = 'Water, Glycerin, Squalane, Ceramide NP, Peptide, Phenoxyethanol';
  expect(inferRelationship({...a, ingredient_text: inci}, {...b, ingredient_text: inci}, signals).relation_type).toBe('dupe');
});

test('curated provenance proves only a verified current dupe pair, never another anchor or comparable', () => {
  const a = snapshot('Luxury', 'Barrier Peptide Face Cream'); const b = snapshot('Value', 'Barrier Peptide Face Cream', 'face cream', {price: 20});
  const signals = { category_use_case_match: 0.95, similarity_score: 0.99, source_refs: [{type: 'aurora_dupe_kb', authoritative: true}] };
  expect(inferRelationship(a,b,signals).relation_type).toBe('competitive_alternative');
  const pair = {anchor_ref: `product:${a.product_id}`, candidate_ref: `product:${b.product_id}`, relation_type:'dupe', verified:true};
  expect(inferRelationship(a,b,{...signals,curated_pair_evidence:pair}).relation_type).toBe('dupe');
  expect(inferRelationship(a,b,{...signals,curated_pair_evidence:{...pair,anchor_ref:'product:unrelated'}}).relation_type).toBe('competitive_alternative');
  expect(inferRelationship(a,b,{...signals,curated_pair_evidence:{...pair,relation_type:'competitive_alternative'}}).relation_type).toBe('competitive_alternative');
});

test('legacy source loader marks pair evidence only for verified dupe entries', () => {
  const a = {...snapshot('Luxury','Barrier Peptide Face Cream'),product_id:'anchor'};
  const b = {...snapshot('Value','Barrier Peptide Face Cream','face cream',{price:20}),product_id:'candidate'};
  const run = (dupes, comparables, original = a) => buildCandidatesByAnchorFromSources({anchors:[a],legacyDupes:[{original,dupes,comparables,verified:true}],includeTransitiveRecall:false});
  const candidate = run([b],[])['product:anchor'][0];
  expect(candidate.curated_pair_evidence).toMatchObject({anchor_ref:'product:anchor',candidate_ref:'product:candidate',relation_type:'dupe',verified:true});
  expect(run([],[b])['product:anchor'][0].curated_pair_evidence).toBeUndefined();
  expect(run([b],[],{...a,product_id:'unrelated',name:'Another Name',title:'Another Name'})['product:anchor']).toEqual([]);
});

test('retrieval reserves evidenced cross-brand opportunities and brand variety within the cap', () => {
  const a = snapshot('House','Hydrating Barrier Face Cream');
  const house = Array.from({length:20},(_,i)=>({...snapshot('House',`Collection ${i} Hydrating Face Cream`), product_ref:`product:h${i}`,similarity_score:0.99,category_use_case_match:0.9}));
  const cross = ['A','A','B','C'].map((brand,i)=>({...snapshot(brand,`Hydrating Barrier Face Cream ${i}`),product_ref:`product:x${i}`,similarity_score:0.85,category_use_case_match:0.9}));
  const selected = selectCandidateOpportunities(a,[...house,...cross],6);
  expect(selected).toHaveLength(6);
  expect(new Set(selected.filter((row)=>row.brand!=='House').map((row)=>row.brand))).toEqual(new Set(['A','B','C']));
  const weak = {...snapshot('Other','Unrelated Tool'),similarity_score:0.80,category_use_case_match:0.72};
  expect(selectCandidateOpportunities(a,[...house,weak],6).filter(row=>row.brand!=='House')).toHaveLength(0);
});

test('high confidence cannot approve invented facts or same-step complement claims', async () => {
  const a = snapshot('House','Hydrating Barrier Face Cream'); const b = snapshot('House','Rich Recovery Face Cream');
  const row = edge(a,b,'competitive_alternative');
  const unsupported = {...decision(a,b),shared_evidence:[{anchor_fact:'clinically proven 48 hour hydration',candidate_fact:b.title}]};
  expect(validateRecommendationDecision(row,unsupported).utility_rejection).toBe('recommendation_facts_not_supplied');
  expect(validateRecommendationDecision(edge(a,b),decision(a,b,'complement')).utility_rejection).toBe('same_step_substitutes_are_not_complements');
  const queryFn = jest.fn();
  await expect(applyApproval(row,unsupported,queryFn)).rejects.toMatchObject({code:'RECOMMENDATION_UTILITY_AI_APPROVAL_BLOCKED'});
  expect(queryFn).not.toHaveBeenCalled();
});

test('role/category mismatch rejects otherwise well-formed grounded alternative approval', () => {
  const a=snapshot('A','Hydrating Face Cream','face cream'); const b=snapshot('B','Scalp Treatment Shampoo','shampoo');
  expect(validateRecommendationDecision(edge(a,b,'competitive_alternative'),decision(a,b)).utility_rejection).toBe('structural_or_dupe_evidence_mismatch');
});

test('actionable reviewed rationale and constraints reach both consumer shapes', () => {
  const a=snapshot('A','Hydrating Face Cream');const b=snapshot('B','Rich Recovery Face Cream');
  const row={...edge(a,b,'competitive_alternative'),why_candidate:{relationship_kind:'alternative',summary:'Consider this distinct moisturizer line for the same facial step.',shared_evidence:[{anchor_fact:a.title,candidate_fact:b.title}]},tradeoffs:['Different product line; performance equivalence is unknown.'],watchouts:['Check formula and shade before choosing.']};
  const item=relationshipEdgeToSimilarItem(row); const signal=relationshipEdgeToSignal(row);
  expect(item.reason).toBe(row.why_candidate.summary);expect(item.tradeoffs).toEqual(row.tradeoffs);expect(item.watchouts).toEqual(row.watchouts);expect(item.evidence_refs).toEqual(row.source_refs);
  expect(signal.value.why).toEqual(row.why_candidate);expect(signal.value.relationship_kind).toBe('alternative');expect(signal.value.related.title).toBe(b.title);
});

// Replay exercises pre-approval policy and useful quality counters, not a live model.
test('v4 offline review reports utility rejection separately from model/schema errors', async () => {
  jest.spyOn(process.stdout,'write').mockImplementation(()=>true);
  const a=snapshot('House','Hydrating Face Cream'); const b=snapshot('House','Rich Recovery Face Cream');
  const row={...edge(a,b),label_state:'generated'};
  const provider={analyzeTextToJson:jest.fn(async()=>decision(a,b,'complement'))};
  const queryFn=jest.fn(async(sql)=>({rows:/FROM relationship_candidate_labels/.test(sql)?[row]:[]}));
  try {
    const result=await runReview({cutoff:NOW,minScore:0,limit:1,queryFn,provider});
    expect(result.summary).toMatchObject({approved_count:0,rejected_count:1,semantic_rejected_count:1,review_error_count:0,review_error_denominator:1});
  } finally {jest.restoreAllMocks();}
});

test('incompatible cross-brand pairs cannot consume reserved substitute opportunities', () => {
  const a = snapshot('House','Hydrating Barrier Face Cream');
  const invalid = ['B','C','D'].map(brand=>({...snapshot(brand,'Hydrating Barrier Body Cream','body cream'),similarity_score:0.99,category_use_case_match:0.95}));
  const good = {...snapshot('Value','Hydrating Barrier Face Cream'),similarity_score:0.84,category_use_case_match:0.9};
  const house = {...snapshot('House','Premium Hydrating Barrier Face Cream'),similarity_score:0.95,category_use_case_match:0.9};
  expect(selectCandidateOpportunities(a,[...invalid,house,good],2)).toContain(good);
});

test('verified curated dupe pair survives sources, edge, approval recheck and human-only serving gate', async () => {
  const a = {...snapshot('Luxury','Barrier Peptide Face Cream'),product_id:'anchor'};
  const b = {...snapshot('Value','Barrier Peptide Face Cream','face cream',{price:20}),product_id:'candidate'};
  const pool = buildCandidatesByAnchorFromSources({anchors:[a],legacyDupes:[{original:a,dupes:[b],comparables:[],verified:true}],includeTransitiveRecall:false});
  const built = buildEdgeForCandidate({anchor:a,candidate:pool['product:anchor'][0],nowIso:NOW});
  expect(built.errors).toEqual([]);expect(built.edge.relation_type).toBe('dupe');
  expect(built.edge.provenance.curated_pair_evidence).toMatchObject({anchor_ref:'product:anchor',candidate_ref:'product:candidate',relation_type:'dupe',verified:true});
  const row = {...built.edge,id:'curated',label_state:'generated'};
  expect(validateRecommendationDecision(row,decision(a,b,'dupe')).verdict).toBe('approve');
  const queryFn = jest.fn(async()=>({rows:[{id:row.id,new_label_state:'ai_approved'}]}));
  await applyApproval(row,decision(a,b,'dupe'),queryFn,{allowDupeAiApproval:true});
  expect(getRelationshipEdgeServingSuppressionReasons({...row,label_state:'ai_approved'})).toContain('ai_approved_dupe_quarantined');
  expect(getRelationshipEdgeServingSuppressionReasons({...row,label_state:'human_approved'})).toEqual([]);
});

test('useful quality counters propagate through routine metrics without changing eligible denominator', () => {
  const {reviewMetrics} = require('../src/services/relationshipGraphServingProgress');
  expect(reviewMetrics({reviewed_count:5,guard_blocked_count:2,low_confidence_count:1,review_error_count:1,
    useful_approval_by_kind:{alternative:1},semantic_rejected_count:1,variant_rejected_count:2,
    approved_brand_distribution:{value:1}})).toMatchObject({review_error_denominator:2,review_error_rate:0.5,
    useful_approval_by_kind:{alternative:1},semantic_rejected_count:1,variant_rejected_count:2,approved_brand_distribution:{value:1}});
});

test('same-brand duplicate listings and sizes cannot become alternative coverage', () => {
  const a = snapshot('House','Hydrating Face Cream 30ml'); const b = snapshot('House','Hydrating Face Cream 50ml');
  expect(buildEdgeForCandidate({anchor:a,candidate:{...b,category_use_case_match:0.9,similarity_score:0.9},nowIso:NOW}).metrics.utilityCompatibility.reason).toBe('same_product_listing_or_size');
  expect(getRelationshipEdgeServingSuppressionReasons(edge(a,b,'competitive_alternative'))).toContain('competitive_alternative_same_product_across_listings_or_sizes');
});

test('routine complements cannot pass as same-brand alternatives, and generic pairing notes do not prove a pair', () => {
  const a=snapshot('House','Hydrating Essence','essence');const b=snapshot('House','Calming Ampoule','ampoule');
  expect(validateRecommendationDecision(edge(a,b,'competitive_alternative'),decision(a,b)).utility_rejection).toBe('structural_or_dupe_evidence_mismatch');
  const cream=snapshot('House','Hydrating Face Cream');const other=snapshot('House','Rich Recovery Face Cream');
  const {buildEvidence}=require('../scripts/review-relationship-candidate-labels');
  const row=edge(cream,other);const evidence=buildEvidence(row,new Map());
  evidence.anchor.routine_fit.pairing_notes=['Pairs well with moisturizers.'];
  expect(validateRecommendationDecision(row,decision(cream,other,'complement'),evidence).utility_rejection).toBe('same_step_substitutes_are_not_complements');
});

test.each([
  ['Perfect Cover BB Cream -23 Natural Beige', 'Perfect Cover BB Cream -27 Honey Beige', 'bbcream'],
  ['Cream Blush, Rose', 'Cream Blush, Peach', 'blush'],
  ['Sheer Glow - Punjab', 'Sheer Glow - Stromboli', 'foundation'],
])('cosmetic role/category covers named and dash shade syntax: %s/%s', (a,b,category) => {
  expect(isSameFamilyVariant(snapshot('House',a,category),snapshot('House',b,category))).toBe(true);
});


test.each([
  ['Teint Idole, Foundation', 'Teint Idole, Concealer'],
  ['Signature Line, Perfume', 'Signature Line, Lip Gloss'],
])('shared collection with distinct cosmetic roles remains available: %s/%s', (aTitle,bTitle) => {
  const a=snapshot('House',aTitle,'makeup');const b=snapshot('House',bTitle,'makeup');
  expect(isSameFamilyVariant(a,b)).toBe(false);
  for (const relation of ['related_product','competitive_alternative']) {
    expect(getRelationshipEdgeServingSuppressionReasons(edge(a,b,relation))).toEqual([]);
  }
});

test('same-step pair evidence must mention the opposite product from the note origin', () => {
  const a=snapshot('House','Hydrating Face Cream');const b=snapshot('House','Rich Recovery Face Cream');
  const {buildEvidence}=require('../scripts/review-relationship-candidate-labels');
  const row=edge(a,b);const evidence=buildEvidence(row,new Map());
  evidence.anchor.routine_fit.pairing_notes=[`Apply ${a.title} daily.`];
  evidence.candidate.routine_fit.pairing_notes=[`Apply ${b.title} nightly.`];
  expect(validateRecommendationDecision(row,decision(a,b,'complement'),evidence).utility_rejection).toBe('same_step_substitutes_are_not_complements');
  evidence.anchor.routine_fit.pairing_notes=[`Use alongside ${b.title} on dry patches.`];
  expect(validateRecommendationDecision(row,decision(a,b,'complement'),evidence).verdict).toBe('approve');
  evidence.anchor.routine_fit.pairing_notes=[];
  evidence.candidate.routine_fit.pairing_notes=[`Use alongside ${a.title} on dry patches.`];
  expect(validateRecommendationDecision(row,decision(a,b,'complement'),evidence).verdict).toBe('approve');
});


test('fragrance-free formula language preserves the facial moisturizer role and alternative lane', () => {
  const a=snapshot('House','Fragrance Free Barrier Face Cream');const b=snapshot('House','Rich Fragrance Free Recovery Face Cream');
  expect(optionRole(a)).toBe('cream');expect(optionRole(b)).toBe('cream');
  expect(inferRelationship(a,b,{category_use_case_match:0.9,similarity_score:0.9}).relation_type).toBe('competitive_alternative');
  expect(optionRole(snapshot('House','Signature Line - Amber','fragrance'))).toBe('perfume');
});


test.each([
  ['Volume Mascara - Black', 'Volume Mascara - Brown', 'mascara'],
  ['Flawless Face Powder - Ivory', 'Flawless Face Powder - Beige', 'facepowder'],
])('shade options are rejected by full serving and builder paths: %s/%s', (aName,bName,category) => {
  const a=snapshot('House',aName,category,{product_id:'shade-a'});const b=snapshot('House',bName,category,{product_id:'shade-b'});
  expect(isSameFamilyVariant(a,b)).toBe(true);
  for (const relation of ['related_product','competitive_alternative']) {
    expect(getRelationshipEdgeServingSuppressionReasons(edge(a,b,relation))).toContain(`${relation}_same_family_variant`);
  }
  expect(buildEdgeForCandidate({anchor:a,candidate:{...b,similarity_score:0.95,category_use_case_match:0.9},nowIso:NOW})).toMatchObject({edge:null,metrics:{utilityCompatibility:{reason:'same_family_variant'}}});
});

test('meaningful powder finish and mascara formulation differences remain separate choices', () => {
  for (const [aName,bName,category] of [
    ['Flawless Face Powder - Matte','Flawless Face Powder - Glow','facepowder'],
    ['Volume Mascara - Waterproof Black','Volume Mascara - Washable Brown','mascara'],
  ]) {
    const a=snapshot('House',aName,category);const b=snapshot('House',bName,category);
    expect(isSameFamilyVariant(a,b)).toBe(false);
    expect(getRelationshipEdgeServingSuppressionReasons(edge(a,b,'competitive_alternative'))).toEqual([]);
  }
});

test.each([
  ['Barrier Face Cream','Daily Facial Moisturizer'],
  ['Barrier Facial Moisturizer','Daily Facial Moisturizer'],
  ['Barrier Daily Hydrator','Daily Facial Hydrator'],
])('same-job substitution cannot pass complement review regardless of role spelling: %s/%s', async (aName,bName) => {
  const a=snapshot('House',aName,'moisturizer',{description:'Facial moisturizer for daily hydration.'});
  const b=snapshot('House',bName,'moisturizer',{description:'Facial moisturizer for daily hydration.'});
  const row=edge(a,b);const approved=decision(a,b,'complement');
  expect(inferRelationship(a,b,{similarity_score:0.95,category_use_case_match:0.9}).relation_type).toBe('competitive_alternative');
  expect(validateRecommendationDecision(row,approved).utility_rejection).toBe('same_step_substitutes_are_not_complements');
  const queryFn=jest.fn();await expect(applyApproval(row,approved,queryFn)).rejects.toMatchObject({code:'RECOMMENDATION_UTILITY_AI_APPROVAL_BLOCKED'});
  expect(queryFn).not.toHaveBeenCalled();
});

test('unresolved complement roles require grounded counterpart-specific pairing evidence', () => {
  const a=snapshot('House','Morning Ritual','beauty');const b=snapshot('House','Evening Ritual','beauty');
  const row=edge(a,b);const approved=decision(a,b,'complement');
  expect(validateRecommendationDecision(row,approved).utility_rejection).toBe('complement_role_evidence_unresolved');
  const {buildEvidence}=require('../scripts/review-relationship-candidate-labels');const evidence=buildEvidence(row,new Map());
  evidence.anchor.routine_fit.pairing_notes=[`Use with ${b.title} as part of this routine.`];
  expect(validateRecommendationDecision(row,approved,evidence).verdict).toBe('approve');
});

test.each([
  {recommendation_reason:'Clinically proven 48-hour hydration, safe during pregnancy, and identical performance.'},
  {tradeoffs:['20% retinol versus 1% retinol.']},
  {watchouts:['Eczema tested safe.']},
  {recommendation_reason:'Manufactured in France using a patented process.'},
])('valid fact quotes cannot authorize invented consumer prose: %j', async (invented) => {
  const a=snapshot('House','Hydrating Barrier Face Cream');const b=snapshot('House','Rich Recovery Face Cream');
  const row=edge(a,b,'competitive_alternative');const approved={...decision(a,b),...invented};
  expect(validateRecommendationDecision(row,approved).utility_rejection).toBe('consumer_copy_not_verified_contract');
  const queryFn=jest.fn();await expect(applyApproval(row,approved,queryFn)).rejects.toMatchObject({code:'RECOMMENDATION_UTILITY_AI_APPROVAL_BLOCKED'});
  expect(queryFn).not.toHaveBeenCalled();
});

test('positive approval persists deterministic consumer copy and verified facts, never internal model prose', async () => {
  const a=snapshot('House','Hydrating Barrier Face Cream');const b=snapshot('House','Rich Recovery Face Cream');
  const row=edge(a,b,'competitive_alternative');const approved={...decision(a,b),rationale:'Internal model prose is not consumer evidence.'};
  const queryFn=jest.fn(async()=>({rows:[{id:row.id,new_label_state:'ai_approved'}]}));
  await applyApproval(row,approved,queryFn);
  const [,params]=queryFn.mock.calls[0];const persisted={...row,why_candidate:JSON.parse(params[3]),tradeoffs:JSON.parse(params[4]),watchouts:JSON.parse(params[5])};
  expect(persisted.why_candidate.shared_evidence).toEqual(approved.shared_evidence);
  const item=relationshipEdgeToSimilarItem(persisted);const signal=relationshipEdgeToSignal(persisted);
  expect(item.reason).toBe(consumerCopyForKind('alternative').recommendation_reason);
  expect(signal.value.tradeoffs).toEqual(consumerCopyForKind('alternative').tradeoffs);
  expect(signal.value.watchouts).toEqual(consumerCopyForKind('alternative').watchouts);
  expect(JSON.stringify([item,signal])).not.toContain(approved.rationale);
});

test('approval fails closed when relation identity is missing', async () => {
  const a=snapshot('House','Hydrating Barrier Face Cream');const b=snapshot('House','Rich Recovery Face Cream');const queryFn=jest.fn();
  await expect(applyApproval({id:'missing_relation'},decision(a,b),queryFn)).rejects.toMatchObject({code:'RECOMMENDATION_UTILITY_AI_APPROVAL_BLOCKED'});
  expect(queryFn).not.toHaveBeenCalled();
});


test('eye moisturizer synonym preserves a different target-area complement', () => {
  const a=snapshot('House','Herbal Face Cream');const b=snapshot('House','Herbal Eye Moisturizer');
  expect(optionRole(b)).toBe('eye_cream');
  expect(validateRecommendationDecision(edge(a,b),decision(a,b,'complement')).verdict).toBe('approve');
});


test.each([
  ['HD Skin, Powder Foundation','HD Skin, Setting Powder','foundation','setting_powder'],
  ['Studio Collection, Contour Powder','Studio Collection, Blush Powder','contour','blush'],
])('powder form does not merge distinct makeup jobs: %s/%s', (aName,bName,aRole,bRole) => {
  const a=snapshot('House',aName,'complexion');const b=snapshot('House',bName,'complexion');
  expect(optionRole(a)).toBe(aRole);expect(optionRole(b)).toBe(bRole);
  expect(isSameFamilyVariant(a,b)).toBe(false);
  for (const relation of ['related_product','competitive_alternative']) {
    expect(getRelationshipEdgeServingSuppressionReasons(edge(a,b,relation))).toEqual([]);
  }
  const built=buildEdgeForCandidate({anchor:a,candidate:{...b,similarity_score:0.95,category_use_case_match:0.9,source_refs:[{type:'catalog_products'}]},nowIso:NOW});
  expect(built.errors).toEqual([]);expect(built.edge.relation_type).toBe('related_product');
});

test('specific fused powder categories preserve job distinctions when names omit the form', () => {
  expect(optionRole(snapshot('House','HD Skin - Ivory','powderfoundation'))).toBe('foundation');
  expect(optionRole(snapshot('House','HD Skin - Ivory','settingpowder'))).toBe('setting_powder');
});


test.each([
  'Do not use with Rich Recovery Face Cream.',
  'Never combine with Rich Recovery Face Cream.',
  'Avoid using alongside Rich Recovery Face Cream.',
  'Apply Hydrating Face Cream daily.',
  'Use alongside Other Recovery Face Cream.',
  'Use alongside Rich Recovery Face Cream SPF 50.',
])('nonaffirmative or different-pair notes cannot authorize complements: %s', async (note) => {
  const a=snapshot('House','Hydrating Face Cream');
  const b=snapshot('House','Rich Recovery Face Cream');
  a.product_intel={product_intel_core:{routine_fit:{pairing_notes:[note]}}};
  const row=edge(a,b);const approved=decision(a,b,'complement');
  expect(validateRecommendationDecision(row,approved).verdict).toBe('reject');
  const queryFn=jest.fn();await expect(applyApproval(row,approved,queryFn)).rejects.toMatchObject({code:'RECOMMENDATION_UTILITY_AI_APPROVAL_BLOCKED'});
  expect(queryFn).not.toHaveBeenCalled();
});

test('contradictory current-pair instruction defeats a positive pairing note', async () => {
  const a=snapshot('House','Hydrating Face Cream');const b=snapshot('House','Rich Recovery Face Cream');
  a.product_intel={product_intel_core:{routine_fit:{pairing_notes:[`Use alongside ${b.title} on dry patches.`]}}};
  b.product_intel={product_intel_core:{routine_fit:{pairing_notes:[`Do not use with ${a.title}.`]}}};
  const row=edge(a,b);const approved=decision(a,b,'complement');
  expect(validateRecommendationDecision(row,approved).utility_rejection).toBe('contradictory_pairing_evidence');
  const queryFn=jest.fn();await expect(applyApproval(row,approved,queryFn)).rejects.toMatchObject({code:'RECOMMENDATION_UTILITY_AI_APPROVAL_BLOCKED'});
  expect(queryFn).not.toHaveBeenCalled();
});
