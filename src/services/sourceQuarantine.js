'use strict';

const MATCH_TYPE_DOMAIN = 'domain';
const MATCH_TYPE_MERCHANT_PLATFORM = 'merchant_platform';
const MATCH_TYPE_SOURCE_SYSTEM_REF = 'source_system_ref';

const VALID_MATCH_TYPES = new Set([
  MATCH_TYPE_DOMAIN,
  MATCH_TYPE_MERCHANT_PLATFORM,
  MATCH_TYPE_SOURCE_SYSTEM_REF,
]);

function buildQuarantineAntiJoinSql({
  domainExpr,
  merchantExpr,
  platformExpr,
  sourceSystemExpr,
  sourceRefExpr,
} = {}) {
  const expressions = [domainExpr, merchantExpr, platformExpr, sourceSystemExpr, sourceRefExpr];
  if (expressions.some((expr) => !asString(expr))) {
    throw new Error('all row SQL expressions are required');
  }

  return `
AND NOT EXISTS (
  SELECT 1 FROM catalog_source_quarantine q
  WHERE q.state = 'active'
    AND (q.expires_at IS NULL OR q.expires_at > now())
    AND (
      (q.match_type = 'domain' AND lower(q.match_value) = lower(${domainExpr}))
      OR (q.match_type = 'merchant_platform' AND q.match_value = ${merchantExpr} || ':' || ${platformExpr})
      OR (q.match_type = 'source_system_ref' AND q.match_value = ${sourceSystemExpr} || ':' || ${sourceRefExpr})
    )
)`.trim();
}

async function loadActiveQuarantines({ dbPool } = {}) {
  if (!dbPool || typeof dbPool.query !== 'function') {
    throw new Error('dbPool with query(sql, params) is required');
  }
  const result = await dbPool.query(`
    SELECT
      quarantine_id,
      match_type,
      match_value,
      state,
      reason,
      expires_at,
      created_by,
      created_at,
      revoked_at,
      revoked_by,
      metadata
    FROM catalog_source_quarantine
    WHERE state = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created_at DESC, quarantine_id DESC
  `);
  return Array.isArray(result?.rows) ? result.rows : [];
}

async function isSourceQuarantined(
  { domain, merchantId, platform, sourceSystem, sourceRef } = {},
  { dbPool } = {},
) {
  const quarantines = await loadActiveQuarantines({ dbPool });
  return quarantines.some((quarantine) =>
    quarantineMatchesSource(quarantine, {
      domain,
      merchantId,
      platform,
      sourceSystem,
      sourceRef,
    }),
  );
}

function quarantineMatchesSource(
  quarantine,
  { domain, merchantId, platform, sourceSystem, sourceRef } = {},
  { now = new Date() } = {},
) {
  if (!quarantine || quarantine.state !== 'active') return false;
  if (isExpired(quarantine.expires_at, now)) return false;

  if (quarantine.match_type === MATCH_TYPE_DOMAIN) {
    return normalizeDomain(quarantine.match_value) === normalizeDomain(domain);
  }
  if (quarantine.match_type === MATCH_TYPE_MERCHANT_PLATFORM) {
    return asString(quarantine.match_value) === joinMatchValue(merchantId, platform);
  }
  if (quarantine.match_type === MATCH_TYPE_SOURCE_SYSTEM_REF) {
    return asString(quarantine.match_value) === joinMatchValue(sourceSystem, sourceRef);
  }
  return false;
}

function isExpired(expiresAt, now) {
  if (!expiresAt) return false;
  const expires = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) return false;
  return expires.getTime() <= now.getTime();
}

function normalizeDomain(value) {
  return asString(value).toLowerCase();
}

function joinMatchValue(left, right) {
  const leftText = asString(left);
  const rightText = asString(right);
  if (!leftText || !rightText) return null;
  return `${leftText}:${rightText}`;
}

function asString(value) {
  return String(value ?? '').trim();
}

module.exports = {
  MATCH_TYPE_DOMAIN,
  MATCH_TYPE_MERCHANT_PLATFORM,
  MATCH_TYPE_SOURCE_SYSTEM_REF,
  VALID_MATCH_TYPES,
  buildQuarantineAntiJoinSql,
  isSourceQuarantined,
  loadActiveQuarantines,
  quarantineMatchesSource,
};
