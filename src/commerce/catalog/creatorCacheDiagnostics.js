function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function createCreatorCacheDiagnostics({
  queryDb,
  buildSellableStatusPredicate,
  buildPetSignalSql,
  routeDebugEnabled = false,
  databaseUrl = process.env.DATABASE_URL,
} = {}) {
  async function probeCreatorCacheDbStats(merchantIds, intentTarget = 'unknown', options = {}) {
    const force = options && options.force === true;
    if (!force && !routeDebugEnabled) return null;
    if (!databaseUrl) return { db_configured: false };
    if (!Array.isArray(merchantIds) || merchantIds.length === 0) {
      return { db_configured: true, merchant_ids_count: 0 };
    }

    const baseWhere = `
      merchant_id = ANY($1)
      AND (expires_at IS NULL OR expires_at > now())
      AND ${buildSellableStatusPredicate("product_data->>'status'")}
      AND COALESCE(lower(product_data->>'orderable'), 'true') <> 'false'
    `;

    const pet = buildPetSignalSql(2);
    const petWhere = intentTarget === 'pet' ? ` AND ${pet.sql}` : '';
    const petParams = intentTarget === 'pet' ? pet.params : [];

    try {
      const [allRes, sellableRes, petRes, embRes] = await Promise.all([
        queryDb(`SELECT COUNT(*)::int AS c FROM products_cache WHERE merchant_id = ANY($1)`, [merchantIds]),
        queryDb(`SELECT COUNT(*)::int AS c FROM products_cache WHERE ${baseWhere}`, [merchantIds]),
        intentTarget === 'pet'
          ? queryDb(
              `SELECT COUNT(*)::int AS c FROM products_cache WHERE ${baseWhere}${petWhere}`,
              [merchantIds, ...petParams],
            )
          : Promise.resolve({ rows: [{ c: null }] }),
        queryDb(
          `SELECT COUNT(*)::int AS c FROM products_cache_embeddings_fallback WHERE merchant_id = ANY($1)`,
          [merchantIds],
        ),
      ]);

      return {
        db_configured: true,
        merchant_ids_count: merchantIds.length,
        products_cache_total: Number(allRes.rows?.[0]?.c || 0),
        products_cache_sellable_total: Number(sellableRes.rows?.[0]?.c || 0),
        products_cache_pet_signal_sellable_total:
          intentTarget === 'pet' ? Number(petRes.rows?.[0]?.c || 0) : null,
        embeddings_fallback_total: Number(embRes.rows?.[0]?.c || 0),
      };
    } catch (err) {
      return {
        db_configured: true,
        merchant_ids_count: merchantIds.length,
        error: String(err && err.message ? err.message : err),
      };
    }
  }

  return {
    uniqueStrings,
    probeCreatorCacheDbStats,
  };
}

module.exports = {
  uniqueStrings,
  createCreatorCacheDiagnostics,
};
