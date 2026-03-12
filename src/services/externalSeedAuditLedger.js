const crypto = require('node:crypto');

const { query } = require('../db');

function randomId(prefix) {
  const token =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : crypto.randomBytes(16).toString('hex');
  return `${prefix}_${token}`;
}

function ensureJsonSerializable(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

async function createExternalSeedAuditRun({ stage, market, filters, summary }) {
  const auditRunId = randomId('esar');
  const normalizedSummary = ensureJsonSerializable(summary) || {};
  await query(
    `
      INSERT INTO external_seed_audit_runs (
        audit_run_id,
        stage,
        market,
        filters,
        scanned_count,
        flagged_rows,
        findings_total,
        summary
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb)
    `,
    [
      auditRunId,
      String(stage || 'initial'),
      String(market || 'US').toUpperCase(),
      JSON.stringify(ensureJsonSerializable(filters) || {}),
      Number(normalizedSummary.scanned || 0),
      Number(normalizedSummary.flagged_rows || 0),
      Number(normalizedSummary.findings_total || 0),
      JSON.stringify(normalizedSummary),
    ],
  );
  return auditRunId;
}

async function recordExternalSeedAuditFindings(auditRunId, findings) {
  if (!auditRunId || !Array.isArray(findings) || findings.length === 0) return 0;

  const values = [];
  const params = [];
  for (const [index, finding] of findings.entries()) {
    const offset = index * 11;
    values.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}::jsonb, $${offset + 9}, $${offset + 10}, $${offset + 11})`,
    );
    params.push(
      auditRunId,
      String(finding?.seed_id || ''),
      String(finding?.domain || ''),
      String(finding?.market || ''),
      String(finding?.canonical_url || ''),
      String(finding?.anomaly_type || ''),
      String(finding?.severity || 'review'),
      JSON.stringify(ensureJsonSerializable(finding?.evidence) || {}),
      String(finding?.recommended_action || ''),
      Boolean(finding?.auto_fixable),
      String(finding?.last_extracted_at || ''),
    );
  }

  await query(
    `
      INSERT INTO external_seed_audit_findings (
        audit_run_id,
        seed_id,
        domain,
        market,
        canonical_url,
        anomaly_type,
        severity,
        evidence,
        recommended_action,
        auto_fixable,
        last_extracted_at
      )
      VALUES ${values.join(', ')}
    `,
    params,
  );

  return findings.length;
}

async function recordExternalSeedCorrection({
  seedId,
  auditRunId = null,
  correctionType,
  status,
  autoApplied,
  beforePayload,
  afterPayload,
  error = null,
}) {
  const correctionId = randomId('esc');
  await query(
    `
      INSERT INTO external_seed_corrections (
        correction_id,
        seed_id,
        audit_run_id,
        correction_type,
        status,
        auto_applied,
        before_payload,
        after_payload,
        applied_at,
        error
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
    `,
    [
      correctionId,
      String(seedId || ''),
      auditRunId || null,
      String(correctionType || 'unknown'),
      String(status || 'proposed'),
      Boolean(autoApplied),
      JSON.stringify(ensureJsonSerializable(beforePayload) || null),
      JSON.stringify(ensureJsonSerializable(afterPayload) || null),
      status === 'applied' ? new Date().toISOString() : null,
      error ? String(error) : null,
    ],
  );
  return correctionId;
}

async function fetchLatestExternalSeedCorrection(seedId) {
  const res = await query(
    `
      SELECT correction_id, correction_type, status, auto_applied, applied_at, error, created_at
      FROM external_seed_corrections
      WHERE seed_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [String(seedId || '')],
  );
  return res.rows?.[0] || null;
}

module.exports = {
  createExternalSeedAuditRun,
  recordExternalSeedAuditFindings,
  recordExternalSeedCorrection,
  fetchLatestExternalSeedCorrection,
};
