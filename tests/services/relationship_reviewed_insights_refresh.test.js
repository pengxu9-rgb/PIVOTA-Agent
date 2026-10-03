const crypto = require('node:crypto');
const h = require('../../src/services/relationshipReviewedInsightsRefresh');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const at = Date.parse('2026-10-03T10:00:00Z');
const owner = { product_key: 'pk', product_id: 'ext_test', source_product_id: 'ext_test', merchant_id: 'external_seed',
  market: 'US', platform: 'shopify', variant_title: '', variant_detail_label: '' };
const description = 'This water-based serum has a light texture. Apply to the face after cleansing and before moisturizer.';
function packet() {
  const raw = Buffer.from(`<html><h1>Example Serum</h1><p>${description}</p><p>Apply after cleansing.</p></html>`);
  const base = { identity: owner, source_url: 'https://seller.example/products/serum', source_observed_at: new Date(at).toISOString(),
    raw_source_body: raw, raw_source_sha256: hash(raw), facts: { title: 'Example Serum', brand:'Example', description, usage: 'Apply after cleansing.' } };
  base.source_capture = { capture_method: 'bound_pdp_fetch', exact_listing_verified: true, identity: owner,
    source_url: base.source_url, source_observed_at: base.source_observed_at, raw_source_sha256: base.raw_source_sha256 };
  return base;
}
function reviews(prepared) {
  return ['gpt','gemini'].map(provider => ({ provider, model: provider === 'gpt' ? 'gpt-4.1' : 'gemini-3-flash-preview',
    review_id: `${provider}-review`, reviewed_at: new Date(at+1000).toISOString(), bundle_sha256: prepared.bundle_sha256,
    source_sha256: prepared.source_sha256, decision: 'approve', confidence: 0.95,
    claims: prepared.claims.map(claim => ({ claim_id: claim.id, assessment: 'supported', quote: claim.text })) }));
}
const prepare = () => h.prepareSellerInsights(packet(), { nowMs: at });
test('verbatim current facts require two complete independent approvals with honest assistant attribution', () => {
  const prepared=prepare();const result=h.finalizeSellerInsights(prepared,reviews(prepared),{nowMs:at+2000});
  expect(result.status).toBe('approved');
  expect(result.entry.kb_key).toBe('product:ext_test');
  const bundle=result.entry.analysis.product_intel_v1;
  expect(bundle.provenance.reviewer_kind).toBe('assistant');
  expect(bundle.evidence_profile).toBe('seller_only');
  expect(bundle.product_intel_core.what_it_is.body).toBe(description);
  expect(bundle.product_intel_core.best_for).toEqual([]);
  expect(bundle.external_highlight_signals).toEqual([]);
});
test('stale/changed/unbound capture and unsupported source facts fail before drafting', () => {
  for (const mutate of [p=>p.raw_source_body=Buffer.from('changed'),p=>p.source_capture.identity={...owner,market:'JP'},
    p=>p.facts.description='Fabricated specific product facts and cosmetic benefits that were never in the actual raw source page.'.repeat(2),
    p=>p.source_observed_at='2020-01-01T00:00:00Z']) {
    const p=packet();mutate(p);expect(()=>h.prepareSellerInsights(p,{nowMs:at})).toThrow();
  }
});
test('missing review/claim/citation and shared reviewer fail closed', () => {
  const prepared=prepare();
  for (const mutate of [r=>r.pop(),r=>r[1].provider='gpt',r=>r[1].claims.pop(),
    r=>r[1].claims[1].quote='made up',r=>delete r[1].decision,r=>r[1].review_id=r[0].review_id]) {
    const r=reviews(prepared);mutate(r);expect(()=>h.finalizeSellerInsights(prepared,r,{nowMs:at+2000})).toThrow();
  }
});
test('verdict or per-claim disagreement escalates; shared uncertainty does not approve', () => {
  const prepared=prepare();let r=reviews(prepared);r[1].decision='uncertain';
  expect(h.finalizeSellerInsights(prepared,r,{nowMs:at+2000})).toEqual({status:'human_review',entry:null});
  r=reviews(prepared);r[1].claims[0].assessment='uncertain';
  expect(h.finalizeSellerInsights(prepared,r,{nowMs:at+2000})).toEqual({status:'human_review',entry:null});
  r=reviews(prepared);r.forEach(row=>row.decision='uncertain');
  expect(h.finalizeSellerInsights(prepared,r,{nowMs:at+2000})).toEqual({status:'evidence_hold',entry:null});
});
test('changed bundle invalidates prior approval; old embedded intel cannot become evidence', () => {
  const p=packet();p.product_intel={quality_state:'reviewed',made_up:'Best for every skin type'};
  p.assessment={summary:'untrusted old assessment'};const prepared=h.prepareSellerInsights(p,{nowMs:at});
  expect(JSON.stringify(prepared.bundle)).not.toMatch(/every skin type|untrusted old/);
  const r=reviews(prepared);prepared.bundle.product_intel_core.what_it_is.body='changed';
  expect(()=>h.finalizeSellerInsights(prepared,r,{nowMs:at+2000})).toThrow('insights_facts_changed');
});
test('removing or changing claims cannot publish unreviewed original bundle text', () => {
  const prepared=prepare();prepared.claims=prepared.claims.slice(0,1);
  expect(()=>h.finalizeSellerInsights(prepared,reviews(prepared),{nowMs:at+2000})).toThrow('insights_claims_changed');
  const modified=prepare();modified.claims[1].text='changed claim';
  expect(()=>h.finalizeSellerInsights(modified,reviews(modified),{nowMs:at+2000})).toThrow('insights_claims_changed');
});
test('a compatible global key does not authorize cross-market KB replacement', () => {
  const prepared=prepare();const entry=h.finalizeSellerInsights(prepared,reviews(prepared),{nowMs:at+2000}).entry;
  const existing=JSON.parse(JSON.stringify(entry));existing.analysis.product_intel_v1.canonical_product_ref.market='JP';
  expect(()=>h.assertSafeInsightsReplacement(existing,entry)).toThrow('insights_kb_scope_collision');
});

