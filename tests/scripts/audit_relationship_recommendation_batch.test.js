const {batchDecisions,exportRows,reviewTemplate,evaluateBatch,fingerprint,batchScope}=require('../../src/services/relationshipRecommendationBatchAudit');
const {exportBatch}=require('../../scripts/audit-relationship-recommendation-batch');
const decisions=['a','b','c','d'].map(id=>({id,verdict:'approve',applied:true,new_label_state:'ai_approved'}));
const row=(id,other={})=>({id,anchor_type:'product',anchor_ref:'product:anchor',candidate_product_ref:`product:${id}`,
  relation_type:'competitive_alternative',label_state:'ai_approved',market:'US',updated_at:'2026-10-01T11:00:00.000Z',
  anchor_snapshot:{brand:'Luxury',title:'Hydrating Barrier Face Cream',category:'face cream'},
  candidate_snapshot:{brand:'Value',title:'Rich Recovery Face Cream',category:'face cream'},...other});
const batch=()=>exportRows(decisions,decisions.map(d=>row(d.id)),{runId:'run_fixture'});
function independent(exported,states) {return {assessor:'Independent reviewer',method:'human_review',batch_scope_fingerprint:exported.batch_scope_fingerprint,labels:exported.edges.map((edge,i)=>({id:edge.id,snapshot_fingerprint:edge.snapshot_fingerprint,
  assessment:states[i],expected_kind:states[i]==='incorrect'?'variant':states[i]==='useful'?'alternative':'unknown',notes:states[i]==='unreviewed'?'':'Reviewed complete supplied product facts.'}))};}
test('model confidence and unapplied approvals cannot count as independent useful precision',()=>{
  expect(batchDecisions({decisions:[...decisions,{id:'dry',verdict:'approve',applied:false,new_label_state:'ai_approved'}]})).toHaveLength(4);
  const report=evaluateBatch(batch());expect(report.summary).toMatchObject({useful:0,unreviewed:4,observed_useful_precision:null,adjudicated_coverage:0});
  expect(reviewTemplate(batch()).labels.every(label=>label.assessment==='unreviewed')).toBe(true);
});
test('precision excludes unknowns and reports coverage, brand/kind distribution and confusion',()=>{
  const exported=batch();const report=evaluateBatch(exported,independent(exported,['useful','incorrect','uncertain','unreviewed']));
  expect(report.summary).toMatchObject({total:4,useful:1,incorrect:1,uncertain:1,unreviewed:1,observed_useful_precision:.5,adjudicated_coverage:.5});
  expect(report.by_candidate_brand.value.observed_useful_precision).toBe(.5);
  expect(report.by_anchor_brand.luxury.total).toBe(4);expect(report.by_cross_brand.cross_brand.total).toBe(4);
  expect(report.relation_confusion_matrix).toEqual({'alternative->alternative':1,'alternative->variant':1});
  expect(report.remediation_review_queue).toEqual([expect.objectContaining({id:'b',apply:false,action:'review_ai_variant_retirement'})]);
});
test('changed snapshots or stale/foreign/duplicate labels cannot silently enter the quality denominator',()=>{
  const exported=batch();const labels=independent(exported,['useful','incorrect','uncertain','unreviewed']);
  expect(()=>evaluateBatch(exported,{...labels,labels:[...labels.labels,labels.labels[0]]})).toThrow(/duplicate/);
  expect(()=>evaluateBatch(exported,{...labels,labels:[{...labels.labels[0],id:'foreign'}]})).toThrow(/unknown/);
  expect(()=>evaluateBatch(exported,{...labels,labels:[{...labels.labels[0],snapshot_fingerprint:'stale'}]})).toThrow(/Stale/);
  exported.edges[0].candidate_snapshot.title='Edited title';expect(()=>evaluateBatch(exported,labels)).toThrow(/Modified/);
});
test('missing exported rows remain incomplete, not counted as reviewed or useful',()=>{
  const exported=exportRows(decisions,[row('a')]);const report=evaluateBatch(exported);
  expect(report).toMatchObject({complete_batch:false,batch_count:4,exported_count:1,missing_ids:['b','c','d']});
  expect(report.summary.observed_useful_precision).toBeNull();
});
test('export is bounded and only queries exact applied review IDs, not newest rows or a time window',async()=>{
  const query=jest.fn(async(sql,params)=>({rows:params[0].map(id=>row(id))}));
  const result=await exportBatch(query,{decisions},{runId:'fixture',chunkSize:2});
  expect(result.complete).toBe(true);expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls.map(call=>call[1][0])).toEqual([['a','b'],['c','d']]);
  expect(query.mock.calls[0][0]).toMatch(/WHERE id=ANY/);
  await expect(exportBatch(query,{decisions},{chunkSize:0})).rejects.toThrow(/chunk size/);
  expect(()=>batchDecisions({summary:{approved_count:135}})).toThrow(/Exact/);
  expect(()=>batchDecisions({decisions:[decisions[0],decisions[0]]})).toThrow(/duplicate/);
});
test('human-approved incorrect edges are review-only and stay explicitly protected',()=>{
  const exported=exportRows([decisions[0]],[row('a',{label_state:'human_approved'})]);
  const report=evaluateBatch(exported,independent(exported,['incorrect']));
  expect(report.remediation_review_queue[0]).toMatchObject({human_approved_protected:true,apply:false,expected_label_state:'human_approved'});
});
test('guard-block writes do not masquerade as applied approvals and truncated artifacts fail closed',()=>{
  const guard={id:'guard',verdict:'guard_blocked',applied:true,new_label_state:'needs_evidence'};
  expect(batchDecisions({summary:{reviewed_count:2,applied_count:2},decisions:[decisions[0],guard]})).toEqual([decisions[0]]);
  expect(()=>batchDecisions({summary:{reviewed_count:135},decisions:[decisions[0]]})).toThrow(/incomplete/);
  expect(()=>batchDecisions({recommendation_review_batch:{complete:false,decisions}})).toThrow(/incomplete/);
});

test('deleting an incorrect edge and its label cannot inflate complete-batch precision',()=>{
  const exported=batch();
  const labels=independent(exported,['useful','incorrect','uncertain','unreviewed']);
  const truncated=JSON.parse(JSON.stringify(exported));
  truncated.edges.splice(1,1);
  truncated.batch_count=3;truncated.exported_count=3;
  const truncatedLabels={...labels,labels:labels.labels.filter(label=>label.id!=='b')};
  expect(()=>evaluateBatch(truncated,truncatedLabels)).toThrow(/identities|membership|scope/);
  truncated.applied_approval_ids=truncated.applied_approval_ids.filter(id=>id!=='b');
  expect(()=>evaluateBatch(truncated,truncatedLabels)).toThrow(/scope/);
  truncated.batch_scope_fingerprint=fingerprint(batchScope(truncated));
  expect(()=>evaluateBatch(truncated,truncatedLabels)).toThrow(/different batch scope/);
  expect(()=>evaluateBatch(exported,{...labels,batch_scope_fingerprint:'stale'})).toThrow(/batch scope/);
  const partial={...labels,labels:[labels.labels[0]]};
  expect(evaluateBatch(exported,partial).summary).toMatchObject({total:4,useful:1,unreviewed:3,adjudicated_coverage:.25});
});
