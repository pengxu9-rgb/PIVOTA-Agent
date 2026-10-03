'use strict';
const { TABLE, identityKey, sha256, validateReviewedIngredientEvidence, appendReviewedIngredientEvidence, __internal } = require('../../src/services/relationshipReviewedIngredientEvidence');
const { loadIngredientKbCandidates } = require('../../src/auroraBff/productRelationshipGraphSources');
const { __internal: sourceInternal } = require('../../src/auroraBff/productRelationshipGraphSources');
const { productReadiness } = require('../../src/services/relationshipEvidenceReadiness');
const NOW = Date.parse('2026-10-03T00:00:00Z');
const OBSERVED = '2026-10-02T12:00:00.000Z';
const FORMULA = 'Water, Glycerin, Niacinamide, Panthenol, Sodium Hyaluronate';
function record(overrides = {}) {
  const identity = { product_key: 'cp_a', pivota_signature_id: 'sig_a', product_id: 'ext_a', source_product_id: 'ext_a', merchant_id: 'external_seed',
    platform: 'external', market: 'US', variant_title: 'Original', variant_detail_label: '' };
  const rawBody = Buffer.from(`<html><p>Ingredients: ${FORMULA}</p></html>`);
  const shared = { identity, source_url: 'https://example.test/pdp/a', source_observed_at: OBSERVED, formula_sha256: sha256(FORMULA), raw_source_sha256: sha256(rawBody),
    exact_listing_verified: true, full_ingredient_list: true };
  return { schema: 'relgraph.reviewed_ingredient_evidence.v1', ...shared, ingredient_text: FORMULA, parse_status: 'OK', review_status: 'APPROVED', audit_status: 'PASS', ingest_allowed: true,
    raw_source_body: rawBody,
    source_capture: { ...shared, capture_id: 'actual-fetch-1', capture_method: 'bound_pdp_fetch', source_excerpt: FORMULA, source_excerpt_sha256: sha256(FORMULA) },
    reviews: ['gpt','gemini'].map(provider => ({ ...shared, provider, review_id: `${provider}-1`, decision: 'approve', reviewed_at: OBSERVED, source_grounded: true,
      source_excerpt_sha256: sha256(FORMULA), grounded_quote: FORMULA })), ...overrides };
}
function fixturePool(existing = {}, errorOnInsert = false, errorOnCommit = false) {
  const calls = []; const client = { release: jest.fn(), query: jest.fn(async (sql, args) => {
    calls.push([sql,args]);
    if (sql.includes('to_regclass')) return { rows: [{ regclass: args[0] }] };
    if (sql.startsWith('SELECT to_jsonb')) { const table = Object.keys(existing).find(name => sql.includes(name)); return { rows: (existing[table] || []).map(evidence => ({evidence})) }; }
    if (sql.startsWith('INSERT')) { if (errorOnInsert) throw new Error('serialize failure'); return { rows: [], rowCount: 1 }; }
    if (sql==='COMMIT' && errorOnCommit) throw new Error('connection lost after commit');
    return { rows: [] };
  }) }; return { pool: { connect: jest.fn(async () => client) }, client, calls,
    rebindExactListing: jest.fn(async ({client: transactionClient, record:p}) => {
      expect(transactionClient).toBe(client);
      return {...p.identity,url:p.source_url,source_refs:[{type:'external_product_seed',name:p.identity.product_id,url:p.source_url,authoritative:true,...p.identity}]};
    }) };
}
test('strict immutable proof binds actual source clock, whole formula and both independent reviews', () => {
  const validated = validateReviewedIngredientEvidence(record(), { nowMs: NOW });
  expect(validated.source_observed_at).toBe(OBSERVED); expect(validated.identity_key).toBe(identityKey(validated.identity));
  expect(validated.evidence_id).toMatch(/^[a-f0-9]{64}$/);
});
test('JSONB object key reordering preserves durable proof fingerprint and valid hydration', async () => {
  const proof=validateReviewedIngredientEvidence(record(),{nowMs:NOW});
  const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reorder(value[key])])):value;
  const roundtrip=reorder(JSON.parse(JSON.stringify(proof)));
  expect(validateReviewedIngredientEvidence(roundtrip,{nowMs:NOW}).evidence_id).toBe(proof.evidence_id);
  const queryFn=async(sql,args)=>sql.includes('to_regclass')?{rows:[{table_name:args[0]===TABLE?TABLE:null}]}:{rows:[{...proof.identity,...proof,proof:roundtrip}]};
  const loaded=await loadIngredientKbCandidates({queryFn}); expect(loaded).toHaveLength(1);
  expect(productReadiness(loaded[0],{nowMs:NOW}).ingredients).toBe('substantial_current_owned');
});
test.each(['market','merchant_id','platform','variant_title','product_key','pivota_signature_id'])('borrowed %s scope is rejected even with same formula and signature', field => {
  const row = record(); row.reviews[1] = { ...row.reviews[1], identity: { ...row.identity, [field]: 'other' } };
  expect(() => validateReviewedIngredientEvidence(row, {nowMs: NOW})).toThrow(/ingredient_evidence_review_binding|ingredient_evidence_identity/);
});
test.each(['parse_status','review_status','audit_status','ingest_allowed'])('strict %s cannot be forged from defaults', field => {
  expect(() => validateReviewedIngredientEvidence(record({ [field]: false }), {nowMs:NOW})).toThrow('ingredient_evidence_status');
});
test('future/stale source date, partial list, changed formula/source hash and disagreement never validate', () => {
  for (const changes of [{ source_observed_at: '2026-10-04T00:00:00Z' }, { source_observed_at: '2026-01-01T00:00:00Z' },
    { full_ingredient_list: false }, { formula_sha256: sha256('other') }, { raw_source_sha256: 'invalid' }]) {
    expect(() => validateReviewedIngredientEvidence(record(changes), {nowMs:NOW})).toThrow();
  }
  const denied = record(); denied.reviews[1].decision = 'reject'; expect(() => validateReviewedIngredientEvidence(denied, {nowMs:NOW})).toThrow('ingredient_evidence_review_binding');
  const single = record(); single.reviews.pop(); expect(() => validateReviewedIngredientEvidence(single, {nowMs:NOW})).toThrow('ingredient_evidence_consensus');
});
test('explicit actual human approval supported but no automatic supersession or reconciliation', () => {
  const row = record(); row.reviews = [{ ...row.reviews[0], provider: 'human' }];
  expect(validateReviewedIngredientEvidence(row, {nowMs:NOW}).reviews).toHaveLength(1);
  expect(() => validateReviewedIngredientEvidence({...row,supersedes:'human-row'}, {nowMs:NOW})).toThrow('ingredient_evidence_reconciliation_unsupported');
});
test('unchanged formula allowed; trusted human conflicting or rejected evidence always blocks', () => {
  const row = validateReviewedIngredientEvidence(record(), {nowMs:NOW});
  expect(() => __internal.assertNoProtectedConflict(row, [{raw_inci:FORMULA}])).not.toThrow();
  expect(() => __internal.assertNoProtectedConflict(row, [{raw_inci:'Water, Retinol',source_system:'human'}])).toThrow('ingredient_evidence_existing_conflict');
  expect(() => __internal.assertNoProtectedConflict(row, [{raw_inci:FORMULA,review_status:'REJECTED'}])).toThrow('ingredient_evidence_existing_rejection');
  expect(() => __internal.assertNoProtectedConflict(row, Array(5).fill({raw_inci:FORMULA}))).toThrow('ingredient_evidence_existing_incomplete');
});
test('dry run inspects same frozen transaction, rolls back, and never inserts', async () => {
  const f = fixturePool(); const result = await appendReviewedIngredientEvidence({pool:f.pool,rebindExactListing:f.rebindExactListing,records:[record()],nowMs:NOW});
  expect(result.kb_writes).toBe(0); expect(f.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
  expect(f.calls[0][0]).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE'); expect(f.calls.at(-1)[0]).toBe('ROLLBACK'); expect(f.client.release).toHaveBeenCalledTimes(1);
});
test('append commit is bounded and append-only, after evidence conflict checks; failure rolls whole batch back', async () => {
  const f = fixturePool(); expect((await appendReviewedIngredientEvidence({pool:f.pool,rebindExactListing:f.rebindExactListing,records:[record()],nowMs:NOW,apply:true})).inserted).toBe(1);
  const insert = f.calls.find(([sql]) => sql.startsWith('INSERT')); expect(insert[1]).toHaveLength(17);
  expect(insert[0]).toContain('ON CONFLICT (evidence_id) DO NOTHING'); expect(insert[0]).not.toContain('DO UPDATE');
  expect(f.calls.at(-1)[0]).toBe('COMMIT');
  const bad = fixturePool({},true); await expect(appendReviewedIngredientEvidence({pool:bad.pool,rebindExactListing:bad.rebindExactListing,records:[record()],nowMs:NOW,apply:true})).rejects.toThrow('serialize failure');
  expect(bad.calls.at(-1)[0]).toBe('ROLLBACK'); expect(bad.client.release).toHaveBeenCalledTimes(1);
});
test('legacy explicit rejection is queried before serving filters and aborts before insert', async () => {
  const f = fixturePool({'pci_kb.sku_ingredients':[{raw_ingredient_text_clean:FORMULA,review_status:'REJECTED'}]});
  await expect(appendReviewedIngredientEvidence({pool:f.pool,rebindExactListing:f.rebindExactListing,records:[record()],nowMs:NOW,apply:true})).rejects.toThrow('ingredient_evidence_existing_rejection');
  expect(f.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false); expect(f.calls.at(-1)[0]).toBe('ROLLBACK');
});
test('authoritative source/identity must rebind inside writer transaction and drift aborts before append', async () => {
  const f=fixturePool();
  await expect(appendReviewedIngredientEvidence({pool:f.pool,records:[record()],nowMs:NOW,apply:true})).rejects.toThrow('ingredient_evidence_transaction_rebind_required');
  expect(f.pool.connect).not.toHaveBeenCalled();
  f.rebindExactListing.mockResolvedValue({...record().identity,url:'https://example.test/pdp/other',source_refs:[]});
  await expect(appendReviewedIngredientEvidence({pool:f.pool,rebindExactListing:f.rebindExactListing,records:[record()],nowMs:NOW,apply:true})).rejects.toThrow('ingredient_evidence_transaction_listing_drift');
  expect(f.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false); expect(f.calls.at(-1)[0]).toBe('ROLLBACK');
});
test('uncertain COMMIT returns unknown publication proof without rollback or blind retry', async () => {
  const f=fixturePool({},false,true);
  const receipt=await appendReviewedIngredientEvidence({pool:f.pool,rebindExactListing:f.rebindExactListing,records:[record()],nowMs:NOW,apply:true});
  expect(receipt.status).toBe('publication_outcome_unknown'); expect(receipt.kb_writes).toBeNull(); expect(receipt.retry_allowed).toBe(false);
  expect(receipt.evidence_ids).toHaveLength(1); expect(receipt.evidence_ids[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(f.calls.at(-1)[0]).toBe('COMMIT'); expect(f.client.release).toHaveBeenCalledWith(expect.any(Error));
});
test('non-Latin or malformed protected formula never normalizes empty and bypasses conflict guard', () => {
  const row=validateReviewedIngredientEvidence(record(),{nowMs:NOW});
  for(const raw_inci of ['水、甘油、烟酰胺','!!!']) expect(()=>__internal.assertNoProtectedConflict(row,[{raw_inci}])).toThrow('ingredient_evidence_existing_conflict');
});
test('17 record bound, duplicate identity, and non-boolean apply reject before connecting', async () => {
  const f=fixturePool();
  for (const args of [{records:Array(18).fill(record())}, {records:[record(),record()]}, {records:[record()],apply:'false'}]) {
    await expect(appendReviewedIngredientEvidence({pool:f.pool,rebindExactListing:f.rebindExactListing,nowMs:NOW,...args})).rejects.toThrow();
  }
  expect(f.pool.connect).not.toHaveBeenCalled();
});
test('writer verifies full source bytes independently of extraction time and claimed capture hashes', async () => {
  const f=fixturePool(); const row=record(); row.raw_source_body=Buffer.from('<p>Unrelated product content</p>');
  await expect(appendReviewedIngredientEvidence({pool:f.pool,rebindExactListing:f.rebindExactListing,records:[row],nowMs:NOW,apply:true})).rejects.toThrow('ingredient_evidence_raw_capture_grounding');
  expect(f.pool.connect).not.toHaveBeenCalled();
  const borrowed=record(); borrowed.reviews[1].grounded_quote='Water, Glycerin';
  expect(()=>validateReviewedIngredientEvidence(borrowed,{nowMs:NOW})).toThrow('ingredient_evidence_review_binding');
  const manufactured=record(); manufactured.source_capture.source_excerpt='Water, Retinol'; manufactured.source_capture.source_excerpt_sha256=sha256('Water, Retinol');
  expect(()=>validateReviewedIngredientEvidence(manufactured,{nowMs:NOW})).toThrow('ingredient_evidence_source_grounding');
});
test('raw bytes, model responses and unknown nested payloads cannot enter persisted proof', () => {
  for(const part of ['source_capture','reviews']) {
    const row=record(); const target=part==='reviews'?row.reviews[0]:row.source_capture;
    target.raw_source_body=Buffer.from('private raw bytes');
    expect(()=>validateReviewedIngredientEvidence(row,{nowMs:NOW})).toThrow('ingredient_evidence_unknown_proof_field');
  }
  const row=record(); row.source_capture.identity={...row.identity,raw_response:'private payload'};
  row.reviews[0].identity={...row.identity,credential:'private value'};
  const validated=validateReviewedIngredientEvidence(row,{nowMs:NOW});
  const serialized=JSON.stringify(validated);
  expect(serialized).not.toContain('raw_source_body'); expect(serialized).not.toContain('private payload'); expect(serialized).not.toContain('private value');
});
test('optional loader preserves exact provenance and real fetch clock; malformed flattened scope cannot borrow valid proof', async () => {
  const p = validateReviewedIngredientEvidence(record(), {nowMs:NOW});
  const row = { ...p.identity, ...p, proof:p, source_observed_at:OBSERVED };
  const queries=[]; const queryFn = async (sql,args) => {
    queries.push([sql,args]);
    if (sql.includes('to_regclass')) return {rows:[{table_name:args[0]===TABLE ? TABLE : null}]};
    return {rows:[row]};
  };
  const [loaded] = await loadIngredientKbCandidates({queryFn,targetProducts:[{...p.identity,url:p.source_url}]});
  expect(loaded.ingredient_evidence[0].observed_at).toBe(OBSERVED);
  expect(loaded.ingredient_evidence[0].raw_source_sha256).toBe(p.raw_source_sha256);
  expect(loaded.ingredient_evidence[0].review_refs.map(review=>review.provider)).toEqual(['gpt','gemini']);
  expect(productReadiness(loaded,{nowMs:NOW}).ingredients).toBe('substantial_current_owned');
  const select=queries.find(([sql])=>sql.includes('FROM '+TABLE)); expect(select[1][0]).toBe(5);
  expect(JSON.parse(select[1][1])[0].reviewed_identity_keys).toEqual([p.identity_key]);
  expect(select[0].indexOf('identity_key = ANY(target.reviewed_identity_keys)')).toBeLessThan(select[0].indexOf('ORDER BY source_observed_at'));
  expect(select[0].indexOf('upper(market) = target.market')).toBeLessThan(select[0].indexOf('ORDER BY source_observed_at'));
  row.market='GB'; expect(await loadIngredientKbCandidates({queryFn})).toEqual([]);
});
test('exact lane cannot lend known variant/market formula during global discovery or later index merge', async () => {
  const p=validateReviewedIngredientEvidence(record(),{nowMs:NOW});
  const queryFn=async(sql,args)=>sql.includes('to_regclass')?{rows:[{table_name:args[0]===TABLE?TABLE:null}]}:{rows:[{...p.identity,...p,proof:p}]};
  const loaded=await loadIngredientKbCandidates({queryFn});
  const index=sourceInternal.buildIngredientIndex(loaded);
  const valid={...p.identity,name:'Example Serum',brand:'Example'};
  const same=sourceInternal.mergeCandidateWithIngredients(valid,index);
  expect(same.ingredient_text).toBe(FORMULA);
  for(const fields of [{market:'GB'},{variant_title:'Tinted'},{variant_title:''},{source_product_id:'ext_other'}]) {
    expect(sourceInternal.mergeCandidateWithIngredients({...valid,...fields},index).ingredient_text).toBeUndefined();
  }
});
test('per-target sentinel bounds historical rows and keeps legacy formula conflicts visible', async () => {
  const p=validateReviewedIngredientEvidence(record(),{nowMs:NOW});
  const row={...p.identity,...p,proof:p,_evidence_target_key:'product_key:cp_a'};
  const queryFn=async(sql,args)=>sql.includes('to_regclass')?{rows:[{table_name:args[0]===TABLE?TABLE:null}]}:{rows:Array(5).fill(row)};
  const loaded=await loadIngredientKbCandidates({queryFn,targetProducts:[{...p.identity,url:p.source_url}]});
  expect(loaded).toHaveLength(1); expect(loaded.every(item=>item.ingredient_evidence_incomplete)).toBe(true);
  const single=sourceInternal.mergeCandidateWithIngredients({...p.identity,name:'Example',ingredient_text:'Water, Retinol, Glycerin, Panthenol, Fragrance'},sourceInternal.buildIngredientIndex([{...loaded[0],ingredient_evidence_incomplete:false}]));
  expect(single.ingredient_evidence_conflict).toBe(true); expect(single.ingredient_text).toBeUndefined();
});
test('loader never substitutes insertion timestamps when source timestamp is stale', async () => {
  const old = record({source_observed_at:'2026-01-01T00:00:00.000Z'});
  old.source_capture.source_observed_at=old.source_observed_at; old.reviews.forEach(r=>{r.source_observed_at=old.source_observed_at;});
  const p=validateReviewedIngredientEvidence(old,{nowMs:NOW,requireCurrent:false});
  const queryFn=async(sql,args)=> sql.includes('to_regclass') ? {rows:[{table_name:args[0]===TABLE?TABLE:null}]} : {rows:[{...p.identity,...p,proof:p,created_at:new Date(NOW).toISOString(),updated_at:new Date(NOW).toISOString()}]};
  const [loaded]=await loadIngredientKbCandidates({queryFn}); expect(productReadiness(loaded,{nowMs:NOW}).ingredients).toBe('stale');
});

test('optional actual model and packet linkage are bounded primitive metadata',()=>{
  const row=record();row.reviews[0].model='gpt-5.4';row.reviews[0].packet_sha256=sha256('actual provider packet');
  const valid=validateReviewedIngredientEvidence(row,{nowMs:NOW});expect(valid.reviews[0].model).toBe('gpt-5.4');expect(valid.reviews[0].packet_sha256).toBe(row.reviews[0].packet_sha256);
  for(const [field,value] of [['model',{raw:'private'}],['model','m'.repeat(129)],['packet_sha256',{raw:'private'}],['packet_sha256','not-a-hash'],['packet_sha256',[sha256('nested payload')]]]) {
    const malformed=record();malformed.reviews[0][field]=value;expect(()=>validateReviewedIngredientEvidence(malformed,{nowMs:NOW})).toThrow();
  }
});
