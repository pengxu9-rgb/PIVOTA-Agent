'use strict';

const { randomUUID } = require('node:crypto');

const graph = require('../auroraBff/productRelationshipGraph');
const reviewer = require('../../scripts/review-relationship-candidate-labels');
const writer = require('../../scripts/build-product-relationship-graph');
const { evidenceFingerprint, hasValidConsensusApproval } = require('./relationshipCrossAgentReview');
const { DEFAULT_MAX_ANCHORS_PER_CANDIDATE } = require('../auroraBff/relationshipFanIn');
const qualityAudit = require('./relationshipGraphQualityAudit');

function qualityGatePassed(report) {
  const baseline = report?.arms?.baseline;
  const expanded = report?.arms?.expanded;
  const audit = expanded?.approval_model_audit;
  if (report?.status !== 'completed' || report.writes !== 0 || report.product_facts_exported !== false ||
      !Number.isInteger(expanded?.anchors) || expanded.anchors < 1 || expanded.anchors > 10 ||
      baseline?.anchors !== expanded.anchors || !expanded.anchor_facts_fingerprint ||
      baseline.anchor_facts_fingerprint !== expanded.anchor_facts_fingerprint) return false;
  for (const arm of [baseline, expanded]) {
    const a = arm.approval_model_audit;
    if (!a || !['total', 'useful', 'incorrect', 'uncertain', 'unreviewed', 'adjudicated'].every(k => Number.isInteger(a[k]) && a[k] >= 0) ||
        a.total !== arm.consensus?.approved || a.total !== a.useful + a.incorrect + a.uncertain + a.unreviewed ||
        a.adjudicated !== a.useful + a.incorrect || a.adjudicated !== a.total || a.uncertain !== 0 || a.unreviewed !== 0) return false;
    if (arm.model_audited_useful_approved_yield_per_anchor !== a.useful / arm.anchors ||
        !Number.isInteger(arm.anchors_with_model_audited_useful_approval) ||
        arm.anchors_with_model_audited_useful_approval < 0 || arm.anchors_with_model_audited_useful_approval > Math.min(arm.anchors, a.useful) ||
        arm.useful_approval_anchor_coverage !== arm.anchors_with_model_audited_useful_approval / arm.anchors) return false;
  }
  return audit.total > 0 && audit.useful / audit.total >= 0.95 && expanded.bad_variants_in_approvals === 0 &&
    expanded.model_audited_useful_approved_yield_per_anchor > baseline.model_audited_useful_approved_yield_per_anchor &&
    expanded.useful_approval_anchor_coverage >= baseline.useful_approval_anchor_coverage;
}

function publishablePairs(pairs, cap = 12, pins = {}) {
  if (!Number.isInteger(cap) || cap < 1 || cap > 12 || !Array.isArray(pairs) || pairs.length > 35) throw new Error('REVIEWED_UPDATE_SCOPE');
  const result = [];
  const identities = new Set();
  for (const pair of pairs) {
    if (pair.sampled !== true) throw new Error('REVIEWED_UPDATE_UNSAMPLED');
    if (!pair.arms?.includes('expanded') || pair.consensus?.verdict !== 'approve' || !pair.auditComplete || pair.audit?.assessment !== 'useful') continue;
    const edge = graph.coerceRelationshipEdge(pair.row);
    const kind = edge.relation_type === 'dupe' ? 'dupe' : edge.relation_type === 'competitive_alternative' ? 'alternative' : null;
    const facts = qualityAudit.blindedFacts(reviewer.buildEvidence(edge, new Map()), edge);
    if (pair.audit_facts_fingerprint !== qualityAudit.factsFingerprint(facts) ||
        qualityAudit.factsFingerprint(pair.blind) !== pair.audit_facts_fingerprint ||
        new Set(pair.auditReviews?.map(r => r.provider)).size !== 2) throw new Error('REVIEWED_UPDATE_AUDIT_BINDING');
    for (const audit of pair.auditReviews || []) {
      if (!['openai', 'gemini'].includes(audit.provider) || audit.model !== pins[`audit_${audit.provider}`]) throw new Error('REVIEWED_UPDATE_AUDIT_IDENTITY');
      qualityAudit.validateAudit(qualityAudit.auditSchema().parse(audit.decision), facts);
    }
    if (!kind || pair.audit.expected_kind !== kind || pair.auditReviews?.length !== 2 || pair.auditReviews.some(r => r?.error ||
        r?.decision?.assessment !== 'useful' || r.decision.confidence < 0.90 ||
        (r.decision.expected_kind === 'substitute' ? 'alternative' : r.decision.expected_kind) !== kind) ||
        !hasValidConsensusApproval(edge, pair.consensus.cross_agent_review) ||
        reviewer.servingGuardReasonsIfApproved(edge, { allowDupeAiApproval: true }).length) throw new Error('REVIEWED_UPDATE_APPROVAL');
    const key = JSON.stringify([edge.market, edge.anchor_type, edge.anchor_ref.toLowerCase(), edge.candidate_product_ref.toLowerCase(), edge.relation_type]);
    if (identities.has(key)) throw new Error('REVIEWED_UPDATE_DUPLICATE');
    result.push(pair); identities.add(key);
  }
  if (result.length > cap) throw new Error('REVIEWED_UPDATE_CAP');
  return result;
}

