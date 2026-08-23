#!/usr/bin/env node
'use strict';

/*
 * Commerce Index v2 -> Catalog Serving/OpenSearch bridge.
 *
 * The serving index aggregates offers and variants by sellable-item group, so
 * this worker expands a changed product to every member of its existing group
 * before rebuilding its document.  It never acknowledges a queue row when
 * OpenSearch is disabled or the exact scoped rebuild fails.
 */

const axios = require('axios');
const { closePool, query } = require('../src/db');
const {
  backfillCatalogServingIndex,
  getCatalogServingIndexConfig,
} = require('../src/services/catalogServingIndex');

const APPLY_ENV = 'COMMERCE_INDEX_SEARCH_PUBLICATION_APPLY';

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function argValue(argv, name, fallback = '') {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : null;
  return value && !value.startsWith('--') ? value : fallback;
}

function numberArg(value, fallback, { min = 1, max = 1000 } = {}) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function dedupe(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildOffer(row) {
  const payload = asObject(row.offer_payload);
  return {
    ...payload,
    offer_id: String(row.offer_id || payload.offer_id || ''),
    id: String(row.offer_id || payload.id || ''),
    sku_id: String(row.sku_key || payload.sku_id || ''),
    availability: row.availability || payload.availability || 'unknown',
    inventory_quantity: row.inventory_quantity ?? payload.inventory_quantity ?? null,
    currency: row.currency || payload.currency || null,
    list_price: asNumber(row.list_price) ?? payload.list_price ?? null,
    price: asNumber(row.merchant_effective_price) ?? payload.price ?? asNumber(row.list_price) ?? null,
    merchant_effective_price: asNumber(row.merchant_effective_price) ?? payload.merchant_effective_price ?? null,
    offer_mode: row.offer_mode || payload.offer_mode || 'merchant_checkout',
  };
}

function buildSourceRows(rows = []) {
  return (rows || []).map((row) => {
    const payload = asObject(row.product_payload);
    const offers = Array.isArray(row.offers) ? row.offers.map(buildOffer) : [];
    const product = {
      ...payload,
      merchant_id: row.merchant_id,
      product_id: row.source_product_id,
      id: row.source_product_id,
      platform_product_id: row.source_product_id,
      title: row.title || payload.title || payload.name || '',
      description: row.description || payload.description || null,
      brand: row.brand || payload.brand || payload.vendor || null,
      product_type: row.product_type || payload.product_type || null,
      category: row.category || payload.category || null,
      canonical_url: row.canonical_url || payload.canonical_url || payload.url || null,
      image_url: row.image_url || payload.image_url || null,
      offers,
      updated_at: row.updated_at || payload.updated_at || null,
    };
    return {
      merchant_id: row.merchant_id,
      product_id: row.source_product_id,
      source_kind: 'internal',
      product,
      source_meta: {
        product_key: row.product_key,
        content_key: row.content_key || null,
        public_sig_id: row.pivota_signature_id || null,
        pivota_signature_id: row.pivota_signature_id || null,
        updated_at: row.updated_at || null,
      },
    };
  }).filter((row) => row.merchant_id && row.product_id);
}

async function claimBatch({ workerId, limit }) {
  const result = await query(
    `
      UPDATE commerce_index_publication_jobs
      SET status = 'processing', claimed_by = $1, claimed_at = NOW(),
          -- Search has a 15-minute Cloud Run timeout. The extra headroom keeps
          -- overlapping 5-minute scheduler ticks from duplicating a slow bulk
          -- index publication after its worker has already claimed the batch.
          lease_until = NOW() + INTERVAL '30 minutes', attempts = attempts + 1,
          updated_at = NOW()
      WHERE job_id IN (
        SELECT job_id FROM commerce_index_publication_jobs
        WHERE target = 'search_index'
          AND (status = 'pending' OR (status = 'processing' AND lease_until < NOW()))
        ORDER BY created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      RETURNING job_id, change_id, merchant_id, scope_json
    `,
    [workerId, limit],
  );
  return result.rows || [];
}

async function finishBatch({ jobIds, workerId, error = null }) {
  if (!jobIds.length) return 0;
  const result = await query(
    `
      UPDATE commerce_index_publication_jobs
      SET status = $3, error_message = $4,
          published_at = CASE WHEN $5::boolean THEN NOW() ELSE NULL END,
          claimed_by = NULL, claimed_at = NULL, lease_until = NULL, updated_at = NOW()
      WHERE job_id = ANY($1::text[]) AND status = 'processing' AND claimed_by = $2
      RETURNING job_id
    `,
    [
      jobIds,
      workerId,
      error ? 'pending' : 'completed',
      error ? String(error).slice(0, 1000) : null,
      !error,
    ],
  );
  return (result.rows || []).length;
}

async function resolveScopedProductKeys(jobs) {
  const productKeys = dedupe(
    jobs.filter((job) => job.scope_json?.entity_type === 'product').map((job) => job.scope_json?.entity_id),
  );
  const offerIds = dedupe(
    jobs.filter((job) => job.scope_json?.entity_type === 'offer').map((job) => job.scope_json?.entity_id),
  );
  const skuKeys = dedupe(
    jobs.filter((job) => job.scope_json?.entity_type === 'sku').map((job) => job.scope_json?.entity_id),
  );
  const result = await query(
    `
      SELECT product_key FROM catalog_products WHERE product_key = ANY($1::text[])
      UNION
      SELECT product_key FROM catalog_offers WHERE offer_id = ANY($2::text[])
      UNION
      SELECT product_key FROM catalog_skus WHERE sku_key = ANY($3::text[])
    `,
    [productKeys, offerIds, skuKeys],
  );
  return dedupe((result.rows || []).map((row) => row.product_key));
}

async function resolveGroupProductRows(productKeys) {
  const result = await query(
    `
      WITH changed_groups AS (
        SELECT DISTINCT pil.sellable_item_group_id
        FROM catalog_products cp
        JOIN pdp_identity_listing pil
          ON pil.source_listing_ref = cp.merchant_id || ':' || cp.source_product_id
        WHERE cp.product_key = ANY($1::text[])
          AND COALESCE(pil.sellable_item_group_id, '') <> ''
      ), affected_products AS (
        SELECT product_key FROM catalog_products WHERE product_key = ANY($1::text[])
        UNION
        SELECT cp.product_key
        FROM catalog_products cp
        JOIN pdp_identity_listing pil
          ON pil.source_listing_ref = cp.merchant_id || ':' || cp.source_product_id
        JOIN changed_groups cg ON cg.sellable_item_group_id = pil.sellable_item_group_id
      )
      SELECT cp.product_key, cp.merchant_id, cp.platform, cp.source_product_id,
             cp.title, cp.description, cp.brand, cp.product_type, cp.category,
             cp.canonical_url, cp.image_url, cp.product_payload, cp.content_key,
             cp.pivota_signature_id, cp.updated_at,
             COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'offer_id', co.offer_id, 'sku_key', co.sku_key, 'offer_mode', co.offer_mode,
                   'availability', co.availability, 'inventory_quantity', co.inventory_quantity,
                   'currency', co.currency, 'list_price', co.list_price,
                   'merchant_effective_price', co.merchant_effective_price,
                   'offer_payload', co.offer_payload
                 ) ORDER BY co.offer_id
               ) FILTER (WHERE co.offer_id IS NOT NULL),
               '[]'::jsonb
             ) AS offers
      FROM catalog_products cp
      LEFT JOIN catalog_offers co ON co.product_key = cp.product_key
      WHERE cp.product_key IN (SELECT product_key FROM affected_products)
      GROUP BY cp.product_key, cp.merchant_id, cp.platform, cp.source_product_id,
               cp.title, cp.description, cp.brand, cp.product_type, cp.category,
               cp.canonical_url, cp.image_url, cp.product_payload, cp.content_key,
               cp.pivota_signature_id, cp.updated_at
    `,
    [productKeys],
  );
  return result.rows || [];
}

async function resolvePublishedMembershipRepair(productKeys) {
  const sourceRefsResult = await query(
    `SELECT merchant_id || ':' || source_product_id AS source_ref
       FROM catalog_products
      WHERE product_key = ANY($1::text[])`,
    [productKeys],
  );
  const changedSourceRefs = dedupe((sourceRefsResult.rows || []).map((row) => row.source_ref));
  if (!changedSourceRefs.length) return { priorDocumentIds: [], productKeys: [] };
  const priorDocuments = await query(
    `SELECT DISTINCT document_id
       FROM commerce_index_search_memberships
      WHERE source_ref = ANY($1::text[])`,
    [changedSourceRefs],
  );
  const priorDocumentIds = dedupe((priorDocuments.rows || []).map((row) => row.document_id));
  if (!priorDocumentIds.length) return { priorDocumentIds, productKeys: [] };
  const priorSourceRefs = await query(
    `SELECT source_ref
       FROM commerce_index_search_memberships
      WHERE document_id = ANY($1::text[])`,
    [priorDocumentIds],
  );
  const sourceRefs = dedupe((priorSourceRefs.rows || []).map((row) => row.source_ref));
  if (!sourceRefs.length) return { priorDocumentIds, productKeys: [] };
  const priorProducts = await query(
    `SELECT product_key
       FROM catalog_products
      WHERE merchant_id || ':' || source_product_id = ANY($1::text[])`,
    [sourceRefs],
  );
  return {
    priorDocumentIds,
    productKeys: dedupe((priorProducts.rows || []).map((row) => row.product_key)),
  };
}

async function replacePublishedMemberships({ priorDocumentIds = [], memberships = [] }) {
  const documentIds = dedupe(priorDocumentIds);
  if (documentIds.length) {
    await query(
      `DELETE FROM commerce_index_search_memberships WHERE document_id = ANY($1::text[])`,
      [documentIds],
    );
  }
  const sourceRefs = [];
  const nextDocumentIds = [];
  for (const membership of memberships || []) {
    const documentId = String(membership?.doc_id || '').trim();
    for (const sourceRef of dedupe(membership?.source_refs)) {
      sourceRefs.push(sourceRef);
      nextDocumentIds.push(documentId);
    }
  }
  if (!sourceRefs.length) return 0;
  const result = await query(
    `INSERT INTO commerce_index_search_memberships (source_ref, document_id, updated_at)
     SELECT source_ref, document_id, NOW()
       FROM UNNEST($1::text[], $2::text[]) AS t(source_ref, document_id)
     ON CONFLICT (source_ref) DO UPDATE
       SET document_id = EXCLUDED.document_id, updated_at = EXCLUDED.updated_at`,
    [sourceRefs, nextDocumentIds],
  );
  return Number(result.rowCount || sourceRefs.length);
}

async function deleteStaleDocuments({ documentIds = [], currentDocumentIds = [], config, httpClient = axios }) {
  const current = new Set(dedupe(currentDocumentIds));
  const stale = dedupe(documentIds).filter((documentId) => !current.has(documentId));
  if (!stale.length) return 0;
  const response = await httpClient.post(
    `${config.base_url}/${encodeURIComponent(config.index_name)}/_delete_by_query?conflicts=proceed&refresh=true`,
    { query: { ids: { values: stale } } },
    {
      headers: {
        'Content-Type': 'application/json',
        ...(config.api_key ? { Authorization: `ApiKey ${config.api_key}` } : {}),
      },
    },
  );
  if (response?.data?.timed_out === true || (response?.data?.failures || []).length) {
    throw new Error('OpenSearch stale-document deletion was incomplete');
  }
  return Number(response?.data?.deleted || 0);
}

async function main(argv = process.argv.slice(2)) {
  if (!enabled(process.env[APPLY_ENV])) {
    throw new Error(`${APPLY_ENV}=true is required; refusing to claim or complete search publication jobs`);
  }
  const config = getCatalogServingIndexConfig(process.env);
  if (!config.enabled) {
    throw new Error('Catalog Serving/OpenSearch is not configured; refusing to acknowledge search publication jobs');
  }
  const workerId = argValue(argv, 'worker-id', `search-ci-${process.pid}`);
  const limit = numberArg(argValue(argv, 'limit', '50'), 50, { min: 1, max: 500 });
  const jobs = await claimBatch({ workerId, limit });
  if (!jobs.length) return { claimed: 0, completed: 0 };
  const jobIds = jobs.map((job) => job.job_id);
  try {
    const scopedProductKeys = await resolveScopedProductKeys(jobs);
    if (!scopedProductKeys.length) throw new Error('search-index product resolution returned no canonical products');
    const membershipRepair = await resolvePublishedMembershipRepair(scopedProductKeys);
    const productKeys = dedupe([...scopedProductKeys, ...membershipRepair.productKeys]);
    const rows = await resolveGroupProductRows(productKeys);
    if (!rows.length) throw new Error('search-index group expansion returned no catalog rows');
    const result = await backfillCatalogServingIndex(
      { limit: rows.length, includeNonPublic: true, refresh: true },
      { fetchBackfillProductsFn: async () => buildSourceRows(rows), queryFn: query },
    );
    if (result.source !== 'opensearch_compatible') {
      throw new Error(`search-index publication did not reach OpenSearch: source=${result.source}`);
    }
    const memberships = result.document_memberships || [];
    const deleted = await deleteStaleDocuments({
      documentIds: membershipRepair.priorDocumentIds,
      currentDocumentIds: memberships.map((membership) => membership.doc_id),
      config,
    });
    await replacePublishedMemberships({
      priorDocumentIds: membershipRepair.priorDocumentIds,
      memberships,
    });
    const completed = await finishBatch({ jobIds, workerId });
    return {
      claimed: jobs.length,
      completed,
      product_keys: productKeys,
      indexed: result.indexed,
      stale_documents_deleted: deleted,
    };
  } catch (error) {
    await finishBatch({ jobIds, workerId, error: error?.message || String(error) });
    throw error;
  }
}

if (require.main === module) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; })
    .finally(() => closePool().catch(() => {}));
}

module.exports = {
  APPLY_ENV,
  buildOffer,
  buildSourceRows,
  claimBatch,
  finishBatch,
  main,
  deleteStaleDocuments,
  replacePublishedMemberships,
  resolvePublishedMembershipRepair,
  resolveGroupProductRows,
  resolveScopedProductKeys,
};
