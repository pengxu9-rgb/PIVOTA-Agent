#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');

const CONFIRM_TOKEN = 'ALIGN_REVIEWED_EXTERNAL_SEED_IDENTITY_TO_CATALOG_SIG';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  return String(value || '').trim();
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map(asString).filter(Boolean)));
}

function stableHash(prefix, parts) {
  return `${prefix}_${crypto.createHash('sha1').update(JSON.stringify(parts || [])).digest('hex').slice(0, 24)}`;
}

function isSig(value) {
  return /^sig_[a-f0-9]{16,64}$/i.test(asString(value));
}

async function fetchRows(externalProductIds) {
  const result = await query(
    `
      SELECT
        cp.product_key,
        cp.merchant_id,
        cp.platform,
        cp.source_product_id,
        cp.title,
        cp.brand,
        cp.canonical_url,
        cp.pivota_signature_id AS catalog_sig_id,
        cp.pivota_canonical_url AS catalog_sig_url,
        cp.content_key,
        pgm.product_group_id,
        pgm.is_primary,
        pil.source_listing_ref,
        pil.sellable_item_group_id AS identity_sig_id,
        pil.product_line_id,
        pil.review_family_id,
        pil.identity_status,
        pil.live_read_enabled,
        pil.review_required,
        pil.review_reason_codes,
        pil.match_basis,
        pil.strong_identity
      FROM catalog_products cp
      LEFT JOIN product_group_members pgm
        ON pgm.merchant_id = cp.merchant_id
       AND pgm.platform = cp.platform
       AND pgm.platform_product_id = cp.source_product_id
      LEFT JOIN pdp_identity_listing pil
        ON pil.merchant_id = cp.merchant_id
       AND pil.product_id = cp.source_product_id
      WHERE cp.merchant_id = 'external_seed'
        AND cp.source_product_id = ANY($1::text[])
      ORDER BY array_position($1::text[], cp.source_product_id::text)
    `,
    [externalProductIds],
  );
  return result.rows || [];
}

function buildPlans(rows) {
  return rows.map((row) => {
    const blockers = [];
    const sourceRef = asString(row.source_listing_ref) || `external_seed:${asString(row.source_product_id)}`;
    const catalogSig = asString(row.catalog_sig_id);
    if (!asString(row.source_product_id)) blockers.push('missing_source_product_id');
    if (!asString(row.product_key)) blockers.push('missing_catalog_product');
    if (!asString(row.source_listing_ref)) blockers.push('missing_identity_listing');
    if (!isSig(catalogSig)) blockers.push('invalid_catalog_sig');
    if (row.review_required === true || asString(row.identity_status) === 'review_required') {
      blockers.push('identity_review_required');
    }
    const needsUpdate =
      blockers.length === 0 &&
      (asString(row.identity_sig_id) !== catalogSig ||
        row.live_read_enabled !== true ||
        asString(row.identity_status) !== 'approved' ||
        row.review_required === true ||
        JSON.stringify(row.review_reason_codes || []) !== '[]');
    return {
      action: blockers.length ? 'hold' : needsUpdate ? 'align_ready' : 'already_aligned',
      blockers,
      product_key: asString(row.product_key),
      source_listing_ref: sourceRef,
      external_product_id: asString(row.source_product_id),
      title: asString(row.title),
      brand: asString(row.brand),
      canonical_url: asString(row.canonical_url),
      product_group_id: asString(row.product_group_id),
      is_primary: row.is_primary === true,
      content_key: asString(row.content_key),
      catalog_sig_id: catalogSig,
      catalog_sig_url: asString(row.catalog_sig_url) || `https://agent.pivota.cc/products/${catalogSig}`,
      identity_sig_id_before: asString(row.identity_sig_id),
      product_line_id: asString(row.product_line_id),
      review_family_id: asString(row.review_family_id),
      identity_status_before: asString(row.identity_status),
      live_read_enabled_before: row.live_read_enabled === true,
      review_required_before: row.review_required === true,
      review_reason_codes_before: row.review_reason_codes || [],
      needs_update: needsUpdate,
    };
  });
}