function graphFixture(){
  const p=packet();p.source_capture.capture_id='actual-capture-1';p.source_capture.source_excerpt=`${p.facts.title} ${p.facts.description} ${p.facts.usage}`;
  p.source_capture.source_excerpt_sha256=hash(p.source_capture.source_excerpt);
  const prepared=h.prepareSellerInsights(p,{nowMs:at});const r=reviews(prepared).map(review=>({...review,packet_sha256:hash('actual-native-review-packet')}));
  return {packet:p,prepared,reviews:r,record:h.makeGraphSellerEvidence(prepared,r,{nowMs:at+2000}).record};
}
function graphPool(existing=[],publicRows=[],failCommit=false){
  const calls=[];const client={release:jest.fn(),query:jest.fn(async(sql,args)=>{
    calls.push([sql,args]);if(sql.includes('to_regclass'))return {rows:[{regclass:args[0]}]};
    if(sql.includes('SELECT proof'))return {rows:existing.map(proof=>({proof}))};
    if(sql.includes('SELECT analysis'))return {rows:publicRows};
    if(sql.startsWith('INSERT'))return {rows:[],rowCount:1};
    if(sql==='COMMIT'&&failCommit)throw new Error('commit acknowledgment lost');return {rows:[]};
  })};
  const rebindExactListing=jest.fn(async({client:c,record})=>{expect(c).toBe(client);const s=record.source;return {...s.identity,url:s.source_url,
    source_refs:[{type:'external_product_seed',name:s.identity.product_id,url:s.source_url,authoritative:true,...s.identity}]};});
  return {calls,client,pool:{connect:jest.fn(async()=>client)},rebindExactListing};
}
test('graph-only record survives JSONB order, carries pinned actual receipt links, and never qualifies public card replacement',()=>{
  const f=graphFixture();const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,reorder(v[k])])):v;
  const loaded=h.validateGraphSellerEvidence(reorder(f.record),{nowMs:at+2000,rawSourceBody:f.packet.raw_source_body});expect(loaded.evidence_id).toBe(f.record.evidence_id);
  expect(loaded.graph_only).toBe(true);expect(loaded.public_insights_eligible).toBe(false);expect(loaded.reviews[0].packet_sha256).toMatch(/^[a-f0-9]{64}$/);
  const entry=h.finalizeSellerInsights(f.prepared,f.reviews,{nowMs:at+2000}).entry;
  expect(()=>h.assertSafeInsightsReplacement(null,entry)).toThrow('insights_protected_replacement');
});
test('complete deterministic draft equality rejects unreviewed extra claims or hidden payload even with recomputed hashes',()=>{
  for(const mutate of [b=>b.external_highlight_signals.push({claim:'invented endorsement'}),b=>b.product_intel_core.best_for.push('all skin types'),
    b=>b.provenance.raw_model_response='private response',b=>b.recommendation_intents.push('curated_dupe')]){
    const f=graphFixture();mutate(f.prepared.bundle);f.prepared.bundle_sha256=h.__internal.hashValue(f.prepared.bundle);
    f.reviews.forEach(r=>r.bundle_sha256=f.prepared.bundle_sha256);
    expect(()=>h.makeGraphSellerEvidence(f.prepared,f.reviews,{nowMs:at+2000})).toThrow('insights_graph_extra_claims');
  }
});
test('extra persisted review/source/claim payload and changed source excerpt fail closed',()=>{
  const f=graphFixture();const r=reviews(f.prepared);r[0].raw_model_response='private';expect(()=>h.finalizeSellerInsights(f.prepared,r,{nowMs:at+2000})).toThrow('insights_unknown_proof_field');
  const bad=packet();bad.source_capture.raw_source_body=Buffer.from('private');expect(()=>h.prepareSellerInsights(bad,{nowMs:at})).toThrow('insights_unknown_proof_field');
  const p=graphFixture().packet;p.source_capture.source_excerpt='unsupported';p.source_capture.source_excerpt_sha256=hash('unsupported');
  expect(()=>h.prepareSellerInsights(p,{nowMs:at})).toThrow('insights_capture_excerpt_grounding');
});
test('graph writer transactionally rebinds and appends only its own store; dry run writes zero',async()=>{
  const f=graphFixture();const db=graphPool();
  const dry=await h.appendGraphSellerEvidence({...db,records:[f.record],rawSourceBodies:[f.packet.raw_source_body],nowMs:at+2000});
  expect(dry.kb_writes).toBe(0);expect(db.calls.at(-1)[0]).toBe('ROLLBACK');
  const result=await h.appendGraphSellerEvidence({...db,records:[f.record],rawSourceBodies:[f.packet.raw_source_body],nowMs:at+2000,apply:true});
  expect(result.inserted).toBe(1);expect(result.public_kb_writes).toBe(0);
  const inserts=db.calls.filter(([sql])=>sql.startsWith('INSERT'));expect(inserts).toHaveLength(1);expect(inserts[0][0]).toContain(h.TABLE);expect(inserts[0][0]).not.toContain('aurora_product_intel_kb');
});
test('same-client drift, protected/rejected public evidence and differing historical facts block before append',async()=>{
  const f=graphFixture();
  for(const row of [{analysis:{product_intel_v1:{quality_state:'ready'}}}, {analysis:{product_intel_v1:{quality_state:'rejected'}}},
    {analysis:{product_intel_v1:{provenance:{reviewer_kind:'human'}}}}]){
    const db=graphPool([], [row]);await expect(h.appendGraphSellerEvidence({...db,records:[f.record],rawSourceBodies:[f.packet.raw_source_body],nowMs:at+2000,apply:true})).rejects.toThrow('insights_graph_protected_existing');
    expect(db.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
  }
  const db=graphPool();db.rebindExactListing.mockResolvedValue({...owner,url:'https://seller.example/other',source_refs:[]});
  await expect(h.appendGraphSellerEvidence({...db,records:[f.record],rawSourceBodies:[f.packet.raw_source_body],nowMs:at+2000,apply:true})).rejects.toThrow('insights_graph_listing_drift');
  const old=JSON.parse(JSON.stringify(f.record));old.source.facts.description='different facts';const conflict=graphPool([old]);
  await expect(h.appendGraphSellerEvidence({...conflict,records:[f.record],rawSourceBodies:[f.packet.raw_source_body],nowMs:at+2000,apply:true})).rejects.toThrow('insights_graph_existing_conflict');
});
test('identical facts recapture history allowed, batch bounded, and unknown COMMIT holds publication outcome',async()=>{
  const f=graphFixture();const old=JSON.parse(JSON.stringify(f.record));old.source.source_observed_at='2026-09-30T00:00:00Z';
  const db=graphPool([old]);expect((await h.appendGraphSellerEvidence({...db,records:[f.record],rawSourceBodies:[f.packet.raw_source_body],nowMs:at+2000,apply:true})).inserted).toBe(1);
  const lost=graphPool([],[],true);const receipt=await h.appendGraphSellerEvidence({...lost,records:[f.record],rawSourceBodies:[f.packet.raw_source_body],nowMs:at+2000,apply:true});
  expect(receipt.status).toBe('publication_outcome_unknown');expect(receipt.kb_writes).toBeNull();expect(receipt.retry_allowed).toBe(false);expect(lost.calls.at(-1)[0]).toBe('COMMIT');
  await expect(h.appendGraphSellerEvidence({...db,records:Array(18).fill(f.record),rawSourceBodies:[],nowMs:at+2000})).rejects.toThrow('insights_graph_batch_bound');
});
test('optional exact seller loader and merge retain real source clock and defer to older protected human Intel',async()=>{
  const {loadProductIntelKbRows,__internal}=require('../../src/auroraBff/productRelationshipGraphSources');
  const {productReadiness}=require('../../src/services/relationshipEvidenceReadiness');const f=graphFixture();
  const queryFn=async(sql,args)=>{
    if(sql.includes('to_regclass'))return {rows:[{table_name:args[0]===h.TABLE?h.TABLE:null}]};
    if(sql.includes('FROM '+h.TABLE))return {rows:[{evidence_id:f.record.evidence_id,identity_key:f.record.identity_key,source_url:f.record.source.source_url,
      source_observed_at:f.record.source.source_observed_at,proof:JSON.parse(JSON.stringify(f.record))}]};
    return {rows:[]};
  };
  const rows=await loadProductIntelKbRows({queryFn,targetProducts:[{...owner,url:f.packet.source_url}]});expect(rows).toHaveLength(1);
  const candidate={...owner,brand:'Example',name:f.packet.facts.title,url:f.packet.source_url};const index=__internal.buildIntelIndex(rows);
  const matches=__internal.findIntelForCandidate(candidate,index);expect(matches).toHaveLength(1);
  const merged=__internal.mergeCandidateWithIntel(candidate,matches);expect(merged.product_intel.graph_only).toBe(true);
  expect(merged.product_intel.freshness.generated_at).toBe(f.packet.source_observed_at);expect(productReadiness(merged,{nowMs:at+2000}).insights).toBe('approved_current_owned');
  const wrong=__internal.mergeCandidateWithIntel({...candidate,market:'JP'},matches);expect(wrong.product_intel).toBeUndefined();
  const human={...candidate,product_intel:{quality_state:'ready',provenance:{reviewer_kind:'human'}}};
  expect(__internal.mergeCandidateWithIntel(human,matches).product_intel).toEqual(human.product_intel);
  const olderHuman={...rows[0],_graph_seller_identity_key:undefined,observed_at:'2020-01-01',product_intel:human.product_intel};
  expect(__internal.mergeCandidateWithIntel(candidate,[...matches,olderHuman]).product_intel).toEqual(human.product_intel);
});

test('capture and transport metadata fields cannot hide nested payloads',()=>{
  for(const [field,value] of [['full_ingredient_list',{raw:'private'}],['formula_sha256','private-response'],['capture_id',{credential:'private'}]]){
    const p=graphFixture().packet;p.source_capture[field]=value;
    expect(()=>h.prepareSellerInsights(p,{nowMs:at})).toThrow('insights_capture_metadata_type');
  }
  const packetArray=graphFixture();packetArray.reviews[0].packet_sha256=[hash('nested payload')];
  expect(()=>h.makeGraphSellerEvidence(packetArray.prepared,packetArray.reviews,{nowMs:at+2000})).toThrow('insights_review_packet');
  const f=graphFixture();f.reviews[0].provider_response_sha256={raw:'private'};
  expect(()=>h.makeGraphSellerEvidence(f.prepared,f.reviews,{nowMs:at+2000})).toThrow('insights_review_response_hash');
});
test('raw public scan includes denied canonical aliases and loader suppresses before seller ranking',async()=>{
  const f=graphFixture();const db=graphPool([],[{kb_key:'arbitrary-legacy-key',analysis:{product_intel:{canonical_product_ref:{sourceProductId:owner.product_id},quality_state:'reject_external'}}}]);
  await expect(h.appendGraphSellerEvidence({...db,records:[f.record],rawSourceBodies:[f.packet.raw_source_body],nowMs:at+2000,apply:true})).rejects.toThrow('insights_graph_protected_existing');
  const scan=db.calls.find(([sql])=>sql.includes('SELECT analysis'));
  for(const alias of ['pivotaSignatureId','productKey','sourceProductId','productId','product_intel,canonical_product_ref'])expect(scan[0]).toContain(alias);
  expect(JSON.parse(scan[1][0])).toEqual(f.record.source.identity);
  const {loadProductIntelKbRows}=require('../../src/auroraBff/productRelationshipGraphSources');const calls=[];
  const queryFn=async(sql,args)=>{calls.push(sql);return sql.includes('to_regclass')?{rows:[{table_name:args[0]}]}:{rows:[]};};
  expect(await loadProductIntelKbRows({queryFn,targetProducts:[{...owner,url:f.packet.source_url}]})).toEqual([]);
  const select=calls.find(sql=>sql.includes('FROM '+h.TABLE));expect(select.indexOf('NOT EXISTS')).toBeLessThan(select.indexOf('ORDER BY source_observed_at'));
  expect(select).toContain('reject_external');expect(select).toContain('pivotaSignatureId');
});

test('raw alternate shapes cannot hide a denied human row behind a benign v1 projection',async()=>{
  const f=graphFixture();const db=graphPool([],[{protected:true,analysis:{product_intel_v1:{quality_state:'draft'},product_intel:{quality_state:'rejected',provenance:{reviewer_kind:'human'}}}}]);
  await expect(h.appendGraphSellerEvidence({...db,records:[f.record],rawSourceBodies:[f.packet.raw_source_body],nowMs:at+2000,apply:true})).rejects.toThrow('insights_graph_protected_existing');
  expect(db.calls.find(([sql])=>sql.includes('SELECT analysis'))[0]).toContain('AS protected');expect(db.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
});

test('explicit candidate denial is preserved even when a reviewed quality state would mask it',async()=>{
  const f=graphFixture();const intel={quality_state:'reviewed',provenance:{review_decision:'reject_external'}};
  const db=graphPool();const original=db.rebindExactListing;db.rebindExactListing=async args=>({...await original(args),product_intel:intel});
  await expect(h.appendGraphSellerEvidence({...db,records:[f.record],rawSourceBodies:[f.packet.raw_source_body],nowMs:at+2000,apply:true})).rejects.toThrow('insights_graph_protected_existing');
  const {__internal}=require('../../src/auroraBff/productRelationshipGraphSources');const candidate={...owner,product_intel:intel};
  const rows=[{...owner,product_intel:h.graphSellerBundle(f.record),_graph_seller_identity_key:f.record.identity_key}];
  expect(__internal.mergeCandidateWithIntel(candidate,rows)).toBe(candidate);
});

test('retailer domain cannot replace reviewed product brand during graph evidence hydration',async()=>{
  const f=graphFixture();expect(h.graphSellerBundle(f.record).canonical_product_ref.brand).toBe('Example');
  const {loadProductIntelKbRows,__internal}=require('../../src/auroraBff/productRelationshipGraphSources');
  const queryFn=async(sql,args)=>sql.includes('to_regclass')?{rows:[{table_name:args[0]===h.TABLE?h.TABLE:null}]}:sql.includes('FROM '+h.TABLE)?{rows:[{evidence_id:f.record.evidence_id,identity_key:f.record.identity_key,source_url:f.record.source.source_url,source_observed_at:f.record.source.source_observed_at,proof:f.record}]}:{rows:[]};
  const candidate={...owner,name:'Example Serum',brand:'Example',url:'https://seller.example/products/serum'};
  const rows=await loadProductIntelKbRows({queryFn,targetProducts:[candidate]});expect(rows[0].brand).toBe('Example');
  expect(__internal.mergeCandidateWithIntel(candidate,__internal.findIntelForCandidate(candidate,__internal.buildIntelIndex(rows))).product_intel.graph_only).toBe(true);
  const missing=graphFixture();delete missing.prepared.source.facts.brand;expect(()=>h.makeGraphSellerEvidence(missing.prepared,missing.reviews,{nowMs:at+2000})).toThrow('insights_graph_brand_evidence_required');
});
