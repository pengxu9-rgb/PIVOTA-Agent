#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');

function parseArgs(argv) {
  const out = {
    input: null,
    output: null,
    strict: false,
    schema: path.resolve(__dirname, '../tests/contracts/aurora_chat_envelope.schema.json'),
    csvOutput: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input' && argv[i + 1]) {
      out.input = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === '--output' && argv[i + 1]) {
      out.output = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === '--csv-output' && argv[i + 1]) {
      out.csvOutput = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === '--schema' && argv[i + 1]) {
      out.schema = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (a === '--strict') {
      out.strict = true;
      continue;
    }
  }
  return out;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function looksLikeTreatment(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const bucket = [
    rec.step,
    rec.slot,
    rec.stage,
    rec.category,
    rec.type,
    rec.title,
    rec.name,
    rec.product_name,
    rec.product && rec.product.name,
    rec.sku && rec.sku.name,
    ...(Array.isArray(rec.notes) ? rec.notes : []),
    ...(Array.isArray(rec.reasons) ? rec.reasons : []),
  ]
    .filter((x) => x != null)
    .map((x) => String(x).toLowerCase())
    .join(' | ');
  return /\b(treatment|retinoid|retinol|retinal|adapalene|tretinoin|aha|bha|salicylic|glycolic|lactic|peel|resurfacing)\b/.test(bucket);
}

function looksHighIrritation(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const text = [
    rec.step,
    rec.slot,
    rec.stage,
    rec.category,
    rec.type,
    rec.title,
    rec.name,
    rec.product_name,
    rec.product && rec.product.name,
    rec.sku && rec.sku.name,
    ...(Array.isArray(rec.notes) ? rec.notes : []),
    ...(Array.isArray(rec.reasons) ? rec.reasons : []),
    rec.ingredient,
    rec.ingredients && JSON.stringify(rec.ingredients),
  ]
    .filter((x) => x != null)
    .map((x) => String(x).toLowerCase())
    .join(' | ');
  return /\b(retinoid|retinol|retinal|adapalene|tretinoin|aha|bha|salicylic|glycolic|lactic|mandelic|peel|resurfacing|high[- ]strength)\b/.test(text);
}

function normalizeLevel(v) {
  const token = String(v || '').trim().toLowerCase();
  if (token === 'low' || token === 'medium' || token === 'high') return token;
  return '';
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function collectRecommendationCards(cards) {
  return asArray(cards).filter((c) => c && c.type === 'recommendations');
}

function collectRecommendations(cards) {
  const out = [];
  for (const card of collectRecommendationCards(cards)) {
    const payload = asObject(card.payload) || {};
    const recs = asArray(payload.recommendations);
    for (const rec of recs) out.push(rec);
  }
  return out;
}

function toCsvLine(fields) {
  return fields
    .map((value) => {
      const text = value == null ? '' : String(value);
      if (!/[",\n]/.test(text)) return text;
      return `"${text.replace(/"/g, '""')}"`;
    })
    .join(',');
}

function validateEnvelope({ body, schemaPath }) {
  const violations = [];
  const cards = asArray(body && body.cards);
  const events = asArray(body && body.events);
  const noticeCards = cards.filter((c) => c && c.type === 'confidence_notice');
  const hasNotice = noticeCards.length > 0;

  let hasRenderableCards = false;
  for (const card of cards) {
    if (!card || typeof card !== 'object') continue;
    const type = String(card.type || '').trim().toLowerCase();
    if (!type) continue;
    if (type === 'recommendations') {
      const payload = asObject(card.payload) || {};
      if (asArray(payload.recommendations).length > 0) hasRenderableCards = true;
      continue;
    }
    if (type === 'confidence_notice') {
      const payload = asObject(card.payload) || {};
      if (String(payload.reason || '').trim() && asArray(payload.actions).length > 0) hasRenderableCards = true;
      continue;
    }
    hasRenderableCards = true;
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const validate = ajv.compile(schema);
  const schemaOk = Boolean(validate(body));
  if (!schemaOk) {
    for (const err of asArray(validate.errors)) {
      violations.push({
        code: 'schema_violation',
        message: `${err.instancePath || '/'} ${err.message || 'invalid'}`,
      });
    }
  }

  if (cards.length === 0 && !hasNotice) {
    violations.push({
      code: 'empty_cards_without_notice',
      message: 'cards is empty and confidence_notice is missing',
    });
  }

  if (!hasRenderableCards && !hasNotice) {
    violations.push({
      code: 'no_renderable_cards_without_notice',
      message: 'response has no renderable cards and no confidence_notice',
    });
  }

  let noticeWithoutActionsCount = 0;
  for (const card of noticeCards) {
    const payload = asObject(card.payload) || {};
    if (asArray(payload.actions).length === 0) {
      noticeWithoutActionsCount += 1;
      violations.push({
        code: 'notice_without_actions',
        message: `confidence_notice(${payload.reason || 'unknown'}) must include actions`,
      });
    }
  }

  const hasSafetyBlock = noticeCards.some((card) => {
    const payload = asObject(card.payload) || {};
    return String(payload.reason || '').trim().toLowerCase() === 'safety_block';
  });
  const recommendationCards = collectRecommendationCards(cards);
  const hasRecommendations = recommendationCards.some((card) => {
    const payload = asObject(card.payload) || {};
    return asArray(payload.recommendations).length > 0;
  });
  if (hasSafetyBlock && hasRecommendations) {
    violations.push({
      code: 'safety_block_with_recommendations',
      message: 'safety_block must not return recommendations',
    });
  }

  let lowOrMedium = false;
  for (const card of noticeCards) {
    const payload = asObject(card.payload) || {};
    const reason = String(payload.reason || '').trim().toLowerCase();
    if (reason === 'low_confidence') lowOrMedium = true;
    const level = normalizeLevel(payload.confidence && payload.confidence.level);
    const score = toNum(payload.confidence && payload.confidence.score);
    if (level === 'low' || level === 'medium') lowOrMedium = true;
    if (score != null && score <= 0.75) lowOrMedium = true;
  }
  for (const card of cards) {
    const payload = asObject(card && card.payload);
    if (!payload) continue;
    const level = normalizeLevel(payload.confidence && payload.confidence.level);
    const score = toNum(payload.confidence && payload.confidence.score);
    if (level === 'low' || level === 'medium') lowOrMedium = true;
    if (score != null && score <= 0.75) lowOrMedium = true;
    const recLevel = normalizeLevel(payload.recommendation_confidence_level);
    if (recLevel === 'low' || recLevel === 'medium') lowOrMedium = true;
  }
  for (const evt of events) {
    const data = asObject(evt && evt.data) || {};
    if (String(evt && evt.event_name || '').trim() !== 'recos_requested') continue;
    if (data.low_confidence === true) lowOrMedium = true;
    const evtLevel = normalizeLevel(data.confidence_level);
    if (evtLevel === 'low' || evtLevel === 'medium') lowOrMedium = true;
    const evtScore = toNum(data.confidence_score);
    if (evtScore != null && evtScore <= 0.75) lowOrMedium = true;
  }

  const recommendations = collectRecommendations(cards);
  let lowMedLeakCount = 0;
  if (lowOrMedium && recommendations.length > 0) {
    for (const rec of recommendations) {
      if (looksLikeTreatment(rec) || looksHighIrritation(rec)) {
        lowMedLeakCount += 1;
      }
    }
    if (lowMedLeakCount > 0) {
      violations.push({
        code: 'low_medium_treatment_leak',
        message: `detected ${lowMedLeakCount} treatment/high-irritation recommendation(s) under low/medium confidence`,
      });
    }
  }

  const hasTimeoutDegraded = noticeCards.some((card) => {
    const payload = asObject(card.payload) || {};
    return String(payload.reason || '').trim().toLowerCase() === 'timeout_degraded';
  });
  const hasRecoOutputGuardFallback = events.some((evt) => String(evt && evt.event_name || '').trim() === 'reco_output_guard_fallback');

  return {
    ok: violations.length === 0,
    schema_ok: schemaOk,
    invariants_ok: violations.filter((v) => v.code !== 'schema_violation').length === 0,
    stats: {
      cards_count: cards.length,
      confidence_notice_count: noticeCards.length,
      recommendations_count: recommendations.length,
      has_timeout_degraded: hasTimeoutDegraded,
      has_reco_output_guard_fallback: hasRecoOutputGuardFallback,
      has_safety_block: hasSafetyBlock,
      has_recommendations: hasRecommendations,
      low_or_medium_context: lowOrMedium,
      notice_without_actions_count: noticeWithoutActionsCount,
      low_medium_treatment_leak_count: lowMedLeakCount,
      empty_cards_without_notice: cards.length === 0 && !hasNotice,
    },
    violations,
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    console.error('Usage: node tools/validate_envelope.js --input <response.json> [--output <summary.json>] [--csv-output <summary.csv>] [--strict]');
    process.exit(2);
  }

  let body = null;
  try {
    body = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  } catch (err) {
    const out = {
      ok: false,
      schema_ok: false,
      invariants_ok: false,
      stats: {
        cards_count: 0,
        confidence_notice_count: 0,
        recommendations_count: 0,
        has_timeout_degraded: false,
        has_reco_output_guard_fallback: false,
        has_safety_block: false,
        has_recommendations: false,
        low_or_medium_context: false,
        notice_without_actions_count: 0,
        low_medium_treatment_leak_count: 0,
        empty_cards_without_notice: true,
      },
      violations: [{ code: 'json_parse_failed', message: err && err.message ? err.message : 'invalid json' }],
    };
    const payload = `${JSON.stringify(out, null, 2)}\n`;
    if (args.output) fs.writeFileSync(args.output, payload, 'utf8');
    process.stdout.write(payload);
    process.exit(args.strict ? 1 : 0);
  }

  const result = validateEnvelope({ body, schemaPath: args.schema });
  const payload = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) fs.writeFileSync(args.output, payload, 'utf8');

  if (args.csvOutput) {
    const header = [
      'ok',
      'schema_ok',
      'invariants_ok',
      'cards_count',
      'confidence_notice_count',
      'recommendations_count',
      'has_timeout_degraded',
      'has_reco_output_guard_fallback',
      'has_safety_block',
      'has_recommendations',
      'low_or_medium_context',
      'notice_without_actions_count',
      'low_medium_treatment_leak_count',
      'empty_cards_without_notice',
      'violations',
    ];
    const line = [
      result.ok,
      result.schema_ok,
      result.invariants_ok,
      result.stats.cards_count,
      result.stats.confidence_notice_count,
      result.stats.recommendations_count,
      result.stats.has_timeout_degraded,
      result.stats.has_reco_output_guard_fallback,
      result.stats.has_safety_block,
      result.stats.has_recommendations,
      result.stats.low_or_medium_context,
      result.stats.notice_without_actions_count,
      result.stats.low_medium_treatment_leak_count,
      result.stats.empty_cards_without_notice,
      result.violations.map((v) => v.code).join('|'),
    ];
    fs.writeFileSync(args.csvOutput, `${toCsvLine(header)}\n${toCsvLine(line)}\n`, 'utf8');
  }

  process.stdout.write(payload);
  if (args.strict && !result.ok) process.exit(1);
}

main();