async function applyPlans(plans, reviewedBy) {
  const ready = plans.filter((plan) => plan.action === 'align_ready');
  const totals = { override_upserts: 0, identity_rows_updated: 0 };
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`SET LOCAL statement_timeout = '45s'`);
      for (const plan of ready) {
        const payload = {
          source_listing_ref: plan.source_listing_ref,
          source_sellable_item_group_id: plan.identity_sig_id_before || null,
          target_sellable_item_group_id: plan.catalog_sig_id,
          target_product_group_id: plan.product_group_id || null,
          external_product_id: plan.external_product_id,
          product_key: plan.product_key,
          canonical_url: plan.canonical_url,
          catalog_sig_url: plan.catalog_sig_url,
          reason: 'reviewed_external_seed_identity_catalog_sig_alignment',
          reviewed_by: reviewedBy,
          reviewed_at: new Date().toISOString(),
        };
        const overrideId = stableHash('ovr', [
          'reviewed_external_seed_identity_catalog_sig_alignment',
          plan.source_listing_ref,
          plan.catalog_sig_id,
        ]);
        await client.query(
          `
            INSERT INTO pdp_identity_override (
              id,
              source_listing_ref,
              action_type,
              payload,
              created_by,
              active,
              updated_at
            ) VALUES ($1,$2,'force_exact_group',$3::jsonb,$4,true,now())
            ON CONFLICT (id) DO UPDATE SET
              payload = EXCLUDED.payload,
              created_by = EXCLUDED.created_by,
              active = EXCLUDED.active,
              updated_at = now()
          `,
          [overrideId, plan.source_listing_ref, JSON.stringify(payload), reviewedBy],
        );
        totals.override_upserts += 1;
        const update = await client.query(
          `
            UPDATE pdp_identity_listing
            SET
              sellable_item_group_id = $2,
              identity_status = 'approved',
              live_read_enabled = true,
              review_required = false,
              review_reason_codes = '[]'::jsonb,
              matched_by_rule = 'reviewed_external_seed_identity_catalog_sig_alignment',
              match_basis = COALESCE(match_basis, '[]'::jsonb) || $3::jsonb,
              strong_identity = COALESCE(strong_identity, '{}'::jsonb) || $4::jsonb,
              review_summary = COALESCE(review_summary, '{}'::jsonb) || $5::jsonb,
              updated_at = now()
            WHERE source_listing_ref = $1
          `,
          [
            plan.source_listing_ref,
            plan.catalog_sig_id,
            JSON.stringify([
              `reviewed_catalog_sig_alignment:${plan.catalog_sig_id}`,
              `product_group_id:${plan.product_group_id || ''}`,
            ]),
            JSON.stringify({
              canonical_sig_id: plan.catalog_sig_id,
              product_group_id: plan.product_group_id || null,
              reviewed_external_seed_identity_catalog_sig_alignment_v1: payload,
            }),
            JSON.stringify({ reviewed_external_seed_identity_catalog_sig_alignment_v1: payload }),
          ],
        );
        totals.identity_rows_updated += Number(update.rowCount || 0);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
  return totals;
}

async function main() {
  const externalProductIds = uniqueStrings(
    asString(argValue('external-product-ids'))
      .split(',')
      .map((item) => item.trim()),
  );
  const out = asString(argValue('out'));
  const write = hasFlag('write');
  const confirm = asString(argValue('confirm'));
  const reviewedBy = asString(argValue('reviewed-by')) || 'codex';
  if (!externalProductIds.length) throw new Error('Missing --external-product-ids');
  if (write && confirm !== CONFIRM_TOKEN) throw new Error(`Refusing write without --confirm ${CONFIRM_TOKEN}`);
  const rows = await fetchRows(externalProductIds);
  const seenIds = new Set(rows.map((row) => asString(row.source_product_id)));
  const missingIds = externalProductIds.filter((id) => !seenIds.has(id));
  const plans = buildPlans(rows);
  const held = plans.filter((plan) => plan.action === 'hold');
  const ready = plans.filter((plan) => plan.action === 'align_ready');
  const applied = write ? await applyPlans(plans, reviewedBy) : { override_upserts: 0, identity_rows_updated: 0 };
  const report = {
    status: held.length || missingIds.length ? 'blocked' : 'success',
    mode: write ? 'write' : 'dry_run',
    generated_at: new Date().toISOString(),
    external_product_ids: externalProductIds,
    rows_seen: rows.length,
    missing_ids: missingIds,
    align_ready_count: ready.length,
    already_aligned_count: plans.filter((plan) => plan.action === 'already_aligned').length,
    held_count: held.length,
    applied,
    blockers: [
      ...missingIds.map((id) => ({ external_product_id: id, blockers: ['missing_catalog_product'] })),
      ...held.map((plan) => ({
        external_product_id: plan.external_product_id,
        blockers: plan.blockers,
      })),
    ],
    plans,
  };
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'blocked') process.exitCode = 2;
}

main()
  .catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