// Models finish on a frozen read-only snapshot before this boundary. No model
// request or product-fact export occurs here. All writes use existing fan-in,
// human precedence, exact revision and evidence guards.
async function applyReviewedComparison({ report, pairs, client, cap = 12, enabled = false,
  runId = randomUUID(),
  persist = writer.persistEdgesWithGlobalFanInCap, applyApproval = reviewer.applyApproval } = {}) {
  const receipt = { schema: 'relgraph.reviewed_update.v1', status: 'not_applied', quality_gate_passed: qualityGatePassed(report),
    staged_writes: 0, approval_writes: 0, visible_approved_edges: 0, protected_or_changed: 0,
    staged_ids: [], approved_ids: [], approval_attempt_ids: [], current_ai_approved_ids: [],
    product_facts_exported: false, model_calls: 0, approval_commit_confirmed: false,
    approval_commit_attempted: false, writes_unknown: false, reconciliation_complete: true };
  if (!enabled || !receipt.quality_gate_passed) return receipt;
  if (report.model_work?.sampled_packets !== pairs?.length || pairs?.some(p => p.sampled !== true)) throw new Error('REVIEWED_UPDATE_SAMPLE');
  if (pairs.some(p => typeof p.key !== 'string' || !p.key) || new Set(pairs.map(p => p.key)).size !== pairs.length) throw new Error('REVIEWED_UPDATE_DUPLICATE');
  for (const arm of ['baseline', 'expanded']) {
    const members = pairs.filter(p => p.arms?.includes(arm));
    const approvals = members.filter(p => p.consensus?.verdict === 'approve');
    const useful = approvals.filter(p => p.auditComplete && p.audit?.assessment === 'useful');
    const anchors = new Set(useful.map(p => p.row.anchor_ref));
    if (report.arms[arm].sampled_proposals !== members.length || report.arms[arm].consensus.approved !== approvals.length ||
        report.arms[arm].approval_model_audit.useful !== useful.length ||
        report.arms[arm].anchors_with_model_audited_useful_approval !== anchors.size) throw new Error('REVIEWED_UPDATE_REPORT_BINDING');
  }
  const approved = publishablePairs(pairs, cap, report.metadata?.model_pins);
  if (!client || typeof client.query !== 'function') throw new Error('REVIEWED_UPDATE_CLIENT');
  if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw new Error('REVIEWED_UPDATE_RUN_ID');
  receipt.run_id = runId;
  const queryFn = (sql, values) => client.query(sql, values);
  let approvalTransaction = false;
  const appliedIds = [];
  const reconciled = async () => {
    const rows = (await queryFn(`SELECT id, label_state, provenance FROM relationship_candidate_labels
      WHERE provenance->>'reviewed_update_run_id' = $1 LIMIT 13`, [runId])).rows || [];
    if (rows.length > cap) throw new Error('REVIEWED_UPDATE_SCOPE');
    receipt.staged_ids = [...new Set([...receipt.staged_ids, ...rows.map(row => row.id)])];
    receipt.staged_writes = receipt.staged_ids.length;
    receipt.current_ai_approved_ids = rows.filter(row => row.label_state === 'ai_approved' &&
      row.provenance?.ai_review?.cross_agent_review?.verdict === 'approve').map(row => row.id);
    receipt.approved_ids = receipt.approval_commit_confirmed ? appliedIds : receipt.current_ai_approved_ids;
    receipt.approval_writes = receipt.approved_ids.length;
    if (receipt.approved_ids.length) {
      const visible = (await queryFn(`SELECT e.* FROM product_relationship_edges e
        JOIN relationship_candidate_labels l ON l.id = e.id
        WHERE l.id = ANY($1::text[])`, [receipt.approved_ids])).rows || [];
      receipt.visible_approved_edges = visible.filter(graph.isRelationshipEdgeServingSafe).length;
    }
  };
  try {
    await persist({ edges: approved.map(p => ({ ...p.row, provenance: { ...p.row.provenance, reviewed_update_run_id: runId } })), market: 'US', cap: DEFAULT_MAX_ANCHORS_PER_CANDIDATE,
      queryFn, runInClient: async fn => fn(client), classify: () => ({ label_state: 'generated' }) });
    await reconciled();
    await queryFn('BEGIN'); approvalTransaction = true;
    await queryFn("SET LOCAL statement_timeout = '30000'");
    await queryFn("SET LOCAL lock_timeout = '5000'");
    for (const pair of approved) {
      const edge = graph.coerceRelationshipEdge(pair.row);
      const rows = (await queryFn(`SELECT *, updated_at::text AS review_row_version FROM relationship_candidate_labels
        WHERE market = $1 AND anchor_type = $2 AND lower(anchor_ref) = lower($3)
        AND lower(candidate_product_ref) = lower($4) AND relation_type = $5`,
      [edge.market, edge.anchor_type, edge.anchor_ref, edge.candidate_product_ref, edge.relation_type])).rows;
      const row = rows?.[0];
      if (rows?.length !== 1 || row.label_state !== 'generated' || row.provenance?.reviewed_update_run_id !== runId ||
          !receipt.staged_ids.includes(row.id) || evidenceFingerprint(graph.coerceRelationshipEdge(row)) !== evidenceFingerprint(edge)) {
        receipt.protected_or_changed += 1; continue;
      }
      const evidence = reviewer.buildEvidence(row, new Map());
      receipt.approval_attempt_ids.push(row.id);
      const applied = await applyApproval(row, pair.consensus, queryFn, { allowDupeAiApproval: true,
        minApprovalConfidence: 0.90, evidence, requireConsensus: true });
      if (applied) appliedIds.push(row.id);
      else receipt.protected_or_changed += 1;
    }
    receipt.approval_commit_attempted = true;
    await queryFn('COMMIT'); approvalTransaction = false;
    receipt.approval_commit_confirmed = true;
    await reconciled();
    if (receipt.approved_ids.length) {
      receipt.status = receipt.visible_approved_edges === receipt.approval_writes ? 'applied_verified' : 'applied_serving_incomplete';
    } else receipt.status = 'no_approval_writes';
  } catch {
    // Preserve already committed work for reconciliation instead of claiming a
    // zero-write failure. The caller records this receipt even on partial apply.
    if (approvalTransaction) { try { await queryFn('ROLLBACK'); } catch {} }
    if (receipt.approval_commit_attempted && !receipt.approval_commit_confirmed) receipt.writes_unknown = true;
    try { await reconciled(); } catch { receipt.reconciliation_complete = false; receipt.writes_unknown = true; }
    receipt.status = 'failed_partial';
  }
  return receipt;
}

module.exports = { qualityGatePassed, publishablePairs, applyReviewedComparison };
