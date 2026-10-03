'use strict';
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {execFileSync}=require('node:child_process');
const {Client}=require('pg');
const { coerceRelationshipEdge } = require('../../src/auroraBff/productRelationshipGraph');
const { combineReviews } = require('../../src/services/relationshipCrossAgentReview');
const reviewer = require('../../scripts/review-relationship-candidate-labels');
const audit = require('../../src/services/relationshipGraphQualityAudit');
const update = require('../../src/services/relationshipGraphReviewedUpdate');
const clone = value => JSON.parse(JSON.stringify(value));
const pins = { consensus_openai: 'gpt-4.1', consensus_gemini: 'gemini-3-flash-preview', audit_openai: 'gpt-5.4', audit_gemini: 'gemini-2.5-pro' };
function packet(key = 'one') {
  const description = 'Barrier face cream for daily facial moisture with ceramides and glycerin.';
  const inci = 'Water, Glycerin, Squalane, Ceramide NP, Peptide, Phenoxyethanol';
  const a = { product_id: 'a', title: 'Barrier Peptide Face Cream', brand: 'Luxury', category: 'face cream', description, ingredient_text: inci, price: 50, price_currency: 'USD' };
  const row = coerceRelationshipEdge({ id: key, edge_id: `edge-${key}`, anchor_type: 'product', anchor_ref: 'product:a', candidate_product_ref: `product:${key}`,
    anchor_snapshot: a, candidate_snapshot: { ...a, product_id: key, brand: 'Value', price: 20 }, relation_type: 'competitive_alternative',
    market: 'US', vertical: 'beauty', category_taxonomy: ['face cream'], use_case: 'face cream', score_total: .9,
    score_breakdown: { category_use_case_match: .9 }, evidence_grade: 'B', label_state: 'generated',
    price_evidence: { anchor_price_amount: 50, candidate_price_amount: 20, anchor_price_currency: 'USD', candidate_price_currency: 'USD', price_ratio: .4, observed_at: new Date().toISOString() },
    source_refs: [{ type: 'catalog_products', authoritative: true }], provenance: { generated_at: new Date().toISOString() } });
  const decision = { verdict: 'approve', confidence: .95, relationship_kind: 'alternative', rationale: 'Both grounded descriptions establish the same facial moisture job.',
    shared_evidence: [{ anchor_fact: description, candidate_fact: description }], ...reviewer.consumerCopyForKind('alternative') };
  const consensus = combineReviews(row, ['openai', 'gemini'].map(provider => ({ provider, model: pins[`consensus_${provider}`], decision })));
  const blind = audit.blindedFacts(reviewer.buildEvidence(row, new Map()), row);
  const auditReviews = ['openai', 'gemini'].map(provider => ({ provider, model: pins[`audit_${provider}`], decision: { assessment: 'useful', expected_kind: 'alternative', confidence: .95,
    rationale: 'Both exact supplied descriptions establish the same facial moisture job.', shared_evidence: [{ product_a_fact: description, product_b_fact: description }] } }));
  return { key, sampled: true, arms: ['expanded'], row, consensus, auditComplete: true, audit: { assessment: 'useful', expected_kind: 'alternative' }, auditReviews,
    blind, audit_facts_fingerprint: audit.factsFingerprint(blind) };
}
function report(pairs) {
  const arm = name => {
    const members = pairs.filter(p => p.arms.includes(name)); const approved = members.filter(p => p.consensus.verdict === 'approve');
    const useful = approved.filter(p => p.audit?.assessment === 'useful'); const anchors = new Set(useful.map(p => p.row.anchor_ref)).size;
    return { anchors: 2, anchor_facts_fingerprint: 'same-frozen-anchors', sampled_proposals: members.length, consensus: { approved: approved.length },
      approval_model_audit: { total: approved.length, useful: useful.length, incorrect: approved.length - useful.length, uncertain: 0, unreviewed: 0, adjudicated: approved.length },
      bad_variants_in_approvals: 0, model_audited_useful_approved_yield_per_anchor: useful.length / 2,
      anchors_with_model_audited_useful_approval: anchors, useful_approval_anchor_coverage: anchors / 2 };
  };
  return { status: 'completed', writes: 0, product_facts_exported: false, metadata: { model_pins: pins },
    model_work: { sampled_packets: pairs.length }, arms: { baseline: arm('baseline'), expanded: arm('expanded') } };
}

