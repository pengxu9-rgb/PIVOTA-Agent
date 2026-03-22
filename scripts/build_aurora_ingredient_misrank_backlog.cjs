#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { LOCAL_INGREDIENT_RECALL_REGISTRY } = require('../src/services/ingredientRecallRegistry');

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function normalizeText(value) {
  return normalizeNonEmptyString(value).toLowerCase();
}

function parseArgs(argv) {
  const out = {
    inputs: [],
    outPath: '',
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = normalizeNonEmptyString(argv[idx]);
    if (token === '--input') {
      const value = normalizeNonEmptyString(argv[idx + 1]);
      if (value) out.inputs.push(value);
      idx += 1;
    } else if (token === '--out') {
      out.outPath = normalizeNonEmptyString(argv[idx + 1]);
      idx += 1;
    }
  }
  return out;
}

function resolvePathMaybeRelative(targetPath) {
  if (!targetPath) return '';
  return path.isAbsolute(targetPath) ? targetPath : path.join(process.cwd(), targetPath);
}

function readJsonSafe(targetPath) {
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    return null;
  }
}

function countPhraseMatches(text, phrases) {
  const normalized = normalizeText(text);
  if (!normalized) return 0;
  let hits = 0;
  for (const phrase of Array.isArray(phrases) ? phrases : []) {
    const needle = normalizeText(phrase);
    if (!needle) continue;
    if (normalized.includes(needle)) hits += 1;
  }
  return hits;
}

function collectConflictingIngredientIds(text, currentIngredientId) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const ids = [];
  for (const profile of Object.values(LOCAL_INGREDIENT_RECALL_REGISTRY)) {
    const ingredientId = normalizeNonEmptyString(profile?.ingredient_id);
    if (!ingredientId || ingredientId === currentIngredientId) continue;
    const hits =
      countPhraseMatches(normalized, profile?.exact_phrases) +
      countPhraseMatches(normalized, profile?.alias_phrases);
    if (hits > 0) ids.push(ingredientId);
  }
  return Array.from(new Set(ids));
}

function summarizeReasons(entries) {
  const out = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const reason of Array.isArray(entry?.misrank_reasons) ? entry.misrank_reasons : []) {
      out[reason] = Number(out[reason] || 0) + 1;
    }
  }
  return out;
}

function buildMisrankEntry(row, sourceFile) {
  if (!row || row.root_cause_bucket !== 'direct_hit') return null;
  if (normalizeNonEmptyString(row.query_source) !== 'agent_products_ingredient_recall_direct') return null;

  const ingredientId = normalizeNonEmptyString(row.ingredient_id);
  const ranked = Array.isArray(row.ranked_samples) ? row.ranked_samples : [];
  const topProducts = Array.isArray(row.top_products) ? row.top_products : [];
  const leadRanked = ranked[0] || null;
  const leadTop = topProducts[0] || null;
  const titleText = [
    leadRanked?.title,
    leadTop?.name,
  ].map(normalizeNonEmptyString).filter(Boolean).join(' ');
  const urlText = [
    leadRanked?.candidate_url,
    leadTop?.url,
  ].map(normalizeNonEmptyString).filter(Boolean).join(' ');
  const combinedText = `${titleText} ${urlText}`.trim();
  const conflictingIngredientIds = collectConflictingIngredientIds(combinedText, ingredientId);
  const reasons = [];

  const surfaceExplicitHits = Number(leadRanked?.surface_explicit_hits || 0);
  const strongTargetAnchorHits = Number(leadRanked?.strong_target_anchor_hits || 0);
  const kbExplicit = Number(leadRanked?.kb_explicit || 0);

  if (surfaceExplicitHits <= 0 && strongTargetAnchorHits <= 0 && kbExplicit > 0) {
    reasons.push('kb_only_lead_without_target_anchor');
  }
  if (conflictingIngredientIds.length > 0) {
    reasons.push('competing_title_or_url_anchor');
  }
  if (
    surfaceExplicitHits <= 0 &&
    normalizeNonEmptyString(leadTop?.retrieval_source || leadRanked?.source_tag).startsWith('kb_')
  ) {
    reasons.push('kb_lead_without_surface_anchor');
  }

  if (!reasons.length) return null;

  return {
    ingredient_id: ingredientId || null,
    ingredient_name: normalizeNonEmptyString(row.ingredient_name) || null,
    ingredient_class: normalizeNonEmptyString(row.ingredient_class) || null,
    query: normalizeNonEmptyString(row.query) || null,
    query_source: normalizeNonEmptyString(row.query_source) || null,
    source_file: sourceFile,
    misrank_reasons: reasons,
    conflicting_ingredient_ids: conflictingIngredientIds,
    lead_product: leadTop
      ? {
          name: normalizeNonEmptyString(leadTop.name) || null,
          brand: normalizeNonEmptyString(leadTop.brand) || null,
          retrieval_source: normalizeNonEmptyString(leadTop.retrieval_source) || null,
          url: normalizeNonEmptyString(leadTop.url) || null,
        }
      : null,
    lead_ranked_sample: leadRanked
      ? {
          title: normalizeNonEmptyString(leadRanked.title) || null,
          brand: normalizeNonEmptyString(leadRanked.brand) || null,
          source_tag: normalizeNonEmptyString(leadRanked.source_tag) || null,
          candidate_step: normalizeNonEmptyString(leadRanked.candidate_step) || null,
          family_relation: normalizeNonEmptyString(leadRanked.family_relation) || null,
          kb_explicit: Number(leadRanked.kb_explicit || 0),
          explicit_hits: Number(leadRanked.explicit_hits || 0),
          surface_explicit_hits: Number(leadRanked.surface_explicit_hits || 0),
          strong_target_anchor_hits: Number(leadRanked.strong_target_anchor_hits || 0),
          target_anchor_hits: Number(leadRanked.target_anchor_hits || 0),
        }
      : null,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = Array.from(new Set((Array.isArray(args.inputs) ? args.inputs : []).map(resolvePathMaybeRelative).filter(Boolean)));
  const entries = [];
  for (const inputPath of inputs) {
    const payload = readJsonSafe(inputPath);
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    for (const row of rows) {
      const entry = buildMisrankEntry(row, path.basename(inputPath));
      if (entry) entries.push(entry);
    }
  }
  entries.sort((left, right) => {
    const reasonDelta = Number(right?.misrank_reasons?.length || 0) - Number(left?.misrank_reasons?.length || 0);
    if (reasonDelta !== 0) return reasonDelta;
    return normalizeText(left?.ingredient_id).localeCompare(normalizeText(right?.ingredient_id));
  });
  const output = {
    generated_at: new Date().toISOString(),
    input_count: inputs.length,
    inputs,
    summary: {
      candidate_count: entries.length,
      reasons: summarizeReasons(entries),
    },
    entries,
  };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  process.stdout.write(serialized);
  if (args.outPath) {
    const outPath = resolvePathMaybeRelative(args.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, serialized, 'utf8');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  _internals: {
    buildMisrankEntry,
    collectConflictingIngredientIds,
    parseArgs,
    summarizeReasons,
  },
};
