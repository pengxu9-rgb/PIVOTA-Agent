const { query } = require('../db');

function vectorLiteral(vec) {
  if (!Array.isArray(vec) || vec.length === 0) throw new Error('Query embedding is empty');
  return `[${vec.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0)).join(',')}]`;
}

function isPgvectorMissingError(err) {
  const msg = String(err && err.message ? err.message : err || '');
  const code = err && err.code ? String(err.code) : '';
  // 42P01: undefined_table, 42704: undefined_object (vector type), 0A000: feature_not_supported
  if (code === '42P01' || code === '42704' || code === '0A000') return true;
  return (
    /relation .*products_cache_embeddings.* does not exist/i.test(msg) ||
    /type .*vector.* does not exist/i.test(msg) ||
    /extension .*vector.* is not available/i.test(msg)
  );
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}

function norm(a) {
  return Math.sqrt(dot(a, a));
}

function cosineSim(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  return dot(a, b) / (na * nb);
}

function pickVectorColumn(dim) {
  if (dim === 768) return 'embedding_768';
  if (dim === 1536) return 'embedding_1536';
  throw new Error(`Unsupported embedding dim: ${dim} (expected 768 or 1536)`);
}

function buildUnderwearExclusionSql(startIndex) {
  const tokens = [
    'lingerie',
    'underwear',
    'bra',
    'panties',
    'panty',
    'briefs',
    'thong',
    'push-up',
    'push up',
    'backless',
    "women's sleepwear",
    'womens sleepwear',
    'women sleepwear',
    'sleepwear set',
    "women's lingerie",
    'lingerie set',
    'ropa interior',
    'sujetador',
    'bragas',
  ];

  const fields = [
    "lower(coalesce(product_data->>'title',''))",
    "lower(coalesce(product_data->>'product_type',''))",
  ];

  const parts = [];
  const params = [];
  let idx = startIndex;
  for (const tok of tokens) {
    const p = `%${tok}%`;
    params.push(p);
    const ors = fields.map((f) => `${f} LIKE $${idx}`).join(' OR ');
    parts.push(`(${ors})`);
    idx += 1;
  }
  return {
    sql: parts.length ? `NOT (${parts.join(' OR ')})` : 'TRUE',
    params,
    nextIndex: idx,
  };
}

function buildPetSignalSql(startIndex) {
  const latin =
    '(dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets|perro|perros|mascota|mascotas|gato|gatos|chien|chiens|chienne|chiot|chat|chats)';
  const cjk = '(狗狗|狗|猫猫|猫|宠物|犬服|猫服|犬|ペット|わんちゃん)';
  const re = `(\\\\m${latin}\\\\M|${cjk})`;

  const fields = [
    "coalesce(product_data->>'title','')",
    "coalesce(product_data->>'description','')",
    "coalesce(product_data->>'product_type','')",
  ];

  const idx = startIndex;
  const ors = fields.map((f) => `${f} ~* $${idx}`).join(' OR ');
  return { sql: `(${ors})`, params: [re], nextIndex: idx + 1 };
}

function buildBaseSellableWhere() {
  return `
    merchant_id = ANY($1)
    AND (expires_at IS NULL OR expires_at > now())
    AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
    AND COALESCE(lower(product_data->>'orderable'), 'true') <> 'false'
  `;
}

function normalizeIntentTarget(intentTarget) {
  const t = String(intentTarget || '').toLowerCase();
  if (!t) return 'unknown';
  if (t === 'pet' || t === 'dog' || t === 'cat') return 'pet';
  if (t === 'human') return 'human';
  if (t === 'toy') return 'toy';
  return t;
}

