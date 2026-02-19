#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const { query } = require('../src/db');

function norm(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseArgs(argv) {
  const out = {
    suggestions: '',
    feedback: '',
    outJson: 'artifacts/reco_prelabel_quality_report.json',
    outMd: 'artifacts/reco_prelabel_quality_report.md',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    const n = argv[i + 1];
    if (t === '--suggestions' && n) {
      out.suggestions = n;
      i += 1;
      continue;
    }
    if (t === '--feedback' && n) {
      out.feedback = n;
      i += 1;
      continue;
    }
    if (t === '--out-json' && n) {
      out.outJson = n;
      i += 1;
      continue;
    }
    if (t === '--out-md' && n) {
      out.outMd = n;
      i += 1;
      continue;
    }
  }
  return out;
}

async function readJsonOrJsonl(filePath) {
  if (!filePath) return [];
  const text = await fs.readFile(path.resolve(filePath), 'utf8');
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    return Array.isArray(arr) ? arr : [];
  }
  const rows = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      rows.push(JSON.parse(s));
    } catch {
      // skip bad line
    }
  }
  return rows;
}

async function loadFromDbOrFile({ suggestionsPath, feedbackPath }) {
  if (suggestionsPath || feedbackPath) {
    const suggestions = await readJsonOrJsonl(suggestionsPath);
    const feedback = await readJsonOrJsonl(feedbackPath);
    return { suggestions, feedback, source: 'files' };
  }
  try {
    const suggestionsRes = await query(
      `
      SELECT id, anchor_product_id, block, candidate_product_id, suggested_label, confidence, flags, updated_at
      FROM reco_label_suggestions
      ORDER BY updated_at DESC
      LIMIT 50000
      `,
      [],
    );
    const feedbackRes = await query(
      `
      SELECT id, anchor_product_id, block, candidate_product_id, feedback_type, suggestion_id, llm_suggested_label,
             llm_confidence, timestamp_ms
      FROM reco_employee_feedback_events
      ORDER BY timestamp_ms DESC
      LIMIT 50000
      `,
      [],
    );
    return {
      suggestions: Array.isArray(suggestionsRes?.rows) ? suggestionsRes.rows : [],
      feedback: Array.isArray(feedbackRes?.rows) ? feedbackRes.rows : [],
      source: 'database',
    };
  } catch {
    return { suggestions: [], feedback: [], source: 'none' };
  }
}

function buildSuggestionLookup(suggestions) {
  const byId = new Map();
  const byComposite = new Map();
  for (const row of Array.isArray(suggestions) ? suggestions : []) {
    const id = norm(row?.id);
    if (id) byId.set(id, row);
    const key = [
      norm(row?.anchor_product_id),
      norm(row?.block),
      norm(row?.candidate_product_id),
    ].join('::');
    if (key !== '::::') byComposite.set(key, row);
  }
  return { byId, byComposite };
}

function mapFeedbackToPair(feedbackRow, lookup) {
  const suggestionId = norm(feedbackRow?.suggestion_id);
  if (suggestionId && lookup.byId.has(suggestionId)) {
    return { suggestion: lookup.byId.get(suggestionId), feedback: feedbackRow };
  }
  const key = [
    norm(feedbackRow?.anchor_product_id),
    norm(feedbackRow?.block),
    norm(feedbackRow?.candidate_product_id),
  ].join('::');
  if (lookup.byComposite.has(key)) {
    return { suggestion: lookup.byComposite.get(key), feedback: feedbackRow };
  }
  return { suggestion: null, feedback: feedbackRow };
}

function addCount(map, key, delta = 1) {
  map.set(key, (map.get(key) || 0) + delta);
}

