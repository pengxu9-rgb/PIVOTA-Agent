#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const NOISE_REASONS = new Set([
  'blacklisted_category_or_title',
  'non_skincare_category',
  'heuristic_relevance_reject',
  'low_confidence',
  'single_llm_relevance_reject',
]);

const REASON_PRIORITY = {
  product_url_missing: 1000,
  no_candidates: 240,
  ingredient_plan_v2_external_fallback: 180,
};

function parseArgs(argv) {
  const out = { inputPath: '', outPath: '', limit: 25 };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = String(argv[idx] || '').trim();
    if (token === '--input') {
      out.inputPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    } else if (token === '--out') {
      out.outPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    } else if (token === '--limit') {
      const parsed = Number(argv[idx + 1]);
      if (Number.isFinite(parsed) && parsed > 0) out.limit = Math.trunc(parsed);
      idx += 1;
    }
  }
  return out;
}

function normalizePath(value) {
  return String(value || '').trim();
}

function normalizeToken(value) {
  return String(value || '').trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeToken(value);
    if (normalized) return normalized;
  }
  return null;
}

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 25;
  return Math.min(200, Math.trunc(parsed));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function isNoiseReason(reason) {
  return NOISE_REASONS.has(String(reason || '').trim());
}

function inferLane(reason, row) {
  const normalizedReason = String(reason || '').trim();
  if (normalizedReason === 'product_url_missing') return 'create_explicit_product_target';
  if (normalizedReason === 'no_candidates') return 'resolver_or_seed_targeting';
  if (normalizedReason === 'ingredient_plan_v2_external_fallback') {
    const directCaptureMode = String(row?.capture_mode || '').trim();
    const captureModes = Array.isArray(row?.capture_modes)
      ? row.capture_modes
      : row?.capture_modes instanceof Set
      ? [...row.capture_modes]
      : [];
    const hasExecutor =
      directCaptureMode === 'sync_external_executor' ||
      captureModes.includes('sync_external_executor');
    return hasExecutor
      ? 'external_executor_followup'
      : 'external_fallback_review';
  }
  return 'manual_review';
}

function inferAction(reason, row) {
  const normalizedReason = String(reason || '').trim();
  if (normalizedReason === 'product_url_missing') {
    return 'collect official PDP target and create/attach explicit seed';
  }
  if (normalizedReason === 'no_candidates') {
    return 'spot-check resolver query and add stable alias or explicit seed target';
  }
  if (normalizedReason === 'ingredient_plan_v2_external_fallback') {
    const captureMode = String(row?.capture_mode || '').trim();
    return captureMode === 'sync_external_executor'
      ? 'review external executor result and convert winner into official seed'
      : 'review fallback candidate and promote official seed if valid';
  }
  return 'manual review';
}

function buildPriority(reason, seenCount) {
  const base = REASON_PRIORITY[String(reason || '').trim()] || 0;
  const seen = Number.isFinite(Number(seenCount)) ? Number(seenCount) : 0;
  return base + seen;
}

function buildGroupedShortlist(rows, limit = 25) {
  const grouped = new Map();
  for (const rawRow of toArray(rows)) {
    const normalizedQuery = normalizeToken(rawRow?.normalized_query);
    if (!normalizedQuery) continue;
    const reason = firstNonEmpty(rawRow?.last_reason, rawRow?.failure_reason, rawRow?.rejected_reason, 'unknown');
    if (isNoiseReason(reason)) continue;

    const seenCount = Number(rawRow?.seen_count || 0) || 0;
    const current = grouped.get(normalizedQuery) || {
      normalized_query: normalizedQuery,
      query_sample: firstNonEmpty(rawRow?.query_sample),
      ingredient_id: firstNonEmpty(rawRow?.ingredient_id),
      ingredient_name: firstNonEmpty(rawRow?.ingredient_name),
      reasons: new Set(),
      statuses: new Set(),
      sources: new Set(),
      capture_modes: new Set(),
      candidate_urls: new Set(),
      seen_count: 0,
      last_seen_at: firstNonEmpty(rawRow?.last_seen_at),
      priority_score: 0,
    };

    current.seen_count = Math.max(current.seen_count, seenCount);
    current.priority_score = Math.max(current.priority_score, buildPriority(reason, seenCount));
    current.query_sample = current.query_sample || firstNonEmpty(rawRow?.query_sample);
    current.ingredient_id = current.ingredient_id || firstNonEmpty(rawRow?.ingredient_id);
    current.ingredient_name = current.ingredient_name || firstNonEmpty(rawRow?.ingredient_name);
    if (!current.last_seen_at || (rawRow?.last_seen_at && String(rawRow.last_seen_at) > current.last_seen_at)) {
      current.last_seen_at = String(rawRow.last_seen_at || '').trim() || current.last_seen_at;
    }
    current.reasons.add(reason);
    if (firstNonEmpty(rawRow?.status)) current.statuses.add(firstNonEmpty(rawRow?.status));
    if (firstNonEmpty(rawRow?.source)) current.sources.add(firstNonEmpty(rawRow?.source));
    if (firstNonEmpty(rawRow?.capture_mode)) current.capture_modes.add(firstNonEmpty(rawRow?.capture_mode));
    if (firstNonEmpty(rawRow?.candidate_url)) current.candidate_urls.add(firstNonEmpty(rawRow?.candidate_url));
    grouped.set(normalizedQuery, current);
  }

  return [...grouped.values()]
    .map((row) => {
      const primaryReason = [...row.reasons].sort((a, b) => (REASON_PRIORITY[b] || 0) - (REASON_PRIORITY[a] || 0))[0] || 'unknown';
      return {
        normalized_query: row.normalized_query,
        query_sample: row.query_sample || row.normalized_query,
        ingredient_id: row.ingredient_id || null,
        ingredient_name: row.ingredient_name || null,
        primary_reason: primaryReason,
        all_reasons: [...row.reasons],
        status_tokens: [...row.statuses],
        source_tokens: [...row.sources],
        capture_modes: [...row.capture_modes],
        candidate_urls: [...row.candidate_urls],
        query_kind: row.ingredient_id ? 'ingredient_query' : 'product_query',
        operator_lane: inferLane(primaryReason, row),
        recommended_action: inferAction(primaryReason, row),
        seen_count: row.seen_count,
        last_seen_at: row.last_seen_at || null,
        priority_score: row.priority_score,
      };
    })
    .sort((a, b) => b.priority_score - a.priority_score || b.seen_count - a.seen_count)
    .slice(0, clampLimit(limit));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = normalizePath(args.inputPath);
  if (!inputPath) throw new Error('Missing required --input <missing-catalog-products.json>');
  const resolvedInput = path.isAbsolute(inputPath) ? inputPath : path.join(process.cwd(), inputPath);
  const input = JSON.parse(fs.readFileSync(resolvedInput, 'utf8'));
  const rows = toArray(input?.rows);
  const shortlist = buildGroupedShortlist(rows, args.limit);
  const out = {
    generated_at: new Date().toISOString(),
    source_export: resolvedInput,
    total_rows: rows.length,
    shortlist_count: shortlist.length,
    items: shortlist,
  };
  const output = `${JSON.stringify(out, null, 2)}\n`;
  process.stdout.write(output);
  if (args.outPath) {
    const resolvedOut = path.isAbsolute(args.outPath) ? args.outPath : path.join(process.cwd(), args.outPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, output, 'utf8');
  }
}

if (require.main === module) {
  try {
    main();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  _internals: {
    parseArgs,
    buildGroupedShortlist,
    inferLane,
    inferAction,
    isNoiseReason,
  },
};