async function vectorSearchCreatorProductsFromCache({
  merchantIds,
  queryVector,
  dim,
  provider,
  model,
  limit = 60,
  intentTarget,
  excludeUnderwear = false,
}) {
  if (!Array.isArray(merchantIds) || merchantIds.length === 0) return [];
  const col = pickVectorColumn(dim);
  const vec = vectorLiteral(queryVector);

  const baseWhere = buildBaseSellableWhere();
  const normalizedTarget = normalizeIntentTarget(intentTarget);

  const params = [merchantIds, vec, String(provider || ''), String(model || ''), Number(dim || 0)];
  let idx = 6;

  let underwearClause = null;
  let underwearParams = [];
  let afterUnderwearIdx = idx;
  if (excludeUnderwear) {
    const built = buildUnderwearExclusionSql(idx);
    underwearClause = built.sql;
    underwearParams = built.params;
    afterUnderwearIdx = built.nextIndex;
  }

  let petClause = null;
  let petParams = [];
  let afterPetIdx = afterUnderwearIdx;
  if (normalizedTarget === 'pet') {
    const built = buildPetSignalSql(afterUnderwearIdx);
    petClause = built.sql;
    petParams = built.params;
    afterPetIdx = built.nextIndex;
  }

  // Note: we compute a stable "cache_product_id" from products_cache so it can
  // be joined with the embeddings table (which is keyed by the same ID).
  const latestWhere = [baseWhere, ...(underwearClause ? [underwearClause] : []), ...(petClause ? [petClause] : [])].join(' AND ');

  // Use cosine distance (<=>) and convert to similarity score (1 - distance).
  const sql = `
    WITH latest AS (
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
        WHERE ${latestWhere}
      ) t
      WHERE cache_product_id IS NOT NULL
      ORDER BY merchant_id, cache_product_id, cached_at DESC
    ),
    ranked AS (
      SELECT
        merchant_id,
        product_id,
        1 - (${col} <=> $2::vector) AS score
      FROM products_cache_embeddings
      WHERE merchant_id = ANY($1)
        AND provider = $3
        AND model = $4
        AND dim = $5
        AND ${col} IS NOT NULL
      ORDER BY ${col} <=> $2::vector
      LIMIT $${afterPetIdx}
    )
    SELECT l.product_data, r.score
    FROM ranked r
    JOIN latest l
      ON l.merchant_id = r.merchant_id
     AND l.cache_product_id = r.product_id
    ORDER BY r.score DESC
    LIMIT $${afterPetIdx + 1}
  `;

  const finalParams = [
    ...params,
    ...underwearParams,
    ...petParams,
    Math.min(Math.max(1, Number(limit || 60)), 300),
    Math.min(Math.max(1, Number(limit || 60)), 300),
  ];

  const res = await query(sql, finalParams);
  return (res.rows || [])
    .map((r) => ({
      product: r.product_data,
      score: typeof r.score === 'number' ? r.score : Number(r.score || 0),
    }))
    .filter((x) => x.product);
}

async function vectorSearchCreatorProductsFromCacheFallback({
  merchantIds,
  queryVector,
  dim,
  provider,
  model,
  limit = 60,
  intentTarget,
  excludeUnderwear = false,
}) {
  if (!Array.isArray(merchantIds) || merchantIds.length === 0) return [];

  const normalizedTarget = normalizeIntentTarget(intentTarget);
  // Load embeddings for these merchants (creator-scoped; typically small).
  const embRes = await query(
    `
      SELECT merchant_id, product_id, embedding
      FROM products_cache_embeddings_fallback
      WHERE merchant_id = ANY($1)
        AND provider = $2
        AND model = $3
        AND dim = $4
    `,
    [merchantIds, String(provider || ''), String(model || ''), Number(dim || 0)],
  );

  const scored = (embRes.rows || [])
    .map((r) => {
      const vec = Array.isArray(r.embedding) ? r.embedding.map((x) => Number(x)) : [];
      if (!vec.length) return null;
      return {
        merchant_id: r.merchant_id,
        product_id: r.product_id,
        score: cosineSim(queryVector, vec),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.max(1, Number(limit || 60)), 300));

  if (scored.length === 0) return [];

  // Fetch latest sellable product_data for just the scored product_ids.
  const baseWhere = buildBaseSellableWhere();
  const params = [merchantIds, scored.map((s) => String(s.product_id))];
  let idx = 3;

  let underwearClause = null;
  let underwearParams = [];
  let afterUnderwearIdx = idx;
  if (excludeUnderwear) {
    const built = buildUnderwearExclusionSql(idx);
    underwearClause = built.sql;
    underwearParams = built.params;
    afterUnderwearIdx = built.nextIndex;
  }

  let petClause = null;
  let petParams = [];
  let afterPetIdx = afterUnderwearIdx;
  if (normalizedTarget === 'pet') {
    const built = buildPetSignalSql(afterUnderwearIdx);
    petClause = built.sql;
    petParams = built.params;
    afterPetIdx = built.nextIndex;
  }

  const latestWhere = [baseWhere, ...(underwearClause ? [underwearClause] : []), ...(petClause ? [petClause] : [])].join(' AND ');
  const sql = `
    WITH latest AS (
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
        WHERE ${latestWhere}
      ) t
      WHERE cache_product_id IS NOT NULL
      ORDER BY merchant_id, cache_product_id, cached_at DESC
    )
    SELECT merchant_id, cache_product_id, product_data
    FROM latest
    WHERE cache_product_id = ANY($2)
  `;

  const rowsRes = await query(sql, [
    ...params,
    ...underwearParams,
    ...petParams,
  ]);

  const byKey = new Map();
  for (const r of rowsRes.rows || []) {
    byKey.set(`${r.merchant_id}::${r.cache_product_id}`, r.product_data);
  }

  return scored
    .map((s) => {
      const p = byKey.get(`${s.merchant_id}::${s.product_id}`);
      if (!p) return null;
      return { product: p, score: s.score };
    })
    .filter(Boolean);
}

async function semanticSearchCreatorProductsFromCache(params) {
  try {
    return await vectorSearchCreatorProductsFromCache(params);
  } catch (err) {
    if (!isPgvectorMissingError(err)) throw err;
    return await vectorSearchCreatorProductsFromCacheFallback(params);
  }
}

module.exports = {
  vectorSearchCreatorProductsFromCache,
  semanticSearchCreatorProductsFromCache,
  pickVectorColumn,
};
