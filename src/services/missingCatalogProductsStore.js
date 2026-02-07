const { query } = require('../db');

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.trunc(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function normalizeLang(lang) {
  const raw = String(lang || '').trim().toLowerCase();
  return raw === 'cn' || raw === 'zh' || raw === 'zh-cn' ? 'cn' : 'en';
}

async function upsertMissingCatalogProduct(event) {
  if (!process.env.DATABASE_URL) {
    return { ok: false, reason: 'db_not_configured' };
  }

  const normalizedQuery = String(event?.normalized_query || '').trim();
  const querySample = String(event?.query || '').trim();
  const lang = normalizeLang(event?.lang);
  if (!normalizedQuery || !querySample) {
    return { ok: false, reason: 'missing_fields' };
  }

  const hints = event?.hints && typeof event.hints === 'object' ? event.hints : null;
  const caller = event?.caller ? String(event.caller).trim().slice(0, 120) : null;
  const sessionId = event?.session_id ? String(event.session_id).trim().slice(0, 120) : null;
  const reason = event?.reason ? String(event.reason).trim().slice(0, 120) : null;

  try {
    await query(
      `
        INSERT INTO missing_catalog_products (
          normalized_query,
          query_sample,
          lang,
          hints,
          last_caller,
          last_session_id,
          last_reason
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (normalized_query, lang)
        DO UPDATE SET
          last_seen_at = now(),
          seen_count = missing_catalog_products.seen_count + 1,
          query_sample = EXCLUDED.query_sample,
          hints = COALESCE(EXCLUDED.hints, missing_catalog_products.hints),
          last_caller = EXCLUDED.last_caller,
          last_session_id = EXCLUDED.last_session_id,
          last_reason = EXCLUDED.last_reason
      `,
      [normalizedQuery, querySample, lang, hints, caller, sessionId, reason],
    );
    return { ok: true };
  } catch (err) {
    const code = String(err?.code || '');
    if (code === '42P01') return { ok: false, reason: 'table_missing' };
    return { ok: false, reason: 'db_error', error: err?.message || String(err) };
  }
}

async function listMissingCatalogProducts(options = {}) {
  if (!process.env.DATABASE_URL) {
    return { ok: false, reason: 'db_not_configured', rows: [] };
  }

  const limit = clampInt(options.limit, { min: 1, max: 1000, fallback: 200 });
  const offset = clampInt(options.offset, { min: 0, max: 1000000, fallback: 0 });
  const sort = String(options.sort || 'last_seen').trim().toLowerCase();
  const orderBy =
    sort === 'count'
      ? 'seen_count DESC, last_seen_at DESC'
      : 'last_seen_at DESC, seen_count DESC';

  const sinceRaw = options.since ? String(options.since).trim() : '';
  const sinceMs = sinceRaw ? Date.parse(sinceRaw) : Number.NaN;
  const sinceIso = Number.isNaN(sinceMs) ? null : new Date(sinceMs).toISOString();

  const params = [];
  let where = 'TRUE';
  if (sinceIso) {
    params.push(sinceIso);
    where = `last_seen_at >= $${params.length}`;
  }
  params.push(limit);
  params.push(offset);

  try {
    const res = await query(
      `
        SELECT
          normalized_query,
          query_sample,
          lang,
          hints,
          first_seen_at,
          last_seen_at,
          seen_count,
          last_caller,
          last_session_id,
          last_reason
        FROM missing_catalog_products
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
      `,
      params,
    );
    return { ok: true, rows: res?.rows || [] };
  } catch (err) {
    const code = String(err?.code || '');
    if (code === '42P01') return { ok: false, reason: 'table_missing', rows: [] };
    return { ok: false, reason: 'db_error', rows: [], error: err?.message || String(err) };
  }
}

function toCsv(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const header = [
    'normalized_query',
    'query_sample',
    'lang',
    'seen_count',
    'first_seen_at',
    'last_seen_at',
    'last_reason',
    'last_caller',
    'last_session_id',
  ];

  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [header.join(',')];
  for (const r of safeRows) {
    lines.push(
      [
        escape(r.normalized_query),
        escape(r.query_sample),
        escape(r.lang),
        escape(r.seen_count),
        escape(r.first_seen_at),
        escape(r.last_seen_at),
        escape(r.last_reason),
        escape(r.last_caller),
        escape(r.last_session_id),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  upsertMissingCatalogProduct,
  listMissingCatalogProducts,
  toCsv,
  _internals: { normalizeLang },
};

