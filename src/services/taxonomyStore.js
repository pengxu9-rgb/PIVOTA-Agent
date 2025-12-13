const logger = require('../logger');
const { query } = require('../db');
const { runMigrations } = require('../db/migrate');
const { ensureSeededGlobalFashion } = require('../db/seed');

const DEFAULT_VIEW_ID = process.env.TAXONOMY_VIEW_ID || 'GLOBAL_FASHION';
const DEFAULT_LOCALE = process.env.TAXONOMY_DEFAULT_LOCALE || 'en-US';

let cache = {
  key: null,
  expiresAt: 0,
  value: null,
};

function nowMs() {
  return Date.now();
}

function normalizeLocale(locale) {
  const raw = String(locale || '').trim();
  if (!raw) return DEFAULT_LOCALE;
  return raw;
}

function resolveLocaleCandidates(locale) {
  const normalized = normalizeLocale(locale);
  if (normalized === 'zh-CN') return ['zh-CN', 'en-US'];
  if (normalized === 'en-US') return ['en-US'];
  return [normalized, 'en-US'];
}

async function ensureTaxonomyReady() {
  if (!process.env.DATABASE_URL) return false;
  if (process.env.SKIP_DB_MIGRATIONS === 'true') return true;
  await runMigrations();
  await ensureSeededGlobalFashion();
  return true;
}

function buildTree(categories) {
  const byId = new Map();
  const childrenById = new Map();

  for (const cat of categories) {
    byId.set(cat.id, cat);
    childrenById.set(cat.id, []);
  }

  const roots = [];
  for (const cat of categories) {
    if (cat.parentId && byId.has(cat.parentId)) {
      childrenById.get(cat.parentId).push(cat.id);
    } else {
      roots.push(cat.id);
    }
  }

  function buildPath(id) {
    const node = byId.get(id);
    if (!node) return [];
    if (!node.parentId || !byId.has(node.parentId)) return [node.name];
    return [...buildPath(node.parentId), node.name];
  }

  for (const cat of categories) {
    cat.path = buildPath(cat.id);
  }

  return { byId, childrenById, roots };
}

async function getTaxonomyView(params = {}) {
  const viewId = params.viewId || DEFAULT_VIEW_ID;
  const locale = normalizeLocale(params.locale);
  const cacheTtlMs = Number(process.env.TAXONOMY_CACHE_TTL_MS || 30000);
  const cacheKey = `${viewId}::${locale}`;

  if (cache.key === cacheKey && cache.expiresAt > nowMs() && cache.value) {
    return cache.value;
  }

  const ready = await ensureTaxonomyReady();
  if (!ready) return null;

  const localeCandidates = resolveLocaleCandidates(locale);

  const rows = await query(
    `
      SELECT
        cc.id,
        cc.slug,
        cc.parent_id,
        cc.level,
        cc.status,
        cc.replaced_by_id,
        COALESCE(tvc.visibility_override, 'visible') AS visibility,
        COALESCE(tvc.priority_override, cc.default_priority) AS priority,
        COALESCE(tvc.image_override, cc.default_image_url) AS image_url,
        tv.market AS market,
        tv.view_id AS view_id,
        COALESCE(ops.pinned, false) AS ops_pinned,
        COALESCE(ops.hidden, false) AS ops_hidden,
        ops.display_name_override AS ops_name,
        ops.image_override AS ops_image,
        COALESCE(ops.priority_boost, 0) AS ops_boost,
        loc.display_name AS loc_name
      FROM taxonomy_view tv
      JOIN taxonomy_view_category tvc ON tvc.view_id = tv.view_id
      JOIN canonical_category cc ON cc.id = tvc.category_id
      LEFT JOIN ops_category_override ops ON ops.category_id = cc.id
      LEFT JOIN LATERAL (
        SELECT display_name
        FROM category_localization
        WHERE category_id = cc.id AND locale = ANY($2)
        ORDER BY array_position($2, locale)
        LIMIT 1
      ) loc ON true
      WHERE tv.view_id = $1
        AND tv.status = 'active'
    `,
    [viewId, localeCandidates],
  );

  if (!rows.rows.length) {
    logger.warn({ viewId }, 'No taxonomy view rows found');
  }

  const categories = rows.rows
    .map((r) => {
      const id = r.id;
      const slug = r.slug;
      const parentId = r.parent_id || null;
      const level = Number(r.level || 0);
      const status = r.status;
      const replacedById = r.replaced_by_id || null;
      const visibility = r.visibility || 'visible';
      const priority = Number(r.priority || 0);
      const imageUrl = r.ops_image || r.image_url || null;
      const baseName = r.ops_name || r.loc_name || slug;

      const hidden = Boolean(r.ops_hidden) || status === 'hidden' || visibility === 'hidden' || id === 'other';
      const pinned = Boolean(r.ops_pinned);
      const priorityBoost = Number(r.ops_boost || 0);

      return {
        id,
        slug,
        name: baseName,
        parentId,
        level,
        status,
        replacedById,
        visibility,
        imageUrl,
        pinned,
        priorityBase: priority,
        priorityBoost,
        priority: priority + priorityBoost,
        path: [],
        market: r.market || 'GLOBAL',
        viewId: r.view_id || viewId,
        hidden,
      };
    })
    .filter((c) => c.status !== 'deprecated' || c.replacedById);

  // Resolve deprecated categories to their replacements (view membership is on the deprecated id).
  const byIdPre = new Map(categories.map((c) => [c.id, c]));
  const replaced = [];
  for (const c of categories) {
    if (c.status === 'deprecated' && c.replacedById) {
      const rep = byIdPre.get(c.replacedById);
      if (rep) continue;
      replaced.push({
        ...c,
        id: c.replacedById,
        slug: c.replacedById,
        status: 'active',
        replacedById: null,
      });
    }
  }

  const merged = [...categories, ...replaced];
  const { byId, childrenById, roots } = buildTree(merged);

  const version = process.env.TAXONOMY_VERSION || `${viewId}@v1`;

  const value = {
    version,
    market: rows.rows[0]?.market || 'GLOBAL',
    locale,
    viewId,
    byId,
    childrenById,
    roots,
  };

  cache = {
    key: cacheKey,
    expiresAt: nowMs() + cacheTtlMs,
    value,
  };

  return value;
}

module.exports = {
  getTaxonomyView,
  normalizeLocale,
};

