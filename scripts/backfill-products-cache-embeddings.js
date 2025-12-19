#!/usr/bin/env node
/**
 * Backfill pgvector embeddings for products_cache (creator-scoped).
 *
 * Usage:
 *   node scripts/backfill-products-cache-embeddings.js --creatorId creator_demo_001
 *   node scripts/backfill-products-cache-embeddings.js --merchantIds merch_x,merch_y --limit 2000
 *
 * Env:
 *   DATABASE_URL (required)
 *   FIND_PRODUCTS_MULTI_VECTOR_ENABLED=true (optional, for online use)
 *   PIVOTA_EMBEDDINGS_PROVIDER=gemini|openai
 *   PIVOTA_EMBEDDINGS_MODEL_GEMINI=text-embedding-004
 *   GEMINI_API_KEY=...
 */

const crypto = require('crypto');
const { query, withClient } = require('../src/db');
const { getCreatorConfig } = require('../src/creatorConfig');
const { embedTexts } = require('../src/services/embeddings');

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith('--')) return null;
  return v;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function buildEmbeddingText(product) {
  const title = String(product?.title || '').trim();
  const ptype = String(product?.product_type || product?.productType || '').trim();
  const vendor = String(product?.vendor || '').trim();
  const desc = String(product?.description || '').trim();
  const tags = Array.isArray(product?.tags) ? product.tags.join(', ') : '';
  return [title, ptype && `Type: ${ptype}`, vendor && `Vendor: ${vendor}`, tags && `Tags: ${tags}`, desc]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function vectorLiteral(vec) {
  return `[${vec.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0)).join(',')}]`;
}

function pickVectorColumns(dim) {
  if (dim === 768) return { col768: true, col1536: false };
  if (dim === 1536) return { col768: false, col1536: true };
  throw new Error(`Unsupported embedding dim: ${dim}`);
}

async function fetchLatestProductsForMerchants(merchantIds, limit, offset) {
  const baseWhere = `
    merchant_id = ANY($1)
    AND (expires_at IS NULL OR expires_at > now())
    AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
    AND COALESCE(lower(product_data->>'orderable'), 'true') <> 'false'
  `;

  const sql = `
    SELECT merchant_id, cache_product_id, product_data
    FROM (
      SELECT DISTINCT ON (merchant_id, cache_product_id)
        merchant_id,
        cache_product_id,
        product_data,
        cached_at
      FROM (
        SELECT
          merchant_id,
          COALESCE(
            NULLIF(platform_product_id, ''),
            NULLIF(product_data->>'id', ''),
            NULLIF(product_data->>'product_id', ''),
            NULLIF(product_data->>'productId', '')
          ) AS cache_product_id,
          product_data,
          cached_at
        FROM products_cache
        WHERE ${baseWhere}
      ) t
      WHERE cache_product_id IS NOT NULL
      ORDER BY merchant_id, cache_product_id, cached_at DESC
    ) latest
    ORDER BY merchant_id, cache_product_id
    OFFSET $2
    LIMIT $3
  `;

  const res = await query(sql, [merchantIds, Math.max(0, Number(offset || 0)), Math.min(Math.max(1, Number(limit || 500)), 5000)]);
  return (res.rows || []).map((r) => ({
    merchant_id: r.merchant_id,
    product_id: r.cache_product_id,
    product: r.product_data,
  }));
}

async function fetchExistingHashes(merchantIds, provider, model) {
  const res = await query(
    `
      SELECT merchant_id, product_id, content_hash
      FROM products_cache_embeddings
      WHERE merchant_id = ANY($1)
        AND provider = $2
        AND model = $3
    `,
    [merchantIds, provider, model],
  );
  const map = new Map();
  for (const r of res.rows || []) {
    map.set(`${r.merchant_id}::${r.product_id}`, String(r.content_hash || ''));
  }
  return map;
}

async function upsertEmbeddingsBatch(client, rows, provider, model, dim) {
  if (!rows.length) return;
  const { col768, col1536 } = pickVectorColumns(dim);

  const values = [];
  const params = [];
  let idx = 1;

  for (const r of rows) {
    params.push(r.merchant_id, r.product_id, provider, model, dim);
    const midIdx = idx;
    const pidIdx = idx + 1;
    const provIdx = idx + 2;
    const modelIdx = idx + 3;
    const dimIdx = idx + 4;
    idx += 5;

    let e768Idx = 'NULL';
    let e1536Idx = 'NULL';
    if (col768) {
      params.push(vectorLiteral(r.vector));
      e768Idx = `$${idx}::vector`;
      idx += 1;
    } else {
      params.push(null);
      idx += 1;
    }
    if (col1536) {
      params.push(vectorLiteral(r.vector));
      e1536Idx = `$${idx}::vector`;
      idx += 1;
    } else {
      params.push(null);
      idx += 1;
    }
    const col768Idx = `$${idx - 2}`;
    const col1536Idx = `$${idx - 1}`;

    params.push(r.content_hash);
    const hashIdx = idx;
    idx += 1;

    values.push(`($${midIdx}, $${pidIdx}, $${provIdx}, $${modelIdx}, $${dimIdx}, ${col768Idx}::vector, ${col1536Idx}::vector, $${hashIdx})`);
  }

  const sql = `
    INSERT INTO products_cache_embeddings (
      merchant_id, product_id, provider, model, dim, embedding_768, embedding_1536, content_hash
    )
    VALUES ${values.join(',\n')}
    ON CONFLICT (merchant_id, product_id, provider, model)
    DO UPDATE SET
      dim = EXCLUDED.dim,
      embedding_768 = EXCLUDED.embedding_768,
      embedding_1536 = EXCLUDED.embedding_1536,
      content_hash = EXCLUDED.content_hash,
      updated_at = now()
  `;

  await client.query(sql, params);
}

async function main() {
  const creatorId = argValue('creatorId');
  const merchantIdsArg = argValue('merchantIds');
  const limit = Number(argValue('limit') || 2000);
  const offset = Number(argValue('offset') || 0);
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun');

  let merchantIds = [];
  if (merchantIdsArg) {
    merchantIds = merchantIdsArg.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (creatorId) {
    const cfg = getCreatorConfig(creatorId);
    if (!cfg) throw new Error(`Unknown creatorId: ${creatorId}`);
    merchantIds = cfg.merchantIds;
  } else {
    throw new Error('Provide --creatorId or --merchantIds');
  }

  const provider = (process.env.PIVOTA_EMBEDDINGS_PROVIDER || 'gemini').toLowerCase();
  const model =
    provider === 'openai'
      ? (process.env.PIVOTA_EMBEDDINGS_MODEL_OPENAI || process.env.PIVOTA_EMBEDDINGS_MODEL || 'text-embedding-3-small')
      : (process.env.PIVOTA_EMBEDDINGS_MODEL_GEMINI || process.env.PIVOTA_EMBEDDINGS_MODEL || 'text-embedding-004');

  console.log(JSON.stringify({ merchantIdsCount: merchantIds.length, provider, model, limit, offset, dryRun }, null, 2));

  const items = await fetchLatestProductsForMerchants(merchantIds, limit, offset);
  const texts = items.map((it) => buildEmbeddingText(it.product));
  const hashes = texts.map(sha256);

  let existing = new Map();
  try {
    existing = await fetchExistingHashes(merchantIds, provider, model);
  } catch (err) {
    console.warn('Warning: failed to load existing embeddings; continuing:', err.message || err);
  }

  const toEmbed = [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const key = `${it.merchant_id}::${it.product_id}`;
    const prevHash = existing.get(key);
    if (prevHash && prevHash === hashes[i]) continue;
    toEmbed.push({ ...it, text: texts[i], content_hash: hashes[i] });
  }

  console.log(`Loaded ${items.length} products; ${toEmbed.length} require embedding/upsert.`);
  if (toEmbed.length === 0) return;

  const batchSize = Math.min(Math.max(4, Number(process.env.PIVOTA_EMBEDDINGS_BATCH_SIZE || 16)), 64);
  const upsertBatchSize = Math.min(Math.max(8, Number(process.env.PIVOTA_EMBEDDINGS_UPSERT_BATCH_SIZE || 32)), 200);

  if (dryRun) {
    console.log('Dry run enabled; not calling embeddings API or writing to DB.');
    return;
  }

  await withClient(async (client) => {
    for (let start = 0; start < toEmbed.length; start += batchSize) {
      const slice = toEmbed.slice(start, start + batchSize);
      const res = await embedTexts(slice.map((x) => x.text), { provider, model, cache: false });
      const dim = res.dim;

      const rows = slice.map((x, idx) => ({
        merchant_id: x.merchant_id,
        product_id: x.product_id,
        vector: res.vectors[idx],
        content_hash: x.content_hash,
      }));

      for (let w = 0; w < rows.length; w += upsertBatchSize) {
        const up = rows.slice(w, w + upsertBatchSize);
        await upsertEmbeddingsBatch(client, up, res.provider, res.model, dim);
      }

      console.log(`Upserted ${Math.min(start + batchSize, toEmbed.length)}/${toEmbed.length} embeddings...`);
    }
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

