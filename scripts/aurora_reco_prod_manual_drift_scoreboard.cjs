#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const tokens = Array.isArray(argv) ? argv : [];
  const startIndex = tokens[0] && String(tokens[0]).startsWith('--') ? 0 : 2;
  const out = {};
  for (let i = startIndex; i < tokens.length; i += 1) {
    const cur = String(tokens[i] || '');
    if (!cur.startsWith('--')) continue;
    const key = cur.slice(2);
    const next = String(tokens[i + 1] || '');
    if (!next || next.startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function nowTag() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function uniqStrings(values = []) {
  return Array.from(new Set(asArray(values).map((value) => String(value || '').trim()).filter(Boolean)));
}

function pickCard(cards, type) {
  const expected = String(type || '').trim().toLowerCase();
  return asArray(cards).find((card) => asString(card && card.type).trim().toLowerCase() === expected) || null;
}

function sortStrings(values = []) {
  return uniqStrings(values).sort((left, right) => left.localeCompare(right));
}

function arraysEqual(left = [], right = []) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function buildCaseRowMap(report = null) {
  return new Map(
    asArray(report && report.cases).map((row) => [String(row && row.case_id), row]),
  );
}

function extractSnapshot(rawRow = null, caseRow = null) {
  const raw = asObject(rawRow) || {};
  const body = asObject(asObject(raw.chat)?.body) || {};
  const cards = asArray(body.cards);
  const recoCard = pickCard(cards, 'recommendations');
  const confidenceCard = pickCard(cards, 'confidence_notice');
  const payload = asObject(recoCard && recoCard.payload) || {};
  const meta = asObject(payload.recommendation_meta) || {};
  const finalSelection = asObject(meta.final_selection) || {};
  const recos = asArray(payload.recommendations);
  const summary = asObject(caseRow && caseRow.summary) || {};
  const rankedTargets = asArray(meta.ranked_targets);
  const assistantMessage = asObject(body.assistant_message) || null;
  const assistantText = asString(assistantMessage && assistantMessage.content);
  return {
    case_id: String(raw.case_id || caseRow?.case_id || ''),
    title: asString(raw.title || caseRow?.title),
    status: Number.isFinite(Number(asObject(raw.chat)?.status)) ? Number(asObject(raw.chat).status) : null,
    commit: asString(summary.x_service_commit || asObject(asObject(raw.chat)?.headers)?.xServiceCommit) || null,
    card_types: cards.map((card) => asString(card && card.type)).filter(Boolean),
    confidence_notice_reason: asString(asObject(confidenceCard && confidenceCard.payload)?.reason) || null,
    recommendations_count: recos.length,
    recommendation_product_ids: recos
      .map((row) => asString(row && (row.product_id || row.productId)).trim())
      .filter(Boolean),
    recommendation_titles: recos
      .map((row) => asString(row && (row.display_name || row.name || row.title)).trim())
      .filter(Boolean),
    matched_role_ids: uniqStrings(
      recos.map((row) => row && (row.matched_role_id || row.role_scope || row.matchedRoleId)),
    ),
    source_mode: asString(meta.source_mode) || null,
    query_source: asString(meta.query_source) || null,
    mainline_status: asString(meta.mainline_status) || null,
    primary_target_id: asString(meta.primary_target_id) || null,
    displayed_target_ids: uniqStrings(meta.displayed_target_ids),
    selected_target_ids: uniqStrings(meta.selected_target_ids),
    ranked_target_ids: uniqStrings(
      rankedTargets.map((target) => target && target.target_id),
    ),
    selection_signature: asString(meta.selection_signature || finalSelection.selection_signature) || null,
    assistant_present: Boolean(assistantText),
    assistant_text: assistantText || null,
    assistant_quality_flags: sortStrings(summary.assistant_quality_flags),
    assistant_rewrite_llm_used: meta.assistant_rewrite_llm_used === true,
    assistant_rewrite_reason: asString(meta.assistant_rewrite_reason) || null,
    llm_selector_used: meta.llm_selector_used === true,
    selector_winner_source: asString(meta.selector_winner_source) || null,
    products_with_reviewed_insights: Number.isFinite(Number(summary.products_with_reviewed_insights))
      ? Number(summary.products_with_reviewed_insights)
      : null,
  };
}

function detectPlannerDrift(before, after) {
  return (
    before.primary_target_id !== after.primary_target_id
    || !arraysEqual(before.selected_target_ids, after.selected_target_ids)
    || !arraysEqual(before.ranked_target_ids, after.ranked_target_ids)
  );
}

function detectRecallDrift(before, after) {
  return (
    before.recommendations_count !== after.recommendations_count
    || before.confidence_notice_reason !== after.confidence_notice_reason
    || before.source_mode !== after.source_mode
    || before.query_source !== after.query_source
    || before.mainline_status !== after.mainline_status
  );
}

function detectSelectionDrift(before, after) {
  return (
    !arraysEqual(before.recommendation_product_ids, after.recommendation_product_ids)
    || !arraysEqual(before.matched_role_ids, after.matched_role_ids)
    || before.selection_signature !== after.selection_signature
    || before.llm_selector_used !== after.llm_selector_used
    || before.selector_winner_source !== after.selector_winner_source
  );
}

function detectRewriteDrift(before, after) {
  return (
    before.assistant_present !== after.assistant_present
    || before.assistant_rewrite_llm_used !== after.assistant_rewrite_llm_used
    || before.assistant_rewrite_reason !== after.assistant_rewrite_reason
    || !arraysEqual(before.assistant_quality_flags, after.assistant_quality_flags)
  );
}

function detectRuntimeDrift(before, after) {
  const beforeStatus = Number(before.status || 0);
  const afterStatus = Number(after.status || 0);
  const before5xx = beforeStatus >= 500;
  const after5xx = afterStatus >= 500;
  return beforeStatus !== afterStatus || before5xx || after5xx;
}

function classifyLikelyRootCause(before, after, classes) {
  if (classes.includes('runtime')) return 'runtime_instability';
  if (classes.includes('planner')) return 'semantic_plan_shift';
  if (
    classes.includes('recall')
    && after.recommendations_count === 0
    && (after.confidence_notice_reason === 'weak_viable_pool' || after.confidence_notice_reason === 'no_recall_from_planned_sources')
  ) {
    return after.confidence_notice_reason;
  }
  if (
    classes.includes('rewrite')
    && after.assistant_present === false
    && after.assistant_rewrite_reason
  ) {
    return `rewrite_${String(after.assistant_rewrite_reason).toLowerCase()}`;
  }
  if (classes.includes('selection')) return 'selection_shift';
  if (classes.includes('recall')) return 'candidate_pool_shift';
  if (classes.includes('rewrite')) return 'assistant_rewrite_shift';
  return 'stable';
}

function compareCase(before, after) {
  const driftClasses = [];
  if (detectRuntimeDrift(before, after)) driftClasses.push('runtime');
  if (detectPlannerDrift(before, after)) driftClasses.push('planner');
  if (detectRecallDrift(before, after)) driftClasses.push('recall');
  if (detectSelectionDrift(before, after)) driftClasses.push('selection');
  if (detectRewriteDrift(before, after)) driftClasses.push('rewrite');
  return {
    case_id: after.case_id || before.case_id,
    title: after.title || before.title,
    drift_classes: driftClasses,
    likely_root_cause: classifyLikelyRootCause(before, after, driftClasses),
    before: {
      commit: before.commit,
      status: before.status,
      recommendations_count: before.recommendations_count,
      confidence_notice_reason: before.confidence_notice_reason,
      primary_target_id: before.primary_target_id,
      selected_target_ids: before.selected_target_ids,
      recommendation_titles: before.recommendation_titles,
      assistant_present: before.assistant_present,
      assistant_rewrite_reason: before.assistant_rewrite_reason,
      assistant_quality_flags: before.assistant_quality_flags,
    },
    after: {
      commit: after.commit,
      status: after.status,
      recommendations_count: after.recommendations_count,
      confidence_notice_reason: after.confidence_notice_reason,
      primary_target_id: after.primary_target_id,
      selected_target_ids: after.selected_target_ids,
      recommendation_titles: after.recommendation_titles,
      assistant_present: after.assistant_present,
      assistant_rewrite_reason: after.assistant_rewrite_reason,
      assistant_quality_flags: after.assistant_quality_flags,
    },
  };
}

function compareReports(beforeReport = null, afterReport = null) {
  const beforeCaseRows = buildCaseRowMap(beforeReport);
  const afterCaseRows = buildCaseRowMap(afterReport);
  const beforeRawRows = new Map(asArray(beforeReport && beforeReport.raw).map((row) => [String(row && row.case_id), row]));
  const afterRawRows = new Map(asArray(afterReport && afterReport.raw).map((row) => [String(row && row.case_id), row]));
  const caseIds = sortStrings([
    ...beforeRawRows.keys(),
    ...afterRawRows.keys(),
  ]);
  const perCase = [];
  const summary = {
    total_cases: caseIds.length,
    changed_cases: 0,
    stable_cases: 0,
    environment_changed: false,
    before_commit_set: sortStrings(asArray(beforeReport && beforeReport.cases).map((row) => row?.summary?.x_service_commit)),
    after_commit_set: sortStrings(asArray(afterReport && afterReport.cases).map((row) => row?.summary?.x_service_commit)),
    by_drift_class: {
      runtime: 0,
      planner: 0,
      recall: 0,
      selection: 0,
      rewrite: 0,
    },
    likely_root_causes: {},
  };
  summary.environment_changed = !arraysEqual(summary.before_commit_set, summary.after_commit_set);
  for (const caseId of caseIds) {
    const before = extractSnapshot(beforeRawRows.get(caseId), beforeCaseRows.get(caseId));
    const after = extractSnapshot(afterRawRows.get(caseId), afterCaseRows.get(caseId));
    const compared = compareCase(before, after);
    if (compared.drift_classes.length > 0) {
      summary.changed_cases += 1;
      for (const driftClass of compared.drift_classes) {
        summary.by_drift_class[driftClass] += 1;
      }
      const root = String(compared.likely_root_cause || 'stable');
      summary.likely_root_causes[root] = (summary.likely_root_causes[root] || 0) + 1;
    } else {
      summary.stable_cases += 1;
    }
    perCase.push(compared);
  }
  return {
    compared_at: new Date().toISOString(),
    before_report: asString(beforeReport && beforeReport.started_at) || null,
    after_report: asString(afterReport && afterReport.started_at) || null,
    summary,
    per_case: perCase,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const beforePath = asString(args.before).trim();
  const afterPath = asString(args.after).trim();
  if (!beforePath || !afterPath) {
    throw new Error('Usage: aurora_reco_prod_manual_drift_scoreboard --before <report.json> --after <report.json> [--out <path>]');
  }
  const beforeReport = loadJson(beforePath);
  const afterReport = loadJson(afterPath);
  const result = compareReports(beforeReport, afterReport);
  const outPath = asString(args.out).trim()
    || path.join(
      process.cwd(),
      'reports',
      `aurora_reco_prod_manual_drift_scoreboard_${nowTag()}.json`,
    );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`Drift scoreboard saved: ${outPath}`);
  console.log(JSON.stringify(result.summary, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('aurora_reco_prod_manual_drift_scoreboard failed:', err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  compareReports,
  compareCase,
  detectPlannerDrift,
  detectRecallDrift,
  detectRewriteDrift,
  detectRuntimeDrift,
  detectSelectionDrift,
  extractSnapshot,
  parseArgs,
};
