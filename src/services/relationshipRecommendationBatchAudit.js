'use strict';
const crypto = require('node:crypto');
const { getRelationshipEdgeServingSuppressionReasons } = require('../auroraBff/productRelationshipGraph');
const { __internal: { inferRelationship } } = require('../auroraBff/productRelationshipGraphBuilder');

const MAX_BATCH = 10000;
const KINDS = new Set(['dupe', 'alternative', 'substitute', 'complement', 'specialist', 'variant', 'none', 'unknown']);
const ASSESSMENTS = new Set(['useful', 'incorrect', 'uncertain', 'unreviewed']);
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function fingerprint(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function batchDecisions(review) {
  const durable=review?.recommendation_review_batch;
  if (durable?.complete===false) throw new Error('Stored review batch is incomplete');
  const decisions = durable?.decisions || review?.decisions;
  if (!Array.isArray(decisions)) throw new Error('Exact review decisions are missing; a time window or approval count is not a batch identity');
  if (review?.summary?.reviewed_count!=null && Number(review.summary.reviewed_count)!==decisions.length) throw new Error('Review artifact is incomplete');
  const selected = decisions.filter(row => row.applied === true && row.verdict === 'approve' && row.new_label_state === 'ai_approved');
  const appliedCount=durable?.applied_approval_count ?? review?.summary?.approved_applied_count ??
    (review?.summary?.applied_count==null ? null : Number(review.summary.applied_count)-decisions.filter(row=>row.applied===true && row.verdict==='guard_blocked').length);
  if (appliedCount!=null && Number(appliedCount)!==selected.length) throw new Error('Applied approval count does not match exact identities');
  if (selected.length > MAX_BATCH) throw new Error(`Batch exceeds ${MAX_BATCH} identities`);
  const ids = new Set();
  for (const row of selected) {
    if (typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)) throw new Error('Missing or duplicate applied approval identity');
    ids.add(row.id);
  }
  return selected;
}
function batchScope(batch) {
  return {
    run_id: batch.run_id,
    snapshot_semantics: batch.snapshot_semantics,
    applied_approval_ids: batch.applied_approval_ids,
    batch_count: batch.batch_count,
    exported_count: batch.exported_count,
    complete: batch.complete,
    missing_ids: batch.missing_ids,
    exported_rows: batch.edges.map(edge => ({
      id: edge.id,
      snapshot_fingerprint: edge.snapshot_fingerprint,
      batch_decision: edge.batch_decision,
    })),
  };
}
function storedKind(edge) {
  return ({dupe:'dupe',competitive_alternative:'alternative',related_product:'complement',niche_specialist:'specialist'})[edge.relation_type] || 'unknown';
}
function brand(snapshot) { const raw = snapshot?.brand || snapshot?.brand_name; return String(typeof raw === 'object' ? raw?.name : raw || 'unknown').trim().toLowerCase(); }
function exportRows(decisions, rows, {runId = null, exportedAt = new Date().toISOString()} = {}) {
  const ids = new Set(decisions.map(row=>row.id));
  const byId = new Map();
  for (const row of rows) {
    if (!ids.has(row.id) || byId.has(row.id)) throw new Error('Export returned an unexpected or duplicate identity');
    byId.set(row.id, row);
  }
  const edges = decisions.filter(row=>byId.has(row.id)).map(decision=> {
    const row = byId.get(decision.id);
    const inferred = inferRelationship(row.anchor_snapshot || {}, row.candidate_snapshot || {}, {
      ...row.candidate_snapshot, ...row.score_breakdown, similarity_score:row.score_total,
      curated_pair_evidence:row.provenance?.curated_pair_evidence || row.candidate_snapshot?.curated_pair_evidence,
    });
    return { ...row, snapshot_fingerprint:fingerprint(row), batch_decision:decision,
      audit_hints:{ serving_suppression_reasons:getRelationshipEdgeServingSuppressionReasons(row),
        proposed_relation_type:inferred.relation_type, proposal_is_not_independent_assessment:true } };
  });
  const batch = {schema_version:'relgraph_batch_export.v1',run_id:runId,exported_at:exportedAt,
    applied_approval_ids:decisions.map(row=>row.id),
    snapshot_semantics:'current_rows_not_immutable_approval_time_snapshots',
    batch_count:decisions.length,exported_count:edges.length,complete:edges.length===decisions.length,
    missing_ids:decisions.filter(row=>!byId.has(row.id)).map(row=>row.id),edges};
  batch.batch_scope_fingerprint = fingerprint(batchScope(batch));
  return batch;
}
function reviewTemplate(batch) {
  return {schema_version:'relgraph_independent_quality_labels.v1',assessor:'',method:'independent_review',
    batch_scope_fingerprint:batch.batch_scope_fingerprint,
    labels:batch.edges.map(edge=>({id:edge.id,snapshot_fingerprint:edge.snapshot_fingerprint,
      assessment:'unreviewed',expected_kind:'unknown',notes:''}))};
}
function bucket() { return {total:0,useful:0,incorrect:0,uncertain:0,unreviewed:0}; }
function finalize(value) {
  const adjudicated=value.useful+value.incorrect;
  return {...value,adjudicated_count:adjudicated,observed_useful_precision:adjudicated ? value.useful/adjudicated : null,
    adjudicated_coverage:value.total ? adjudicated/value.total : 0};
}
function evaluateBatch(batch, independent = {}) {
  if (batch.schema_version!=='relgraph_batch_export.v1') throw new Error('Expected a full batch export');
  if (!Array.isArray(batch.edges) || !Array.isArray(batch.missing_ids) || batch.exported_count!==batch.edges.length ||
      batch.batch_count!==batch.edges.length+batch.missing_ids.length || batch.complete!==(batch.missing_ids.length===0)) throw new Error('Invalid batch completeness metadata');
  if (!Array.isArray(batch.applied_approval_ids) || batch.applied_approval_ids.length !== batch.batch_count ||
      new Set(batch.applied_approval_ids).size !== batch.batch_count ||
      batch.applied_approval_ids.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Invalid applied approval identities');
  const memberIds = [...batch.edges.map(edge => edge.id), ...batch.missing_ids];
  if (new Set(memberIds).size !== batch.batch_count ||
      memberIds.some(id => !batch.applied_approval_ids.includes(id))) throw new Error('Export membership differs from the full applied batch');
  const seen=new Set();
  for (const edge of batch.edges) {
    if (!edge.id || seen.has(edge.id)) throw new Error('Duplicate or missing exported identity');
    seen.add(edge.id);
    const {snapshot_fingerprint,batch_decision,audit_hints,...row}=edge;
    if (fingerprint(row)!==snapshot_fingerprint) throw new Error(`Modified exported snapshot for ${edge.id}`);
  }
  if (fingerprint(batchScope(batch)) !== batch.batch_scope_fingerprint) throw new Error('Modified batch scope or completeness metadata');
  const labels = independent.labels || [];
  if (labels.length && independent.batch_scope_fingerprint !== batch.batch_scope_fingerprint) throw new Error('Independent labels belong to a different batch scope');
  if (labels.some(row=>row.assessment!=='unreviewed') && (!String(independent.assessor||'').trim() ||
      !['human_review','independent_review'].includes(independent.method))) throw new Error('Independent assessor and method required; model approval is not quality precision');
  const byId = new Map(); const edges = new Map(batch.edges.map(edge=>[edge.id,edge]));
  for (const row of labels) {
    const edge=edges.get(row.id);
    if (!edge || byId.has(row.id)) throw new Error('Independent labels contain unknown or duplicate identities');
    if (row.snapshot_fingerprint!==edge.snapshot_fingerprint) throw new Error(`Stale independent label for ${row.id}`);
    if (!ASSESSMENTS.has(row.assessment) || !KINDS.has(row.expected_kind)) throw new Error('Invalid independent assessment or kind');
    if (row.assessment==='useful' && ['variant','none','unknown'].includes(row.expected_kind)) throw new Error('A useful recommendation must identify a useful relationship kind');
    if (row.assessment!=='unreviewed' && !String(row.notes||'').trim()) throw new Error('Independent assessment needs review notes');
    byId.set(row.id,row);
  }
  const total=bucket(); const groups={by_stored_kind:{},by_expected_kind:{},by_anchor_brand:{},by_candidate_brand:{},by_cross_brand:{}};
  const confusion={}; const reviewQueue=[];
  for (const edge of batch.edges) {
    const label=byId.get(edge.id) || {assessment:'unreviewed',expected_kind:'unknown'};
    total.total++; total[label.assessment]++;
    const keys=[storedKind(edge),label.expected_kind,brand(edge.anchor_snapshot),brand(edge.candidate_snapshot),
      brand(edge.anchor_snapshot)==='unknown'||brand(edge.candidate_snapshot)==='unknown'?'unknown':brand(edge.anchor_snapshot)!==brand(edge.candidate_snapshot)?'cross_brand':'same_brand'];
    Object.keys(groups).forEach((name,index)=>{const group=groups[name][keys[index]] ||= bucket(); group.total++;group[label.assessment]++;});
    if (['useful','incorrect'].includes(label.assessment)) {
      const key=`${storedKind(edge)}->${label.expected_kind}`; confusion[key]=(confusion[key]||0)+1;
    }
    if (label.assessment==='incorrect') reviewQueue.push({id:edge.id,expected_label_state:edge.label_state,
      expected_updated_at:edge.updated_at_revision || edge.updated_at,snapshot_fingerprint:edge.snapshot_fingerprint,
      expected_kind:label.expected_kind,notes:label.notes,
      action:label.expected_kind==='variant'?'review_ai_variant_retirement':'review_original_identity_and_generate_separate_correct_relation',
      human_approved_protected:edge.label_state==='human_approved',apply:false});
  }
  return {schema_version:'relgraph_batch_quality.v1',run_id:batch.run_id,complete_batch:batch.complete,
    batch_count:batch.batch_count,missing_ids:batch.missing_ids,exported_count:batch.edges.length,
    batch_scope_fingerprint:batch.batch_scope_fingerprint,
    snapshot_semantics:batch.snapshot_semantics,assessor:independent.assessor || null,method:independent.method || null,
    summary:finalize(total),...Object.fromEntries(Object.entries(groups).map(([name,rows])=>[name,Object.fromEntries(Object.entries(rows).map(([key,value])=>[key,finalize(value)]))])),
    relation_confusion_matrix:confusion,remediation_review_queue:reviewQueue,
    limits:['Observed precision covers adjudicated exported rows only; uncertain, missing and unreviewed rows are not counted as useful.',
      'Current-row exports do not establish historical approval-time precision; independent labels are bound to the export fingerprint.',
      'Heuristic hints and model verdicts are not independent quality labels. No label writes or relation identity changes are performed.']};
}
module.exports={MAX_BATCH,batchDecisions,exportRows,reviewTemplate,evaluateBatch,fingerprint,batchScope};