// Ambient database URLs are never read: always initialize a private local server.
const pgDescribe=process.env.RELGRAPH_TEST_POSTGRES==='1'?describe:describe.skip;
pgDescribe('audited graph publication on an isolated fresh local server',()=>{
 let dir,client,started=false;
 const bin=process.env.RELGRAPH_TEST_POSTGRES_BIN||'/opt/homebrew/opt/postgresql@15/bin';
 const run=(cmd,args)=>execFileSync(path.join(bin,cmd),args,{env:{...process.env,LANG:'C',LC_ALL:'C'},stdio:'pipe'});
 beforeAll(async()=>{
  const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
  dir=fs.mkdtempSync('/tmp/relgraph-reviewed-update-private-');
  run('initdb',['-D',dir,'-A','trust','--no-locale','--encoding=UTF8']);
  run('pg_ctl',['-D',dir,'-l',path.join(dir,'server.log'),'-o',`-p ${port} -h 127.0.0.1 -F`,'-w','start']);started=true;
  client=new Client({host:'127.0.0.1',port,database:'postgres'});await client.connect();
 },30000);
 afterAll(async()=>{try{if(client)await client.end();}finally{if(started)run('pg_ctl',['-D',dir,'-m','immediate','-w','stop']);if(dir)fs.rmSync(dir,{recursive:true,force:true});}});
 let schemaIndex=0;
 beforeEach(async()=>{
  const schema=`reviewed_update_fixture_${++schemaIndex}`;
  await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path TO ${schema}`);
  for(const number of ['046','048','050','051']){const file=fs.readdirSync(path.join(__dirname,'../../src/db/migrations')).find(n=>n.startsWith(number+'_'));await client.query(fs.readFileSync(path.join(__dirname,'../../src/db/migrations',file),'utf8'));}
 });
 const q=(sql,args)=>client.query(sql,args);
 test('audited alternative actually serves when label id differs from edge id',async()=>{
  const p=packet();await require('../../src/auroraBff/productRelationshipGraph').upsertRelationshipCandidateLabel({...p.row,id:'legacy-label-id',edge_id:'legacy-edge-id',label_state:'generated'},{queryFn:q});
  const r=await update.applyReviewedComparison({report:report([p]),pairs:[p],client,enabled:true});
  expect(r).toMatchObject({status:'applied_verified',staged_writes:1,approval_writes:1,visible_approved_edges:1});
  const row=(await q('SELECT id,edge_id,label_state,provenance FROM relationship_candidate_labels')).rows[0];
  expect(row.id).not.toBe(row.edge_id);expect(row.label_state).toBe('ai_approved');expect(row.provenance.ai_review.cross_agent_review).toEqual(p.consensus.cross_agent_review);
 });
 test('existing human approval remains unchanged despite all model approvals',async()=>{
  const p=packet();await require('../../src/auroraBff/productRelationshipGraph').upsertRelationshipCandidateLabel({...p.row,label_state:'human_approved'},{queryFn:q});
  const before=(await q('SELECT * FROM relationship_candidate_labels')).rows;
  const r=await update.applyReviewedComparison({report:report([p]),pairs:[p],client,enabled:true});expect(r.approval_writes).toBe(0);expect(r.staged_writes).toBe(0);expect((await q('SELECT * FROM relationship_candidate_labels')).rows).toEqual(before);
 });
 test('existing generated candidate skipped by fan-in writer cannot be promoted',async()=>{
  const p=packet();await require('../../src/auroraBff/productRelationshipGraph').upsertRelationshipCandidateLabel({...p.row,label_state:'generated'},{queryFn:q});
  const r=await update.applyReviewedComparison({report:report([p]),pairs:[p],client,enabled:true,persist:async()=>({written:0,dropped:[p.row]})});
  expect(r.approval_writes).toBe(0);expect(r.protected_or_changed).toBe(1);expect((await q('SELECT label_state FROM relationship_candidate_labels')).rows[0].label_state).toBe('generated');
 });
});
