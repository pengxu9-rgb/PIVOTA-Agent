const fs = require('fs');
const path = require('path');

const latestFeedbackByKey = new Map();

function isoDateKey(d = new Date()) {
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeString(value, fallback = '') {
  const out = String(value == null ? '' : value).trim();
  return out || fallback;
}

function normalizeReasonTags(value) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const token = normalizeString(raw).toLowerCase();
    if (!token) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 12) break;
  }
  return out;
}

function appendJsonlSink({ dir, row }) {
  const outDir = path.resolve(dir);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, `aurora-reco-employee-feedback-${isoDateKey()}.jsonl`);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

function dedupeKey(event) {
  return [
    normalizeString(event.session_id, 'unknown'),
    normalizeString(event.anchor_product_id, 'unknown'),
    normalizeString(event.block, 'unknown'),
    normalizeString(event.candidate_product_id || event.candidate_name, 'unknown'),
  ].join('::');
}

function recordRecoEmployeeFeedback(event, { logger } = {}) {
  const nowIso = new Date().toISOString();
  const normalized = {
    event_name: 'reco_employee_feedback',
    anchor_product_id: normalizeString(event.anchor_product_id),
    block: normalizeString(event.block),
    candidate_product_id: normalizeString(event.candidate_product_id),
    candidate_name: normalizeString(event.candidate_name),
    feedback_type: normalizeString(event.feedback_type),
    wrong_block_target: normalizeString(event.wrong_block_target) || null,
    reason_tags: normalizeReasonTags(event.reason_tags),
    was_exploration_slot: Boolean(event.was_exploration_slot),
    rank_position: Number.isFinite(Number(event.rank_position)) ? Math.max(1, Math.trunc(Number(event.rank_position))) : 1,
    pipeline_version: normalizeString(event.pipeline_version, 'unknown'),
    models: event.models && typeof event.models === 'object' ? event.models : normalizeString(event.models, 'unknown'),
    request_id: normalizeString(event.request_id),
    session_id: normalizeString(event.session_id),
    timestamp: Number.isFinite(Number(event.timestamp)) ? Number(event.timestamp) : Date.now(),
    received_at: nowIso,
  };

  const key = dedupeKey(normalized);
  const prev = latestFeedbackByKey.get(key);
  const samePayload = prev && JSON.stringify(prev.payload) === JSON.stringify(normalized);
  if (!samePayload) {
    latestFeedbackByKey.set(key, {
      payload: normalized,
      updated_at_ms: Date.now(),
    });
  }

  const sinkDir = process.env.AURORA_RECO_EMPLOYEE_FEEDBACK_JSONL_SINK_DIR || process.env.AURORA_EVENTS_JSONL_SINK_DIR;
  const row = {
    source: 'aurora_reco_dogfood',
    event_name: normalized.event_name,
    timestamp_ms: normalized.timestamp,
    serverReceivedAt: nowIso,
    properties: normalized,
  };

  if (sinkDir) {
    try {
      appendJsonlSink({ dir: sinkDir, row });
    } catch (err) {
      logger?.warn?.({ err: err?.message || String(err) }, 'reco employee feedback jsonl sink failed');
    }
  }

  logger?.info?.(
    {
      event_name: 'reco_employee_feedback',
      request_id: normalized.request_id,
      block: normalized.block,
      feedback_type: normalized.feedback_type,
      candidate_product_id: normalized.candidate_product_id,
      was_exploration_slot: normalized.was_exploration_slot,
    },
    'aurora bff: reco employee feedback received',
  );

  return normalized;
}

module.exports = {
  recordRecoEmployeeFeedback,
  __internal: {
    latestFeedbackByKey,
    dedupeKey,
  },
};
