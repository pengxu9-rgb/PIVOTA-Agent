#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');

const CONFIRM_TOKEN = 'MERGE_APPROVED_BEAUTY_MANIFEST';

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function stableHash(prefix, parts) {
  return `${prefix}_${crypto.createHash('sha1').update(JSON.stringify(parts || [])).digest('hex').slice(0, 24)}`;
}

function isSigId(value) {
  return /^sig_[a-f0-9]{16,64}$/i.test(asString(value));
}

function normalizeText(value) {
  return asString(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hostFromUrl(value) {
  const url = asString(value);
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function unique(values) {
  return Array.from(new Set((values || []).map(asString).filter(Boolean))).sort();
}

function sourceListingRef(row) {
  return asString(row?.source_listing_ref) || `${asString(row?.merchant_id)}:${asString(row?.source_product_id)}`;
}

function lifecycleRank(stage) {
  switch (asString(stage).toLowerCase()) {
    case 'published':
      return 4;
    case 'validated':
      return 3;
    case 'candidate':
      return 2;
    case 'draft':
      return 1;
    default:
      return 0;
  }
}

function comparePrimaryRows(left, right) {
  const leftRank = lifecycleRank(left?.pdp_lifecycle_stage);
  const rightRank = lifecycleRank(right?.pdp_lifecycle_stage);
  if (leftRank !== rightRank) return rightRank - leftRank;
  const leftPrimary = left?.is_primary === true ? 1 : 0;
  const rightPrimary = right?.is_primary === true ? 1 : 0;
  if (leftPrimary !== rightPrimary) return rightPrimary - leftPrimary;
  return asString(left?.product_key).localeCompare(asString(right?.product_key));
}

async function readManifest(inputPath) {
  const resolved = path.resolve(inputPath);
  const parsed = JSON.parse(await fs.readFile(resolved, 'utf8'));
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : Array.isArray(parsed) ? parsed : [];
  return groups.map((group) => ({
    id: asString(group.id),
    approved_title: asString(group.approved_title || group.expected_title || group.id),
    notes: asString(group.notes),
    primary_product_key: asString(group.primary_product_key || (Array.isArray(group.product_keys) ? group.product_keys[0] : '')),
    product_keys: unique(group.product_keys || []),
    allowed_hosts: unique(group.allowed_hosts || []),
    hold: Boolean(group.hold),
  }));
}

async function fetchRows(productKeys, { market = 'US' } = {}) {
  const result = await query(
    `
      WITH sku_offer_stats AS (
        SELECT
          s.product_key,
          COUNT(DISTINCT s.sku_key)::int AS sku_count,
          COUNT(DISTINCT o.offer_id)::int AS offer_count
        FROM catalog_skus s
        LEFT JOIN catalog_offers o ON o.sku_key = s.sku_key
        GROUP BY s.product_key
      )
      SELECT
        cp.product_key,
        cp.merchant_id,
        cp.platform,
        cp.source_product_id,
        cp.title,
        cp.brand,
        cp.category,
        cp.product_type,
        cp.category_path,
        cp.canonical_url,
        cp.pivota_signature_id,
        cp.pivota_signature_minted_at,
        cp.pivota_canonical_url,
        cp.content_key,
        cp.pdp_lifecycle_stage,
        cp.updated_at,
        cm.merchant_name,
        pgm.product_group_id AS existing_product_group_id,
        COALESCE(pgm.is_primary, false) AS is_primary,
        COALESCE(sku_offer_stats.sku_count, 0)::int AS sku_count,
        COALESCE(sku_offer_stats.offer_count, 0)::int AS offer_count,
        pil.source_listing_ref,
        pil.sellable_item_group_id,
        pil.identity_status,
        pil.live_read_enabled,
        pil.review_required
      FROM catalog_products cp
      LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
      LEFT JOIN product_group_members pgm
        ON pgm.merchant_id = cp.merchant_id
       AND pgm.platform = cp.platform
       AND pgm.platform_product_id = cp.source_product_id
      LEFT JOIN sku_offer_stats ON sku_offer_stats.product_key = cp.product_key
      LEFT JOIN LATERAL (
        SELECT *
        FROM pdp_identity_listing pil
        WHERE pil.merchant_id = cp.merchant_id
          AND pil.product_id = cp.source_product_id
        ORDER BY pil.updated_at DESC NULLS LAST, pil.created_at DESC NULLS LAST
        LIMIT 1
      ) pil ON true
      WHERE cp.product_key = ANY($1::text[])
        AND cp.pivota_signature_id LIKE 'sig\\_%' ESCAPE '\\'
        AND (cp.pdp_lifecycle_stage IS NULL OR cp.pdp_lifecycle_stage NOT IN ('hold', 'archived'))
        AND COALESCE(cp.product_payload->>'market', cp.product_payload->>'market_code', cp.product_payload->'snapshot'->>'market', 'US') = $2
      ORDER BY cp.product_key ASC
    `,
    [productKeys, market],
  );
  return result.rows.map((row) => ({
    ...row,
    host: hostFromUrl(row.canonical_url),
  }));
}

function memberFromRow(row, plan) {
  const isPrimary = asString(row.product_key) === plan.primary_product_key;
  return {
    product_key: asString(row.product_key),
    merchant_id: asString(row.merchant_id),
    merchant_name: asString(row.merchant_name),
    platform: asString(row.platform),
    source_product_id: asString(row.source_product_id),
    source_listing_ref: sourceListingRef(row),
    title: asString(row.title),
    brand: asString(row.brand),
    host: asString(row.host),
    canonical_url: asString(row.canonical_url),
    content_key: asString(row.content_key),
    sig_id: asString(row.pivota_signature_id),
    existing_identity_sig_id: asString(row.sellable_item_group_id),
    existing_product_group_id: asString(row.existing_product_group_id),
    target_product_group_id: plan.target_product_group_id,
    is_primary: isPrimary,
    existing_is_primary: row.is_primary === true,
    sku_count: Number(row.sku_count || 0),
    offer_count: Number(row.offer_count || 0),
  };
}

function buildPlan(definition, rows) {
  const blockers = [];
  if (!definition.id) blockers.push('missing_id');
  if (definition.hold) blockers.push('manifest_hold');
  if (definition.product_keys.length < 2) blockers.push('less_than_two_product_keys');

  const foundKeys = unique(rows.map((row) => row.product_key));
  for (const key of definition.product_keys) {
    if (!foundKeys.includes(key)) blockers.push(`missing_product_key:${key}`);
  }

  const hostAllowlist = new Set(definition.allowed_hosts);
  if (hostAllowlist.size) {
    for (const row of rows) {
      if (!hostAllowlist.has(row.host)) blockers.push(`unexpected_host:${row.host || 'unknown'}`);
    }
  }
  for (const row of rows) {
    if (!isSigId(row.pivota_signature_id)) blockers.push(`invalid_sig:${row.product_key}`);
    if (!asString(row.existing_product_group_id)) blockers.push(`missing_product_group_id:${row.product_key}`);
  }

  let primary = rows.find((row) => asString(row.product_key) === definition.primary_product_key) || null;
  if (!primary && rows.length) primary = rows.slice().sort(comparePrimaryRows)[0];
  if (!primary) blockers.push('missing_primary_member');
  if (primary && !asString(primary.existing_product_group_id)) blockers.push('missing_primary_product_group_id');

  const targetProductGroupId = asString(primary?.existing_product_group_id);
  const canonicalSigId = asString(primary?.pivota_signature_id);
  const planBase = {
    id: definition.id,
    approved_title: definition.approved_title,
    notes: definition.notes,
    action: blockers.length ? 'hold' : 'merge_ready',
    blockers: unique(blockers),
    primary_product_key: asString(primary?.product_key),
    canonical_sig_id: canonicalSigId,
    target_product_group_id: targetProductGroupId,
  };
  const members = rows.map((row) => memberFromRow(row, planBase));
  return {
    ...planBase,
    seller_hosts: unique(members.map((member) => member.host)),
    content_keys: unique(members.map((member) => member.content_key)),
    sig_ids: unique(members.map((member) => member.sig_id)),
    existing_product_group_ids: unique(members.map((member) => member.existing_product_group_id)),
    sku_count: members.reduce((sum, member) => sum + member.sku_count, 0),
    offer_count: members.reduce((sum, member) => sum + member.offer_count, 0),
    group_writes_ready: members.filter(
      (member) =>
        member.existing_product_group_id !== targetProductGroupId || member.existing_is_primary !== member.is_primary,
    ).length,
    identity_updates_ready: members.filter(
      (member) => member.existing_identity_sig_id && member.existing_identity_sig_id !== canonicalSigId,
    ).length,
    members,
  };
}

async function buildPlans(groups, options) {
  const rows = await fetchRows(groups.flatMap((group) => group.product_keys), options);
  return groups.map((group) =>
    buildPlan(
      group,
      rows.filter((row) => group.product_keys.includes(asString(row.product_key))),
    ),
  );
}

async function applyPlan(client, plan) {
  let productGroupWrites = 0;
  let identityOverrideWrites = 0;
  let identityListingUpdates = 0;
  for (const member of plan.members) {
    await client.query(
      `
        INSERT INTO product_group_members (
          product_group_id,
          merchant_id,
          platform,
          platform_product_id,
          is_primary,
          created_at,
          updated_at
        ) VALUES ($1,$2,$3,$4,$5,now(),now())
        ON CONFLICT (merchant_id, platform, platform_product_id)
        DO UPDATE SET
          product_group_id = EXCLUDED.product_group_id,
          is_primary = EXCLUDED.is_primary,
          updated_at = now()
      `,
      [plan.target_product_group_id, member.merchant_id, member.platform, member.source_product_id, member.is_primary],
    );
    productGroupWrites += 1;
  }

  const primary = plan.members.find((member) => member.is_primary);
  if (primary) {
    await client.query(
      `
        UPDATE product_group_members
        SET is_primary = false,
            updated_at = now()
        WHERE product_group_id = $1
          AND NOT (merchant_id = $2 AND platform = $3 AND platform_product_id = $4)
          AND is_primary = true
      `,
      [plan.target_product_group_id, primary.merchant_id, primary.platform, primary.source_product_id],
    );
  }

  for (const member of plan.members) {
    const payload = {
      source_listing_ref: member.source_listing_ref,
      source_sellable_item_group_id: member.existing_identity_sig_id || member.sig_id,
      target_sellable_item_group_id: plan.canonical_sig_id,
      target_product_group_id: plan.target_product_group_id,
      approved_merge_id: plan.id,
      approved_title: plan.approved_title,
      approved_content_keys: plan.content_keys,
      approved_product_keys: plan.members.map((row) => row.product_key),
      reason: 'manual_approved_beauty_cross_seller_merge',
      merge_policy: 'human_qa_approved_exact_or_strong_title_cross_seller',
      reviewed_by: 'codex',
      notes: plan.notes || null,
    };
    const overrideId = stableHash('ovr', [
      'manual_approved_beauty_cross_seller_merge',
      member.source_listing_ref,
      member.sig_id,
      plan.canonical_sig_id,
      plan.id,
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
        ) VALUES ($1,$2,'force_exact_group',$3::jsonb,'codex',true,now())
        ON CONFLICT (id) DO UPDATE SET
          payload = EXCLUDED.payload,
          created_by = EXCLUDED.created_by,
          active = EXCLUDED.active,
          updated_at = now()
      `,
      [overrideId, member.source_listing_ref, JSON.stringify(payload)],
    );
    identityOverrideWrites += 1;

    const updateResult = await client.query(
      `
        UPDATE pdp_identity_listing
        SET
          sellable_item_group_id = $2,
          identity_status = 'approved',
          live_read_enabled = true,
          review_required = false,
          review_reason_codes = '[]'::jsonb,
          matched_by_rule = 'manual_approved_beauty_cross_seller_merge',
          match_basis = COALESCE(match_basis, '[]'::jsonb) || $3::jsonb,
          strong_identity = COALESCE(strong_identity, '{}'::jsonb) || $4::jsonb,
          review_summary = COALESCE(review_summary, '{}'::jsonb) || $5::jsonb,
          updated_at = now()
        WHERE source_listing_ref = $1
           OR (merchant_id = $6 AND product_id = $7)
      `,
      [
        member.source_listing_ref,
        plan.canonical_sig_id,
        JSON.stringify([
          `approved_merge:${plan.id}`,
          `canonical_sig:${plan.canonical_sig_id}`,
          `product_group_id:${plan.target_product_group_id}`,
        ]),
        JSON.stringify({
          canonical_sig_id: plan.canonical_sig_id,
          product_group_id: plan.target_product_group_id,
          approved_content_keys: plan.content_keys,
          approved_product_keys: plan.members.map((row) => row.product_key),
        }),
        JSON.stringify({ manual_approved_beauty_cross_seller_merge_v1: payload }),
        member.merchant_id,
        member.source_product_id,
      ],
    );
    identityListingUpdates += Number(updateResult.rowCount || 0);
  }

  return { product_group_upserts: productGroupWrites, identity_override_upserts: identityOverrideWrites, identity_listing_updates: identityListingUpdates };
}

async function applyPlans(plans) {
  const totals = {
    merge_groups_applied: 0,
    product_group_upserts: 0,
    identity_override_upserts: 0,
    identity_listing_updates: 0,
  };
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`SET LOCAL statement_timeout = '45s'`);
      for (const plan of plans) {
        const applied = await applyPlan(client, plan);
        totals.merge_groups_applied += 1;
        totals.product_group_upserts += applied.product_group_upserts;
        totals.identity_override_upserts += applied.identity_override_upserts;
        totals.identity_listing_updates += applied.identity_listing_updates;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
  return totals;
}

async function run() {
  const input = readArg('input', '');
  const out = readArg('out', '');
  const market = readArg('market', 'US');
  const apply = hasFlag('apply');
  const confirm = readArg('confirm', '');
  if (!input) throw new Error('Missing --input');
  if (apply && confirm !== CONFIRM_TOKEN) {
    process.stderr.write(`Refusing to apply without --confirm=${CONFIRM_TOKEN}\n`);
    process.exitCode = 2;
    return;
  }
  const groups = await readManifest(input);
  const plans = await buildPlans(groups, { market });
  const ready = plans.filter((plan) => plan.action === 'merge_ready');
  const held = plans.filter((plan) => plan.action !== 'merge_ready');
  const applied = apply
    ? await applyPlans(ready)
    : { merge_groups_applied: 0, product_group_upserts: 0, identity_override_upserts: 0, identity_listing_updates: 0 };
  const report = {
    status: held.length ? 'blocked' : 'success',
    mode: apply ? 'apply' : 'dry_run',
    generated_at: new Date().toISOString(),
    market,
    approved_merge_count: groups.length,
    merge_ready_count: ready.length,
    held_count: held.length,
    member_count: ready.reduce((sum, plan) => sum + plan.members.length, 0),
    group_writes_ready: ready.reduce((sum, plan) => sum + plan.group_writes_ready, 0),
    identity_updates_ready: ready.reduce((sum, plan) => sum + plan.identity_updates_ready, 0),
    blockers: held.map((plan) => ({ id: plan.id, blockers: plan.blockers })),
    applied,
    plans,
  };
  if (out) {
    await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await fs.writeFile(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (held.length) process.exitCode = 2;
}

if (require.main === module) {
  run()
    .catch((err) => {
      process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
