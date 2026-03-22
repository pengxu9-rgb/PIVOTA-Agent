#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = { inputPath: '', outPath: '' };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = String(argv[idx] || '').trim();
    if (token === '--input') {
      out.inputPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    } else if (token === '--out') {
      out.outPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    }
  }
  return out;
}

function normalizePath(value) {
  return String(value || '').trim();
}

function isDataSupplyBucket(bucket) {
  const normalized = String(bucket || '').trim();
  return normalized === 'only_family_supply_present' || normalized === 'no_explicit_supply_in_any_source';
}

function summarizeStage(row, key) {
  const stage = row?.direct_source_stage_counts?.[key];
  if (!stage || typeof stage !== 'object') return null;
  const fetched = Math.max(0, Number(stage.fetched || 0));
  const admitted = Math.max(0, Number(stage.admitted || 0));
  const rejected = Math.max(0, Number(stage.rejected || 0));
  const final = Math.max(0, Number(stage.final || 0));
  if (fetched + admitted + rejected + final <= 0) return null;
  return { fetched, admitted, rejected, final };
}

function collectCandidateHints(row) {
  const out = [];
  const seen = new Set();
  for (const source of ['ranked_samples', 'rejected_samples', 'top_products']) {
    const list = Array.isArray(row?.[source]) ? row[source] : [];
    for (const sample of list) {
      const title = String(sample?.title || sample?.name || '').trim();
      const brand = String(sample?.brand || '').trim();
      const domain = String(sample?.domain || '').trim();
      const candidateUrl = String(sample?.candidate_url || sample?.url || '').trim();
      const sourceBucket = String(sample?.source_bucket || '').trim();
      const sourceTag = String(sample?.source_tag || sample?.retrieval_source || '').trim();
      const externalSeedId = String(sample?.external_seed_id || '').trim();
      const key = [title.toLowerCase(), brand.toLowerCase(), domain.toLowerCase(), candidateUrl.toLowerCase()].join('::');
      if (!key.replace(/:+/g, '').trim() || seen.has(key)) continue;
      seen.add(key);
      out.push({
        title: title || null,
        brand: brand || null,
        domain: domain || null,
        candidate_url: candidateUrl || null,
        source_bucket: sourceBucket || null,
        source_tag: sourceTag || null,
        external_seed_id: externalSeedId || null,
      });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function buildSourceGapSummary(row) {
  const statuses = row?.source_statuses && typeof row.source_statuses === 'object' ? row.source_statuses : {};
  return {
    kb_attached_seed: String(statuses.kb_attached_seed || 'no_rows').trim() || 'no_rows',
    attached_seed: String(statuses.attached_seed || 'no_rows').trim() || 'no_rows',
    products_cache: String(statuses.products_cache || 'no_rows').trim() || 'no_rows',
    unattached_seed: String(statuses.unattached_seed || 'no_rows').trim() || 'no_rows',
    family_fallback: String(statuses.family_fallback || 'no_rows').trim() || 'no_rows',
  };
}

function deriveNextAction(row) {
  const gap = buildSourceGapSummary(row);
  if (
    gap.kb_attached_seed === 'no_rows' &&
    gap.attached_seed === 'no_rows' &&
    gap.products_cache === 'no_rows' &&
    gap.unattached_seed === 'no_rows'
  ) {
    return 'backfill_or_ingest_explicit_supply_from_upstream_catalog';
  }
  if (
    gap.kb_attached_seed === 'matched_rows_without_explicit_admission' ||
    gap.attached_seed === 'matched_rows_without_explicit_admission' ||
    gap.products_cache === 'matched_rows_without_explicit_admission' ||
    gap.unattached_seed === 'matched_rows_without_explicit_admission'
  ) {
    return 'improve_explicit_ingredient_fields_in_seed_or_cache_rows';
  }
  return 'review_candidate_hints_and_rebuild_explicit_supply';
}

function buildItem(row) {
  if (!isDataSupplyBucket(row?.root_cause_bucket)) return null;
  return {
    ingredient_id: row.ingredient_id || null,
    ingredient_name: row.ingredient_name || null,
    ingredient_class: row.ingredient_class || null,
    query: row.query || null,
    root_cause_bucket: row.root_cause_bucket || null,
    recommended_action: deriveNextAction(row),
    miss_reason: row.miss_reason || null,
    query_source: row.query_source || null,
    registry_source: row.registry_source || null,
    profile_source: row.profile_source || null,
    source_statuses: buildSourceGapSummary(row),
    active_stages: {
      kb_attached_seed: summarizeStage(row, 'kb_attached_seed'),
      attached_seed: summarizeStage(row, 'attached_seed'),
      products_cache: summarizeStage(row, 'products_cache'),
      unattached_seed: summarizeStage(row, 'unattached_seed'),
      family_fallback: summarizeStage(row, 'family_fallback'),
    },
    candidate_hints: collectCandidateHints(row),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = normalizePath(args.inputPath);
  if (!inputPath) throw new Error('Missing required --input <matrix.json>');
  const resolvedInput = path.isAbsolute(inputPath) ? inputPath : path.join(process.cwd(), inputPath);
  const input = JSON.parse(fs.readFileSync(resolvedInput, 'utf8'));
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  const items = rows.map(buildItem).filter(Boolean);
  const out = {
    generated_at: new Date().toISOString(),
    source_matrix: resolvedInput,
    x_service_commit: input?.x_service_commit || null,
    backlog_count: items.length,
    items,
  };
  const output = `${JSON.stringify(out, null, 2)}\n`;
  process.stdout.write(output);
  if (args.outPath) {
    const resolvedOut = path.isAbsolute(args.outPath) ? args.outPath : path.join(process.cwd(), args.outPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, output, 'utf8');
  }
}

try {
  main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
}
