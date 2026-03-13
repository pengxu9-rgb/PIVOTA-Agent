const { query } = require('../db');
const { kbQuery } = require('./pciKbClient');
const { auditExternalSeedRow, summarizeAuditResults } = require('./externalSeedContentAudit');
const { buildExternalSeedHarvesterCandidates } = require('./externalSeedHarvesterBridge');
const { ensureJsonObject } = require('./externalSeedProducts');

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function normalizeUrlLike(value) {
  const normalized = normalizeNonEmptyString(value);
  return /^https?:\/\//i.test(normalized) ? normalized : '';
}

function normalizeComparableUrlKey(value) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] && /^[a-z]{2}(?:-|_)[a-z]{2}$/i.test(segments[0])) segments.shift();
    parsed.pathname = `/${segments.join('/')}`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

function pickBestSeedRow(rows, { externalSeedId, productUrl }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (externalSeedId) {
    return rows.find((row) => normalizeNonEmptyString(row.id) === normalizeNonEmptyString(externalSeedId)) || rows[0];
  }

  const comparableProductUrl = normalizeComparableUrlKey(productUrl);
  if (comparableProductUrl) {
    const exact = rows.find((row) => {
      const seedData = ensureJsonObject(row.seed_data);
      const snapshot = ensureJsonObject(seedData.snapshot);
      return [
        row.canonical_url,
        row.destination_url,
        snapshot.canonical_url,
        snapshot.destination_url,
      ]
        .map(normalizeComparableUrlKey)
        .includes(comparableProductUrl);
    });
    if (exact) return exact;
  }

  return rows[0];
}

async function fetchSeedRows({ externalSeedId, productUrl }) {
  const params = [];
  const where = [];

  if (externalSeedId) {
    params.push(normalizeNonEmptyString(externalSeedId));
    where.push(`id::text = $${params.length}`);
  }

  if (productUrl) {
    params.push(normalizeUrlLike(productUrl));
    const bind = `$${params.length}`;
    where.push(
      `(
        canonical_url = ${bind}
        OR destination_url = ${bind}
        OR seed_data->>'canonical_url' = ${bind}
        OR seed_data->>'destination_url' = ${bind}
        OR seed_data->'snapshot'->>'canonical_url' = ${bind}
        OR seed_data->'snapshot'->>'destination_url' = ${bind}
      )`,
    );
  }

  if (where.length === 0) return [];

  const sql = `
    SELECT
      id,
      external_product_id,
      market,
      domain,
      canonical_url,
      destination_url,
      title,
      image_url,
      price_amount,
      price_currency,
      availability,
      seed_data,
      updated_at,
      created_at
    FROM external_product_seeds
    WHERE ${where.join(' OR ')}
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 25
  `;
  const res = await query(sql, params);
  return res.rows || [];
}

async function fetchKbCoverage(candidateIds) {
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
    return {
      tableAvailable: false,
      rows: [],
    };
  }

  try {
    const runQuery = async (text, params) => (await kbQuery(text, params)) || query(text, params);
    const tableCheck = await runQuery(`SELECT to_regclass('pci_kb.sku_ingredients') AS table_name`);
    const available = Boolean(tableCheck.rows?.[0]?.table_name);
    if (!available) return { tableAvailable: false, rows: [] };

    const res = await runQuery(
      `
        SELECT
          sku_key,
          market,
          parse_status,
          review_status,
          audit_status,
          ingest_allowed,
          raw_ingredient_text_clean,
          inci_list
        FROM pci_kb.sku_ingredients
        WHERE sku_key = ANY($1::text[])
      `,
      [candidateIds],
    );
    return {
      tableAvailable: true,
      rows: res.rows || [],
    };
  } catch {
    return {
      tableAvailable: false,
      rows: [],
    };
  }
}

async function getExternalSeedPipelineStatus({ externalSeedId, productUrl }) {
  const rows = await fetchSeedRows({ externalSeedId, productUrl });
  const row = pickBestSeedRow(rows, { externalSeedId, productUrl });
  if (!row) return null;

  const audit = auditExternalSeedRow(row);
  const candidates = buildExternalSeedHarvesterCandidates(row);
  const candidateIds = candidates.map((candidate) => candidate.candidate_id);
  const kb = await fetchKbCoverage(candidateIds);
  const matchedKeys = new Set(kb.rows.map((item) => normalizeNonEmptyString(item.sku_key)));
  const parseOkCount = kb.rows.filter((item) => normalizeNonEmptyString(item.parse_status).toUpperCase() === 'OK').length;
  const ingredientCoveredCount = kb.rows.filter(
    (item) => normalizeNonEmptyString(item.raw_ingredient_text_clean) || normalizeNonEmptyString(item.inci_list),
  ).length;

  const blockerCount = audit.findings.filter((finding) => finding.severity === 'blocker').length;
  const reviewCount = audit.findings.filter((finding) => finding.severity === 'review').length;
  const diagnostics = ensureJsonObject(ensureJsonObject(row.seed_data).snapshot?.diagnostics);

  return {
    seed: {
      id: normalizeNonEmptyString(row.id),
      external_product_id: normalizeNonEmptyString(row.external_product_id),
      market: normalizeNonEmptyString(row.market).toUpperCase(),
      domain: normalizeNonEmptyString(row.domain),
      canonical_url: normalizeUrlLike(
        ensureJsonObject(ensureJsonObject(row.seed_data).snapshot).canonical_url || row.canonical_url,
      ),
      title: normalizeNonEmptyString(ensureJsonObject(ensureJsonObject(row.seed_data).snapshot).title || row.title),
      last_extracted_at: normalizeNonEmptyString(
        ensureJsonObject(ensureJsonObject(row.seed_data).snapshot).extracted_at || row.updated_at,
      ),
      diagnostics,
    },
    audit,
    audit_summary: summarizeAuditResults([audit]),
    coverage: {
      candidate_count: candidateIds.length,
      kb_table_available: kb.tableAvailable,
      kb_row_count: kb.rows.length,
      kb_parse_ok_count: parseOkCount,
      ingredient_covered_count: ingredientCoveredCount,
      kb_coverage_status:
        !kb.tableAvailable
          ? 'unknown'
          : matchedKeys.size === 0
            ? 'missing'
            : matchedKeys.size === candidateIds.length
              ? 'complete'
              : 'partial',
      ingredient_coverage_status:
        ingredientCoveredCount === 0
          ? blockerCount > 0
            ? 'blocked'
            : 'ready_for_harvest'
          : ingredientCoveredCount === candidateIds.length
            ? 'complete'
            : 'partial',
      matched_candidate_ids: candidateIds.filter((candidateId) => matchedKeys.has(candidateId)),
    },
    gating: {
      extraction_status: diagnostics.failure_category ? 'degraded' : 'ok',
      audit_status: blockerCount > 0 ? 'blocked' : reviewCount > 0 ? 'needs_review' : 'ok',
      next_step:
        blockerCount > 0
          ? 'fix_blockers_before_harvest'
          : ingredientCoveredCount === candidateIds.length
            ? 'ready_for_kb_use'
            : 'ready_for_harvest',
    },
    harvester_candidates: candidates,
  };
}

module.exports = {
  getExternalSeedPipelineStatus,
};