function computeMetrics({ suggestions, feedback }) {
  const lookup = buildSuggestionLookup(suggestions);
  const confusionByBlock = {
    competitors: {},
    dupes: {},
    related_products: {},
    unknown: {},
  };
  const accuracyByBlock = {
    competitors: { correct: 0, total: 0 },
    dupes: { correct: 0, total: 0 },
    related_products: { correct: 0, total: 0 },
    unknown: { correct: 0, total: 0 },
  };
  const calibrationBuckets = {
    '0.0-0.2': { correct: 0, total: 0 },
    '0.2-0.4': { correct: 0, total: 0 },
    '0.4-0.6': { correct: 0, total: 0 },
    '0.6-0.8': { correct: 0, total: 0 },
    '0.8-1.0': { correct: 0, total: 0 },
  };
  const flagCounter = new Map();
  let pairedTotal = 0;
  let overturned = 0;

  for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
    for (const flag of Array.isArray(suggestion?.flags) ? suggestion.flags : []) {
      addCount(flagCounter, norm(flag), 1);
    }
  }

  for (const fb of Array.isArray(feedback) ? feedback : []) {
    const pair = mapFeedbackToPair(fb, lookup);
    const suggested = norm(pair.suggestion?.suggested_label || fb?.llm_suggested_label);
    const finalLabel = norm(fb?.feedback_type);
    if (!suggested || !finalLabel) continue;
    pairedTotal += 1;
    const block = norm(pair.suggestion?.block || fb?.block) || 'unknown';
    const blockKey = block === 'competitors' || block === 'dupes' || block === 'related_products' ? block : 'unknown';
    const matrixKey = `${suggested}->${finalLabel}`;
    confusionByBlock[blockKey][matrixKey] = (confusionByBlock[blockKey][matrixKey] || 0) + 1;
    accuracyByBlock[blockKey].total += 1;
    const same = suggested === finalLabel;
    if (same) accuracyByBlock[blockKey].correct += 1;
    if (!same) overturned += 1;

    const conf = toNum(pair.suggestion?.confidence ?? fb?.llm_confidence, null);
    if (conf != null) {
      const c = Math.max(0, Math.min(1, conf));
      let bucket = '0.8-1.0';
      if (c < 0.2) bucket = '0.0-0.2';
      else if (c < 0.4) bucket = '0.2-0.4';
      else if (c < 0.6) bucket = '0.4-0.6';
      else if (c < 0.8) bucket = '0.6-0.8';
      calibrationBuckets[bucket].total += 1;
      if (same) calibrationBuckets[bucket].correct += 1;
    }
  }

  const topFlags = Array.from(flagCounter.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([flag, count]) => ({ flag, count }));

  const accuracy = {};
  for (const [block, row] of Object.entries(accuracyByBlock)) {
    accuracy[block] = row.total > 0 ? Number((row.correct / row.total).toFixed(4)) : null;
  }
  const calibration = {};
  for (const [bucket, row] of Object.entries(calibrationBuckets)) {
    calibration[bucket] = {
      total: row.total,
      accuracy: row.total > 0 ? Number((row.correct / row.total).toFixed(4)) : null,
    };
  }

  return {
    counts: {
      suggestions: Array.isArray(suggestions) ? suggestions.length : 0,
      feedback: Array.isArray(feedback) ? feedback.length : 0,
      paired: pairedTotal,
    },
    confusion_matrix_by_block: confusionByBlock,
    accuracy_by_block: accuracy,
    calibration_by_confidence_bucket: calibration,
    top_flags: topFlags,
    llm_suggestion_overturned_rate: pairedTotal > 0 ? Number((overturned / pairedTotal).toFixed(4)) : null,
  };
}

function renderMd(report) {
  const lines = [];
  lines.push('# Reco Prelabel Quality Report');
  lines.push('');
  lines.push(`- suggestions: ${report.counts.suggestions}`);
  lines.push(`- feedback: ${report.counts.feedback}`);
  lines.push(`- paired: ${report.counts.paired}`);
  lines.push(`- overturned_rate: ${report.llm_suggestion_overturned_rate == null ? 'n/a' : report.llm_suggestion_overturned_rate}`);
  lines.push('');
  lines.push('## Accuracy by Block');
  for (const [block, score] of Object.entries(report.accuracy_by_block || {})) {
    lines.push(`- ${block}: ${score == null ? 'n/a' : score}`);
  }
  lines.push('');
  lines.push('## Top Flags');
  for (const item of report.top_flags || []) {
    lines.push(`- ${item.flag}: ${item.count}`);
  }
  lines.push('');
  lines.push('## Calibration');
  for (const [bucket, row] of Object.entries(report.calibration_by_confidence_bucket || {})) {
    lines.push(`- ${bucket}: total=${row.total}, accuracy=${row.accuracy == null ? 'n/a' : row.accuracy}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = await loadFromDbOrFile({
    suggestionsPath: args.suggestions,
    feedbackPath: args.feedback,
  });
  const metrics = computeMetrics({
    suggestions: loaded.suggestions,
    feedback: loaded.feedback,
  });
  const report = {
    generated_at: new Date().toISOString(),
    source: loaded.source,
    ...metrics,
  };
  await fs.mkdir(path.dirname(path.resolve(args.outJson)), { recursive: true });
  await fs.mkdir(path.dirname(path.resolve(args.outMd)), { recursive: true });
  await fs.writeFile(path.resolve(args.outJson), JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(path.resolve(args.outMd), renderMd(report), 'utf8');
  process.stdout.write(`${JSON.stringify({ ok: true, out_json: args.outJson, out_md: args.outMd })}\n`);
}

main().catch((err) => {
  process.stderr.write(`eval_reco_prelabel_quality failed: ${err?.message || String(err)}\n`);
  process.exit(1);
});
