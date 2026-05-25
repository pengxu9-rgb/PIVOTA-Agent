#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const TARGET_IDS = [
  'ext_96a7ecc1003f0f94e5b6805c',
  'ext_a1bb997d38b6823e83f23948',
  'ext_53cf4f0ee46873d280f632db',
  'ext_fe9ef8f2a6343901489fe63e',
];
const CONFIRM_TOKEN = 'APPLY_WAVE13_MASAMI_SNAPSHOT_GALLERY_REPAIR';
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';

const PRIMARY_IMAGE_HINTS = {
  ext_96a7ecc1003f0f94e5b6805c: [/masami-shampoo-mekabu-shampoo/i, /girl_smelling_masami_shampoo/i],
  ext_a1bb997d38b6823e83f23948: [/masami_mekabu_hydrating_conditioner_award_hero/i, /masami-conditioner/i],
  ext_53cf4f0ee46873d280f632db: [/masami-serum-mekabu-hydrating-shine-serum/i, /masami_shine_serum/i],
  ext_fe9ef8f2a6343901489fe63e: [/masami-treatment-mekabu-hydrating-styling-cream/i, /styling_cream/i],
};

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueUrls(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const url = text(value);
    if (!/^https?:\/\//i.test(url)) continue;
    const key = url.replace(/[?&](?:width|height|w|h|v)=[^&]+/gi, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

function filename(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch {
    return url;
  }
}

function isProductPath(url) {
  try {
    const parsed = new URL(url);
    return /\/(?:cdn\/shop\/products|s\/files\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/products)\//i.test(parsed.pathname);
  } catch {
    return /\/products\//i.test(url);
  }
}

function collectAllImageUrls(row, seedData, snapshot) {
  const urls = [
    row.image_url,
    seedData.image_url,
    snapshot.image_url,
    ...asArray(seedData.image_urls),
    ...asArray(seedData.images),
    ...asArray(snapshot.image_urls),
    ...asArray(snapshot.images),
    ...asArray(seedData.variants).flatMap((variant) => [
      variant?.image_url,
      ...asArray(variant?.image_urls),
      ...asArray(variant?.images),
    ]),
    ...asArray(snapshot.variants).flatMap((variant) => [
      variant?.image_url,
      ...asArray(variant?.image_urls),
      ...asArray(variant?.images),
    ]),
  ];
  return uniqueUrls(urls);
}

function choosePrimaryImage(externalProductId, productUrls) {
  const hints = PRIMARY_IMAGE_HINTS[externalProductId] || [];
  for (const hint of hints) {
    const hit = productUrls.find((url) => hint.test(filename(url)) || hint.test(url));
    if (hit) return hit;
  }
  return productUrls[0] || '';
}

function splitImages(row, seedData, snapshot) {
  const all = collectAllImageUrls(row, seedData, snapshot);
  const productUrls = all.filter((url) => isProductPath(url));
  // Keep product-path assets out of content_image_urls even if their filename has
  // marketing words; otherwise live gallery dedupe sees the same asset in both rails.
  const contentUrls = all.filter((url) => !isProductPath(url));
  const primary = choosePrimaryImage(row.external_product_id, productUrls);
  return {
    all,
    product_urls: productUrls,
    content_urls: uniqueUrls(contentUrls.filter((url) => url !== primary)),
    primary_image_url: primary,
  };
}

function parseInciItems(value) {
  return text(value)
    .split(',')
    .map((item) => text(item))
    .filter((item) => item.length >= 2);
}

function snapshotContract(now) {
  return {
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'wave13_masami_snapshot_gallery_repair',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'replace_not_merge',
    updated_at: now,
  };
}

function qualityPatch(seedData, now, sourceUrl) {
  return {
    ...asObject(asObject(seedData.snapshot).pdp_field_quality_summary),
    ...asObject(seedData.pdp_field_quality_summary),
    description_raw: {
      source_origin: 'reviewed_source_backed_pdp_content_patch',
      source_quality_status: 'high',
      source_kinds: ['official_pdp_description', 'official_html'],
      source_url: sourceUrl,
      reviewed_by: 'codex_wave13_masami',
      reason: 'Markato Wave13 MASAMI source-backed PDP content and snapshot-contract materialization',
      updated_at: now,
    },
    ingredients_raw: {
      source_origin: 'reviewed_source_backed_pdp_content_patch',
      source_quality_status: 'high',
      source_kinds: ['official_html', 'accordion_ingredients'],
      source_url: sourceUrl,
      reviewed_by: 'codex_wave13_masami',
      reason: 'Markato Wave13 MASAMI source-backed PDP content and snapshot-contract materialization',
      updated_at: now,
    },
    how_to_use_raw: {
      source_origin: 'reviewed_source_backed_pdp_content_patch',
      source_quality_status: 'high',
      source_kinds: ['official_html', 'accordion_how_to_use'],
      source_url: sourceUrl,
      reviewed_by: 'codex_wave13_masami',
      reason: 'Markato Wave13 MASAMI source-backed PDP content and snapshot-contract materialization',
      updated_at: now,
    },
    details_sections: {
      source_origin: 'reviewed_source_backed_pdp_content_patch',
      source_quality_status: 'high',
      source_kinds: ['official_html', 'official_pdp_structured_section'],
      source_url: sourceUrl,
      reviewed_by: 'codex_wave13_masami',
      reason: 'Markato Wave13 MASAMI source-backed PDP content and snapshot-contract materialization',
      updated_at: now,
    },
  };
}

function buildNextSeedData(row, now) {
  const seedData = JSON.parse(JSON.stringify(asObject(row.seed_data)));
  const snapshot = asObject(seedData.snapshot);
  seedData.snapshot = snapshot;
  const images = splitImages(row, seedData, snapshot);
  if (!images.primary_image_url || images.product_urls.length === 0) {
    return {
      blocked: ['missing_product_path_image'],
      images,
      next_seed_data: seedData,
    };
  }

  const sourceUrl = text(seedData.canonical_url || snapshot.canonical_url || row.canonical_url || row.destination_url);
  const contract = snapshotContract(now);
  const quality = qualityPatch(seedData, now, sourceUrl);
  const ingredientsRaw = text(seedData.pdp_ingredients_raw || snapshot.pdp_ingredients_raw);
  const ingredientsInci = asArray(seedData.ingredients_inci).length
    ? seedData.ingredients_inci
    : parseInciItems(ingredientsRaw);

  const patchTarget = (target) => {
    if (!target || typeof target !== 'object') return;
    target.image_url = images.primary_image_url;
    target.image_urls = images.product_urls;
    target.images = images.product_urls;
    target.content_image_urls = images.content_urls;
    target.external_seed_snapshot_contract = {
      ...asObject(target.external_seed_snapshot_contract),
      ...contract,
    };
    target.pdp_field_quality_summary = quality;
    target.reviewed_pdp_content_patch_v1 = {
      contract_version: 'external_seed.reviewed_pdp_content_patch.v1',
      review_state: 'assistant_reviewed',
      reviewed_by: 'codex_wave13_masami',
      reviewed_at: now,
      reason: 'Markato Wave13 MASAMI source-backed PDP content and snapshot-contract materialization',
      evidence: `Official MASAMI PDP captured description, image assets, INCI, and how-to at ${sourceUrl}.`,
      source_url: sourceUrl,
      source_kind: 'official_pdp_structured_section',
      patched_fields: ['image_url', 'image_urls', 'content_image_urls', 'external_seed_snapshot_contract'],
    };
    if (ingredientsRaw) {
      target.pdp_ingredients_raw = ingredientsRaw;
      target.raw_ingredient_text_clean = ingredientsRaw;
      target.ingredients_inci = ingredientsInci;
      target.inci_list = ingredientsInci;
      target.ingredient_intel = {
        ...asObject(target.ingredient_intel),
        raw_ingredient_text_clean: ingredientsRaw,
        inci_raw: ingredientsRaw,
        inci_list: ingredientsInci,
        inci_normalized: ingredientsInci,
      };
    }
  };

  patchTarget(seedData);
  patchTarget(snapshot);
  seedData.variants = asArray(seedData.variants).map((variant) => ({
    ...variant,
    image_url: images.primary_image_url,
    image_urls: images.product_urls,
    images: images.product_urls,
  }));
  snapshot.variants = asArray(snapshot.variants).map((variant) => ({
    ...variant,
    image_url: images.primary_image_url,
    image_urls: images.product_urls,
    images: images.product_urls,
  }));

  return {
    blocked: [],
    images,
    next_seed_data: seedData,
  };
}

function sanitizeJson(value) {
  return JSON.stringify(value).replace(/\u0000/g, '').replace(/\\+u0000/gi, '');
}

function buildServingPatch(nextSeedData) {
  return {
    image_url: nextSeedData.image_url,
    image_urls: nextSeedData.image_urls,
    images: nextSeedData.images,
    content_image_urls: nextSeedData.content_image_urls,
    external_seed_snapshot_contract: nextSeedData.external_seed_snapshot_contract,
    reviewed_pdp_content_patch_v1: nextSeedData.reviewed_pdp_content_patch_v1,
    pdp_field_quality_summary: nextSeedData.pdp_field_quality_summary,
    pdp_ingredients_raw: nextSeedData.pdp_ingredients_raw,
    raw_ingredient_text_clean: nextSeedData.raw_ingredient_text_clean,
    ingredients_inci: nextSeedData.ingredients_inci,
    inci_list: nextSeedData.inci_list,
    ingredient_intel: nextSeedData.ingredient_intel,
  };
}

async function fetchRows(client) {
  const result = await client.query(
    `
      SELECT
        eps.id AS seed_id,
        eps.external_product_id,
        eps.market,
        eps.status,
        eps.title,
        eps.image_url,
        eps.canonical_url,
        eps.destination_url,
        eps.seed_data,
        cp.product_key,
        cp.content_key,
        cp.image_url AS catalog_image_url,
        cp.product_payload
      FROM external_product_seeds eps
      LEFT JOIN catalog_products cp
        ON cp.merchant_id = 'external_seed'
       AND cp.platform = 'external_seed'
       AND cp.source_product_id = eps.external_product_id
      WHERE eps.external_product_id = ANY($1::text[])
      ORDER BY array_position($1::text[], eps.external_product_id)
    `,
    [TARGET_IDS],
  );
  return result.rows || [];
}

async function applyPlan(client, plan) {
  await client.query('BEGIN');
  try {
    const seedJson = sanitizeJson(plan.next_seed_data);
    const servingPatch = buildServingPatch(plan.next_seed_data);
    const servingJson = sanitizeJson(servingPatch);
    const skuPatchJson = sanitizeJson({
      image_url: plan.next_seed_data.image_url,
      image_urls: plan.next_seed_data.image_urls,
      images: plan.next_seed_data.images,
      content_image_urls: plan.next_seed_data.content_image_urls,
      external_seed_snapshot_contract: plan.next_seed_data.external_seed_snapshot_contract,
    });
    const seed = await client.query(
      `
        UPDATE external_product_seeds
        SET image_url = $2,
            seed_data = $3::jsonb,
            updated_at = now()
        WHERE external_product_id = $1
      `,
      [plan.external_product_id, plan.primary_image_url, seedJson],
    );
    const catalog = await client.query(
      `
        UPDATE catalog_products
        SET image_url = $2,
            product_payload = COALESCE(product_payload, '{}'::jsonb) || $3::jsonb,
            updated_at = now()
        WHERE merchant_id = 'external_seed'
          AND platform = 'external_seed'
          AND source_product_id = $1
      `,
      [plan.external_product_id, plan.primary_image_url, servingJson],
    );
    const skus = await client.query(
      `
        UPDATE catalog_skus
        SET image_url = $2,
            sku_payload = COALESCE(sku_payload, '{}'::jsonb) || $3::jsonb,
            updated_at = now()
        WHERE product_key = $1
      `,
      [plan.product_key, plan.primary_image_url, skuPatchJson],
    );
    const identity = await client.query(
      `
        UPDATE pdp_identity_listing
        SET source_payload = COALESCE(source_payload, '{}'::jsonb) || $2::jsonb,
            updated_at = now()
        WHERE source_listing_ref = $1
      `,
      [`external_seed:${plan.external_product_id}`, servingJson],
    );
    await client.query('COMMIT');
    return {
      external_product_id: plan.external_product_id,
      seed_updates: Number(seed.rowCount || 0),
      catalog_updates: Number(catalog.rowCount || 0),
      sku_updates: Number(skus.rowCount || 0),
      identity_updates: Number(identity.rowCount || 0),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  const write = hasFlag('write');
  const confirm = argValue('confirm');
  if (write && confirm !== CONFIRM_TOKEN) {
    throw new Error(`--write requires --confirm ${CONFIRM_TOKEN}`);
  }
  const out = argValue('out');
  const now = new Date().toISOString();
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await client.connect();
  try {
    const rows = await fetchRows(client);
    const plans = rows.map((row) => {
      const next = buildNextSeedData(row, now);
      const beforeContract = {
        ...asObject(asObject(row.seed_data).external_seed_snapshot_contract),
        ...asObject(asObject(asObject(row.seed_data).snapshot).external_seed_snapshot_contract),
      };
      const changed = sanitizeJson(next.next_seed_data) !== sanitizeJson(asObject(row.seed_data));
      return {
        external_product_id: row.external_product_id,
        seed_id: row.seed_id,
        product_key: row.product_key,
        content_key: row.content_key,
        status: next.blocked.length ? 'blocked' : 'ready',
        blockers: next.blocked,
        changed,
        previous_image_url: row.image_url || row.catalog_image_url || null,
        primary_image_url: next.images.primary_image_url || null,
        product_image_count: next.images.product_urls.length,
        content_image_count: next.images.content_urls.length,
        previous_snapshot_contract_authoritative: beforeContract.authoritative === true,
        previous_legacy_fields_quarantined: beforeContract.legacy_fields_quarantined === true,
        next_snapshot_contract_authoritative: true,
        next_legacy_fields_quarantined: true,
        product_image_urls: next.images.product_urls,
        content_image_urls: next.images.content_urls,
        next_seed_data: next.next_seed_data,
      };
    });
    const missing = TARGET_IDS.filter((id) => !rows.some((row) => row.external_product_id === id));
    const applyResults = [];
    if (write) {
      for (const plan of plans) {
        if (plan.status !== 'ready' || !plan.changed) continue;
        applyResults.push(await applyPlan(client, plan));
      }
    }
    const report = {
      generated_at: now,
      dry_run: !write,
      missing,
      summary: {
        scanned: rows.length,
        missing: missing.length,
        blocked: plans.filter((plan) => plan.status === 'blocked').length,
        change_candidates: plans.filter((plan) => plan.status === 'ready' && plan.changed).length,
        updated_rows: applyResults.length,
        seed_updates: applyResults.reduce((sum, item) => sum + item.seed_updates, 0),
        catalog_updates: applyResults.reduce((sum, item) => sum + item.catalog_updates, 0),
        sku_updates: applyResults.reduce((sum, item) => sum + item.sku_updates, 0),
        identity_updates: applyResults.reduce((sum, item) => sum + item.identity_updates, 0),
      },
      apply_results: applyResults,
      plans: plans.map(({ next_seed_data: _nextSeedData, ...plan }) => plan),
    };
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exitCode = 1;
});
