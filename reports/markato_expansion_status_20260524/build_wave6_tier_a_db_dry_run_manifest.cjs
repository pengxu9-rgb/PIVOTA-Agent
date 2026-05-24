#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname);
const validationPath = path.join(ROOT, 'agent_wave6_overall_validation', 'overall_validation.json');
const outManifestPath = path.join(ROOT, 'wave6_tier_a_prod_db_dry_run_candidate_manifest.json');
const outHoldPath = path.join(ROOT, 'wave6_tier_b_rework_hold_candidates.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/$/, '')
    .toLowerCase();
}

function itemUrl(item) {
  return normalizeUrl(
    item?.target_url ||
      item?.seed_row?.canonical_url ||
      item?.seed_row?.destination_url ||
      item?.seed_row?.seed_data?.canonical_url ||
      item?.seed_row?.seed_data?.destination_url,
  );
}

function loadCuratedItem(candidate) {
  const manifestPath = String(candidate.curated_manifest_path || '').trim();
  if (!manifestPath) {
    throw new Error(`Missing curated_manifest_path for ${candidate.brand} / ${candidate.title}`);
  }
  const manifest = readJson(manifestPath);
  const target = normalizeUrl(candidate.canonical_url || candidate.source_url);
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  const found = items.find((item) => itemUrl(item) === target);
  if (!found) {
    throw new Error(`Could not find candidate URL in curated manifest: ${candidate.brand} / ${candidate.title} / ${target}`);
  }
  return {
    ...found,
    main_review_gate: {
      tier: 'A_prod_db_dry_run_only',
      safety_status: candidate.safety_status,
      needs_main_agent_review: candidate.needs_main_agent_review || [],
      validator_note: candidate.note || '',
      source_validation_path: validationPath,
    },
  };
}

function main() {
  const validation = readJson(validationPath);
  const candidates = Array.isArray(validation.consolidated_db_ready_candidates)
    ? validation.consolidated_db_ready_candidates
    : [];
  const tierA = candidates.filter((row) => row.safety_status === 'needs_main_agent_review');
  const tierB = candidates.filter((row) => row.safety_status !== 'needs_main_agent_review');
  const items = tierA.map(loadCuratedItem);

  const manifest = {
    generated_at: new Date().toISOString(),
    market: 'US',
    source: 'wave6_parallel_agent_main_review',
    curation_policy:
      'Tier A only: no hard rework flags; intended for production DATABASE_URL dry-run only, not apply.',
    source_validation_path: validationPath,
    item_count: items.length,
    excluded_rework_count: tierB.length,
    items,
  };

  const hold = {
    generated_at: manifest.generated_at,
    source_validation_path: validationPath,
    hold_policy: 'Tier B hard rework rows excluded from the next production DB dry-run manifest.',
    item_count: tierB.length,
    candidates: tierB.map((row) => ({
      batch: row.batch,
      brand: row.brand,
      title: row.title,
      canonical_url: row.canonical_url || row.source_url || '',
      external_product_id: row.external_product_id || '',
      safety_status: row.safety_status,
      safety_flags: row.safety_flags || [],
      needs_main_agent_review: row.needs_main_agent_review || [],
    })),
  };

  fs.writeFileSync(outManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(outHoldPath, `${JSON.stringify(hold, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${JSON.stringify(
      {
        manifest_path: outManifestPath,
        hold_path: outHoldPath,
        tier_a_count: items.length,
        tier_b_count: tierB.length,
      },
      null,
      2,
    )}\n`,
  );
}

main();
