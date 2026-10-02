const { activeCatalogProductSourceWhere } = require('../services/activeCatalogSourceSql');

function normalizeUncoveredCooldownDays(value) {
  const n = Number(value);
  return value === '' || value == null || !Number.isFinite(n) ? 7 : Math.max(1, Math.min(90, Math.trunc(n)));
}

// Fail closed when the PDP render probe is missing or older than a week.
const PDP_RENDER_FRESHNESS_DAYS = 7;

function normalizeCoverageSiblingRefs(value = true) {
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

// The job does not inherit gateway hydration flags. Its explicit sibling option defaults to
// true to match production serving; operators must change it with the gateway hydration flag.
function catalogCoverageSql(alias = 'cp', { marketSql = '$2', cooldownDays = 7, coverageSiblingRefs = true, suppressedIdsSql, requireFreshPdp = true } = {}) {
  if (typeof suppressedIdsSql !== 'string' || !suppressedIdsSql.trim()) {
    throw new Error('Uncovered priority requires suppressedIdsSql from the shared serving scan');
  }
  const days = normalizeUncoveredCooldownDays(cooldownDays);
  const siblings = normalizeCoverageSiblingRefs(coverageSiblingRefs);
  return `WITH member_keys AS (
        SELECT ${alias}.product_key
        ${siblings ? `UNION
        SELECT sibling.product_key FROM catalog_products sibling
        WHERE ${alias}.content_key IS NOT NULL AND ${alias}.content_key <> ''
          AND sibling.content_key = ${alias}.content_key
        UNION
        SELECT sibling.product_key
        FROM product_group_members own_member
        JOIN product_group_members sibling_member ON sibling_member.product_group_id = own_member.product_group_id
        JOIN catalog_products sibling ON sibling.merchant_id = sibling_member.merchant_id
          AND sibling.platform = sibling_member.platform
          AND sibling.source_product_id = sibling_member.platform_product_id
        WHERE own_member.merchant_id = ${alias}.merchant_id AND own_member.platform = ${alias}.platform
          AND own_member.platform_product_id = ${alias}.source_product_id` : ''}
      ), members AS MATERIALIZED (
        SELECT member.*, pgm.product_group_id AS coverage_group_id, pgm.is_primary AS coverage_is_primary FROM member_keys
        JOIN catalog_products member ON member.product_key = member_keys.product_key
        LEFT JOIN catalog_merchants member_merchant ON member_merchant.merchant_id = member.merchant_id
        LEFT JOIN product_group_members pgm ON pgm.merchant_id = member.merchant_id
          AND pgm.platform = member.platform AND pgm.platform_product_id = member.source_product_id
        WHERE ${activeCatalogProductSourceWhere('member', 'member_merchant')}
          ${siblings ? 'AND member.pivota_signature_id IS NOT NULL' : ''}
        ORDER BY CASE WHEN pgm.is_primary = true THEN 0 ELSE 1 END,
          CASE member.pdp_lifecycle_stage WHEN 'published' THEN 0 WHEN 'validated' THEN 1
            WHEN 'candidate' THEN 2 WHEN 'draft' THEN 3 ELSE 9 END,
          member.pivota_signature_minted_at ASC NULLS LAST,
          member.updated_at DESC NULLS LAST, member.product_key ASC
        LIMIT 100
      ), canonical_group AS (
        -- Same ordering and 100-member bound as resolveCanonicalCatalogEntityGroup. Serving
        -- takes the first non-null group id from those ordered rows, not every member group.
        SELECT member.coverage_group_id AS product_group_id FROM members member
        WHERE member.coverage_group_id IS NOT NULL
        ORDER BY CASE WHEN member.coverage_is_primary = true THEN 0 ELSE 1 END,
          CASE member.pdp_lifecycle_stage WHEN 'published' THEN 0 WHEN 'validated' THEN 1
            WHEN 'candidate' THEN 2 WHEN 'draft' THEN 3 ELSE 9 END,
          member.pivota_signature_minted_at ASC NULLS LAST,
          member.updated_at DESC NULLS LAST, member.product_key ASC
        LIMIT 1
      ), anchor_refs AS MATERIALIZED (
        SELECT lower('product:' || ref.id) AS ref FROM members
        CROSS JOIN LATERAL (VALUES (members.pivota_signature_id), (members.source_product_id)) ref(id)
        WHERE ref.id IS NOT NULL AND ref.id <> ''
        UNION
        SELECT lower('product:' || ref.id)
        FROM (VALUES (${alias}.pivota_signature_id), (${alias}.source_product_id)) ref(id)
        WHERE ref.id IS NOT NULL AND ref.id <> ''
        UNION
        SELECT lower('product:' || seed.external_product_id) FROM external_product_seeds seed
        WHERE seed.attached_product_key = ${alias}.product_key
        UNION
        SELECT lower('product:' || coverage_seed.external_product_id)
        FROM members JOIN external_product_seeds coverage_seed
          ON coverage_seed.attached_product_key = members.product_key
        ${siblings ? "UNION SELECT lower('product:' || product_group_id) FROM canonical_group WHERE product_group_id ~* '^pg_'" : ''}
      ), activity AS (
        SELECT max(GREATEST(rcl.created_at, rcl.updated_at, rcl.reviewed_at)) AS last_activity,
          bool_or(rcl.label_state IN ('ai_approved', 'human_approved')
            AND rcl.last_verified_at IS NOT NULL AND rcl.expires_at > now()
            AND NOT (rcl.label_state = 'ai_approved' AND rcl.relation_type = 'dupe'
              AND NOT COALESCE(rcl.provenance #>> '{ai_review,cross_agent_review,schema}' = 'relgraph.cross_agent_review.v1'
                AND rcl.provenance #>> '{ai_review,cross_agent_review,verdict}' = 'approve', false))
            AND NOT (rcl.anchor_type = 'product' AND btrim(rcl.anchor_ref) ~* '^product:.*:')
            AND NOT (btrim(rcl.candidate_product_ref) ~* '^product:.*:')
            AND NOT (rcl.id = ANY(${suppressedIdsSql}))) AS covered,
          bool_and(rcl.label_state IN ('human_rejected', 'prefilter_rejected', 'needs_evidence')) AS terminal_only
        FROM anchor_refs refs
        CROSS JOIN LATERAL (
          SELECT * FROM relationship_candidate_labels labels
          WHERE lower(labels.anchor_ref) = refs.ref
            AND lower(labels.market) = lower(${marketSql}) AND labels.vertical = 'beauty'
          OFFSET 0
        ) rcl
      ), attempts AS (
        SELECT max(attempt.last_attempt_at) AS last_attempt
        FROM anchor_refs refs JOIN relationship_graph_anchor_attempts attempt ON attempt.anchor_ref = refs.ref
          AND attempt.market = upper(${marketSql}) AND attempt.vertical = 'beauty'
      ), status AS (
        SELECT GREATEST(activity.last_activity, attempts.last_attempt) AS relgraph_last_activity,
          activity.covered, activity.terminal_only FROM activity CROSS JOIN attempts
      )
      SELECT status.relgraph_last_activity,
        CASE WHEN status.relgraph_last_activity >= now() - interval '${days} days' THEN -1
          WHEN ${alias}.product_key IS NOT NULL AND ${activeCatalogProductSourceWhere(alias, 'cm')}
            AND ${alias}.suppressed_at IS NULL AND ${alias}.suppression_reason IS NULL
            ${requireFreshPdp ? `AND ${alias}.pdp_will_render IS TRUE
            AND ${alias}.pdp_will_render_computed_at >= now() - interval '${PDP_RENDER_FRESHNESS_DAYS} days'` : '-- Offline freshness worklist: the validator, not an old stamp, decides renderability.'}
            AND NOT COALESCE(status.covered, false)
          THEN CASE WHEN status.relgraph_last_activity IS NULL THEN 3
            WHEN COALESCE(status.terminal_only, false) THEN 1 ELSE 2 END
          ELSE 0 END AS relgraph_priority FROM status`;
}

function coverageCatalogJoinSql(alias, options) {
  return `CROSS JOIN LATERAL (${catalogCoverageSql(alias, options)}) coverage`;
}

function uncoveredLiveCatalogSql(alias = 'cp', options = {}) {
  return `(SELECT relgraph_priority > 0 FROM (${catalogCoverageSql(alias, options)}) coverage)`;
}

async function requireAnchorAttemptsTable(queryFn) {
  const result = await queryFn(`WITH schema_access AS (
      SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS has_schema_usage
    ), target AS (
      SELECT has_schema_usage,
        CASE WHEN has_schema_usage THEN to_regclass('relationship_graph_anchor_attempts') ELSE NULL END AS table_name
      FROM schema_access
    )
    SELECT has_schema_usage, table_name::text AS table_name,
      CASE WHEN table_name IS NOT NULL THEN has_table_privilege(current_user, table_name, 'INSERT') ELSE false END AS can_insert,
      CASE WHEN table_name IS NOT NULL THEN has_table_privilege(current_user, table_name, 'SELECT') ELSE false END AS can_select,
      CASE WHEN table_name IS NOT NULL THEN has_table_privilege(current_user, table_name, 'UPDATE') ELSE false END AS can_update
    FROM target`);
  if (result.rows?.[0]?.has_schema_usage !== true) {
    const error = new Error('Uncovered priority requires USAGE on schema public for the role in secret DATABASE_URL_NOVERIFY (mounted as DATABASE_URL)');
    error.code = 'RELGRAPH_ANCHOR_ATTEMPTS_PRIVILEGES';
    throw error;
  }
  if (!result.rows[0].table_name) {
    const error = new Error('Uncovered priority requires migration 061_relationship_graph_anchor_attempts.sql before enabling the flag');
    error.code = 'RELGRAPH_ANCHOR_ATTEMPTS_MISSING';
    throw error;
  }
  if (result.rows[0].can_insert !== true || result.rows[0].can_select !== true || result.rows[0].can_update !== true) {
    const error = new Error('Uncovered priority requires INSERT, SELECT and UPDATE on relationship_graph_anchor_attempts for the role in secret DATABASE_URL_NOVERIFY (mounted as DATABASE_URL)');
    error.code = 'RELGRAPH_ANCHOR_ATTEMPTS_PRIVILEGES';
    throw error;
  }
}

// Page fresh approved snapshots before source LIMITs and let serving's one guard owner
// decide all title rules. Passing only hidden ids retains indexed per-anchor coverage probes.
async function loadCoverageSuppressedIds({ queryFn, market = 'US' }) {
  await requireAnchorAttemptsTable(queryFn);
  const { scanServingLabels } = require('../services/relationshipGraphServingScan');
  const { suppressedIds } = await scanServingLabels({ queryFn, market, collectSuppressedIds: true });
  return suppressedIds;
}

// Record the attempt before edge writes, including zero-edge attempts and protected labels.
// Dry runs never call this. A failed write still represents an attempt and cools down the anchor.
async function recordAnchorAttempts({ anchors = [], market = 'US', queryFn }) {
  const refs = [...new Set(anchors.flatMap(productAnchorRefs))];
  if (!refs.length) return;
  await queryFn(`INSERT INTO relationship_graph_anchor_attempts (anchor_ref, market, vertical, last_attempt_at)
    SELECT ref, upper($2), 'beauty', now() FROM unnest($1::text[]) ref
    ON CONFLICT (anchor_ref, market, vertical) DO UPDATE SET last_attempt_at = EXCLUDED.last_attempt_at`, [refs, market]);
}

function productAnchorRefs(product) {
  // Loaded lazily: the serving graph also imports source normalization.
  const { buildAnchorRefsFromProduct } = require('./productRelationshipGraph');
  return [...buildAnchorRefsFromProduct(product), product.product_ref || '']
    .filter((ref) => /^product:/i.test(ref))
    .map((ref) => ref.toLowerCase());
}

// Reuse serving's ref forms, including the signature identity preserved by #2265. A stable
// ordering preserves activity rank through source normalization and deduplication.
function prioritizeUncoveredProducts(products, uncoveredProducts) {
  const ranks = new Map();
  for (const product of uncoveredProducts) {
    for (const ref of productAnchorRefs(product)) {
      const rank = { priority: product._relgraph_priority ?? 3,
        activity: product._relgraph_last_activity ? new Date(product._relgraph_last_activity).getTime() : -Infinity };
      const previous = ranks.get(ref);
      if (!previous || rank.priority > previous.priority ||
        (rank.priority === previous.priority && rank.activity < previous.activity)) ranks.set(ref, rank);
    }
  }
  const rankFor = (product) => productAnchorRefs(product).map((ref) => ranks.get(ref)).filter(Boolean)
    .sort((a, b) => b.priority - a.priority || a.activity - b.activity)[0] || { priority: 0, activity: 0 };
  return [...products].sort((a, b) => {
    const left = rankFor(a); const right = rankFor(b);
    return right.priority - left.priority || (left.activity - right.activity || 0);
  });
}

module.exports = { catalogCoverageSql, requireAnchorAttemptsTable, loadCoverageSuppressedIds, PDP_RENDER_FRESHNESS_DAYS, normalizeCoverageSiblingRefs, coverageCatalogJoinSql, recordAnchorAttempts, normalizeUncoveredCooldownDays, uncoveredLiveCatalogSql, prioritizeUncoveredProducts, productAnchorRefs };
