const fs = require('node:fs');

const { query } = require('../db');

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function parseNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;
  const text = normalizeString(value, 40).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function parseTimestamp(value) {
  const text = normalizeString(value, 100);
  if (!text) return null;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function ensureJsonSerializable(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function readJsonArtifact(filePath) {
  const text = normalizeString(filePath, 2000);
  if (!text) return null;
  try {
    return JSON.parse(fs.readFileSync(text, 'utf8'));
  } catch {
    return null;
  }
}

function parseJsonText(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stepById(summary, id) {
  return Array.isArray(summary?.steps) ? summary.steps.find((step) => step && step.id === id) : null;
}

function readStepJson(summary, id, artifactPath) {
  const fromArtifact = readJsonArtifact(artifactPath);
  if (fromArtifact) return fromArtifact;
  const step = stepById(summary, id);
  return parseJsonText(step?.stdout_tail);
}

function maxTimestamp(values) {
  const times = values
    .map((value) => new Date(value || '').getTime())
    .filter((value) => Number.isFinite(value));
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

function completedAt(summary) {
  const stepTimes = Array.isArray(summary?.steps)
    ? summary.steps.map((step) => step?.completed_at)
    : [];
  return maxTimestamp([...stepTimes, summary?.generated_at]);
}

function deriveStatus(summary = {}) {
  if (summary.skipped) return 'skipped';
  if (summary.ok === true) return 'passed';
  if (summary.ok === false) return 'failed';
  return 'unknown';
}

function readRoutineArtifactsFromSummary(summary = {}) {
  const routineSummaryPath = summary?.artifacts?.routine_summary;
  const routine = readJsonArtifact(routineSummaryPath)
    || readStepJson(summary, 'relationship_graph_routine', routineSummaryPath)
    || {};
  const build = readStepJson(routine, 'build', routine?.artifacts?.build);
  const review = readStepJson(routine, 'ai_review', routine?.artifacts?.review);
  const servingAudit = readStepJson(routine, 'serving_guard_audit', routine?.artifacts?.serving_audit);
  return { routine, build, review, servingAudit };
}

function artifactSummary(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.summary && typeof value.summary === 'object' && !Array.isArray(value.summary)) {
      return value.summary;
    }
  }
  return value || {};
}

function extractRelationshipGraphRunRecord(summary = {}, {
  runKind = 'sync_routine',
  trigger = '',
  parentRunId = null,
} = {}) {
  const selector = readStepJson(
    summary,
    'affected_product_selector',
    summary?.artifacts?.affected_product_selector || summary?.artifacts?.affected_products,
  ) || {};
  const { routine, build, review, servingAudit } = readRoutineArtifactsFromSummary(summary);
  const buildSummary = artifactSummary(build);
  const reviewSummary = artifactSummary(review);
  const options = summary.options || {};
  const routineOptions = routine.options || {};
  const selectorOptions = options.selector || {};
  const selectorSources = Array.isArray(selectorOptions.sources)
    ? selectorOptions.sources
    : (Array.isArray(selector?.selection?.sources) ? selector.selection.sources : []);
  const dbLock = routine.db_lock || {};
  const generatedAt = parseTimestamp(summary.generated_at) || new Date().toISOString();

  return {
    run_id: normalizeString(summary.run_id || routine.run_id, 180),
    run_kind: normalizeString(runKind, 80) || 'sync_routine',
    trigger: normalizeString(trigger, 120),
    parent_run_id: parentRunId ? normalizeString(parentRunId, 180) : null,
    routine_run_id: normalizeString(routine.run_id, 180) || null,
    market: normalizeString(options.market || routineOptions.market, 24).toUpperCase() || 'US',
    status: deriveStatus(summary),
    dry_run: parseBoolean(options.dry_run, true),
    apply_sync: parseBoolean(options.apply_sync, false),
    apply_build: parseBoolean(options.apply_build || routineOptions.apply_build, false),
    apply_review: parseBoolean(options.apply_review || routineOptions.apply_review, false),
    cutoff: parseTimestamp(options.cutoff || routineOptions.cutoff),
    selector_updated_since: parseTimestamp(selectorOptions.updated_since || selector?.selection?.updated_since),
    selector_sources: selectorSources.map((source) => normalizeString(source, 120)).filter(Boolean),
    selector_limit: parseNumber(selectorOptions.limit != null ? selectorOptions.limit : selector?.selection?.limit),
    affected_count: parseNumber(selector.affected_count),
    anchor_count: parseNumber(buildSummary?.anchor_count),
    edge_count: parseNumber(buildSummary?.edge_count),
    rejected_count: parseNumber(buildSummary?.rejected_count),
    reviewed_count: parseNumber(reviewSummary?.reviewed_count),
    approved_count: parseNumber(reviewSummary?.approved_count),
    review_rejected_count: parseNumber(reviewSummary?.rejected_count),
    applied_count: parseNumber(
      (parseNumber(buildSummary?.applied_count, 0) || 0) + (parseNumber(reviewSummary?.applied_count, 0) || 0),
    ),
    serving_total_rows: parseNumber(servingAudit?.total_rows),
    serving_safe_rows: parseNumber(servingAudit?.safe_rows),
    serving_suppressed_rows: parseNumber(servingAudit?.suppressed_rows),
    serving_suppressed_pct: parseNumber(servingAudit?.suppressed_pct),
    db_lock_requested: parseBoolean(options.db_lock || routineOptions.db_lock || dbLock.requested, false),
    db_lock_acquired: parseBoolean(dbLock.acquired, false),
    failed_step: normalizeString(summary.failed_step, 180) || null,
    out_dir: normalizeString(summary.out_dir, 2000),
    summary_path: normalizeString(summary.summary_path || summary?.artifacts?.summary, 2000),
    summary: ensureJsonSerializable(summary) || {},
    generated_at: generatedAt,
    completed_at: completedAt(summary),
  };
}

async function recordRelationshipGraphRun(summary, {
  runKind = 'sync_routine',
  trigger = '',
  parentRunId = null,
  queryFn = query,
} = {}) {
  const record = extractRelationshipGraphRunRecord(summary, { runKind, trigger, parentRunId });
  if (!record.run_id) {
    throw new Error('relationship graph run ledger requires summary.run_id');
  }

  await queryFn(
    `
      INSERT INTO relationship_graph_routine_runs (
        run_id,
        run_kind,
        trigger,
        parent_run_id,
        routine_run_id,
        market,
        status,
        dry_run,
        apply_sync,
        apply_build,
        apply_review,
        cutoff,
        selector_updated_since,
        selector_sources,
        selector_limit,
        affected_count,
        anchor_count,
        edge_count,
        rejected_count,
        reviewed_count,
        approved_count,
        review_rejected_count,
        applied_count,
        serving_total_rows,
        serving_safe_rows,
        serving_suppressed_rows,
        serving_suppressed_pct,
        db_lock_requested,
        db_lock_acquired,
        failed_step,
        out_dir,
        summary_path,
        summary,
        generated_at,
        completed_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14::text[], $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
        $31, $32, $33::jsonb, $34, $35
      )
      ON CONFLICT (run_id) DO UPDATE SET
        run_kind = EXCLUDED.run_kind,
        trigger = EXCLUDED.trigger,
        parent_run_id = EXCLUDED.parent_run_id,
        routine_run_id = EXCLUDED.routine_run_id,
        market = EXCLUDED.market,
        status = EXCLUDED.status,
        dry_run = EXCLUDED.dry_run,
        apply_sync = EXCLUDED.apply_sync,
        apply_build = EXCLUDED.apply_build,
        apply_review = EXCLUDED.apply_review,
        cutoff = EXCLUDED.cutoff,
        selector_updated_since = EXCLUDED.selector_updated_since,
        selector_sources = EXCLUDED.selector_sources,
        selector_limit = EXCLUDED.selector_limit,
        affected_count = EXCLUDED.affected_count,
        anchor_count = EXCLUDED.anchor_count,
        edge_count = EXCLUDED.edge_count,
        rejected_count = EXCLUDED.rejected_count,
        reviewed_count = EXCLUDED.reviewed_count,
        approved_count = EXCLUDED.approved_count,
        review_rejected_count = EXCLUDED.review_rejected_count,
        applied_count = EXCLUDED.applied_count,
        serving_total_rows = EXCLUDED.serving_total_rows,
        serving_safe_rows = EXCLUDED.serving_safe_rows,
        serving_suppressed_rows = EXCLUDED.serving_suppressed_rows,
        serving_suppressed_pct = EXCLUDED.serving_suppressed_pct,
        db_lock_requested = EXCLUDED.db_lock_requested,
        db_lock_acquired = EXCLUDED.db_lock_acquired,
        failed_step = EXCLUDED.failed_step,
        out_dir = EXCLUDED.out_dir,
        summary_path = EXCLUDED.summary_path,
        summary = EXCLUDED.summary,
        generated_at = EXCLUDED.generated_at,
        completed_at = EXCLUDED.completed_at,
        updated_at = now()
    `,
    [
      record.run_id,
      record.run_kind,
      record.trigger,
      record.parent_run_id,
      record.routine_run_id,
      record.market,
      record.status,
      record.dry_run,
      record.apply_sync,
      record.apply_build,
      record.apply_review,
      record.cutoff,
      record.selector_updated_since,
      record.selector_sources,
      record.selector_limit,
      record.affected_count,
      record.anchor_count,
      record.edge_count,
      record.rejected_count,
      record.reviewed_count,
      record.approved_count,
      record.review_rejected_count,
      record.applied_count,
      record.serving_total_rows,
      record.serving_safe_rows,
      record.serving_suppressed_rows,
      record.serving_suppressed_pct,
      record.db_lock_requested,
      record.db_lock_acquired,
      record.failed_step,
      record.out_dir,
      record.summary_path,
      JSON.stringify(record.summary),
      record.generated_at,
      record.completed_at,
    ],
  );

  return record;
}

module.exports = {
  extractRelationshipGraphRunRecord,
  recordRelationshipGraphRun,
};
