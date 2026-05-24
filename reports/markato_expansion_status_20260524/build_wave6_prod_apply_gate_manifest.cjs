#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname);
const sourceManifestPath = path.join(ROOT, 'wave6_tier_a_prod_db_dry_run_candidate_manifest.json');
const prodDryRunPath = path.join(ROOT, 'wave6_tier_a_prod_db_dry_run.json');
const applyManifestPath = path.join(ROOT, 'wave6_prod_apply_candidate_manifest.json');
const holdPath = path.join(ROOT, 'wave6_prod_apply_hold_review.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function text(value) {
  return String(value || '').trim();
}

function hasCjk(value) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text(value));
}

function priceAmount(item) {
  const amount = item?.seed_row?.price_amount;
  return Number.isFinite(Number(amount)) ? Number(amount) : null;
}

function dryRunStatusByExternalId(dryRun) {
  const out = new Map();
  const rows = Array.isArray(dryRun?.apply_result?.items) ? dryRun.apply_result.items : [];
  for (const row of rows) {
    out.set(text(row.external_product_id), row);
  }
  return out;
}

function classifyItem(item, dryRunByExternalId) {
  const seed = item.seed_row || {};
  const data = seed.seed_data || {};
  const externalId = text(seed.external_product_id);
  const dryRun = dryRunByExternalId.get(externalId) || {};
  const reasons = [];
  if (dryRun.status !== 'would_insert') reasons.push(`prod_dry_run_status:${dryRun.status || 'missing'}`);
  if (dryRun.requires_seed_correction) reasons.push('requires_seed_correction');
  if (dryRun.commerce_facts_gate?.status !== 'pass') reasons.push('commerce_gate_not_pass');
  if (dryRun.commerce_facts_gate?.availability_status && dryRun.commerce_facts_gate.availability_status !== 'in_stock') {
    reasons.push(`availability:${dryRun.commerce_facts_gate.availability_status}`);
  }

  const amount = priceAmount(item);
  if (text(seed.price_currency).toUpperCase() !== 'USD') reasons.push(`currency:${seed.price_currency || 'missing'}`);
  if (amount == null || amount <= 0) reasons.push('missing_or_invalid_price');
  if (amount != null && amount >= 250) reasons.push('price_sanity_hold_usd_amount_ge_250');

  const description = [data.description, data.snapshot?.description].join('\n');
  if (hasCjk(description)) reasons.push('non_english_source_copy_needs_us_review');

  return {
    status: reasons.length ? 'hold' : 'apply_candidate',
    reasons,
  };
}

function main() {
  const source = readJson(sourceManifestPath);
  const dryRun = readJson(prodDryRunPath);
  const dryRunByExternalId = dryRunStatusByExternalId(dryRun);
  const items = Array.isArray(source.items) ? source.items : [];
  const applyItems = [];
  const holdItems = [];

  for (const item of items) {
    const decision = classifyItem(item, dryRunByExternalId);
    const seed = item.seed_row || {};
    const annotated = {
      ...item,
      main_review_gate: {
        ...(item.main_review_gate || {}),
        prod_db_dry_run_path: prodDryRunPath,
        prod_apply_gate_status: decision.status,
        prod_apply_gate_reasons: decision.reasons,
      },
    };
    if (decision.status === 'apply_candidate') {
      applyItems.push(annotated);
    } else {
      holdItems.push({
        brand: seed.brand || item.target_brand || '',
        title: seed.title || '',
        canonical_url: seed.canonical_url || item.target_url || '',
        external_product_id: seed.external_product_id || '',
        price_amount: seed.price_amount ?? null,
        price_currency: seed.price_currency || '',
        reasons: decision.reasons,
      });
    }
  }

  const generatedAt = new Date().toISOString();
  const applyManifest = {
    generated_at: generatedAt,
    market: 'US',
    source: 'wave6_prod_db_dry_run_main_agent_gate',
    curation_policy:
      'Production apply candidates only: prod DB dry-run would_insert, no correction, commerce gate pass, price sanity pass, no non-English source-copy hold.',
    source_manifest_path: sourceManifestPath,
    source_prod_dry_run_path: prodDryRunPath,
    item_count: applyItems.length,
    excluded_hold_count: holdItems.length,
    items: applyItems,
  };
  const holdReview = {
    generated_at: generatedAt,
    source_manifest_path: sourceManifestPath,
    source_prod_dry_run_path: prodDryRunPath,
    item_count: holdItems.length,
    holds_by_reason: holdItems.reduce((acc, item) => {
      for (const reason of item.reasons) acc[reason] = (acc[reason] || 0) + 1;
      return acc;
    }, {}),
    items: holdItems,
  };

  fs.writeFileSync(applyManifestPath, `${JSON.stringify(applyManifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(holdPath, `${JSON.stringify(holdReview, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${JSON.stringify(
      {
        apply_manifest_path: applyManifestPath,
        hold_path: holdPath,
        apply_candidate_count: applyItems.length,
        hold_count: holdItems.length,
        holds_by_reason: holdReview.holds_by_reason,
      },
      null,
      2,
    )}\n`,
  );
}

main();
