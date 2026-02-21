const { randomUUID } = require('crypto');
const { query } = require('../db');

const EPHEMERAL_MAX_IDENTITIES = (() => {
  const n = Number(process.env.AURORA_DIAG_EPHEMERAL_MAX_IDENTITIES || 200);
  const value = Number.isFinite(n) ? Math.trunc(n) : 200;
  return Math.max(20, Math.min(4000, value));
})();

const ephemeral = {
  artifacts: new Map(),
  plans: new Map(),
  recoRuns: new Map(),
};

function nowIso() {
  return new Date().toISOString();
}

function parseRetentionDays() {
  const raw = String(process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS || '90').trim();
  const n = Number(raw);
  if (!Number.isFinite(n)) return 90;
  return Math.max(0, Math.min(365, Math.trunc(n)));
}

function parseMaxArtifactAgeDays(input, fallback = 30) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(365, Math.trunc(n)));
}

function persistenceDisabled() {
  return parseRetentionDays() === 0;
}

function normalizeIdentityValue(input) {
  const value = String(input || '').trim();
  if (!value) return null;
  return value.slice(0, 128);
}

function normalizeSessionId(input) {
  const value = String(input || '').trim();
  if (!value) return null;
  return value.slice(0, 128);
}

function identityKey({ auroraUid, userId }) {
  const guest = normalizeIdentityValue(auroraUid);
  const user = normalizeIdentityValue(userId);
  if (user) return `u:${user}`;
  if (guest) return `g:${guest}`;
  return null;
}

function touchMap(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > EPHEMERAL_MAX_IDENTITIES) {
    const oldest = map.keys().next().value;
    if (!oldest) break;
    map.delete(oldest);
  }
}

function toConfidenceScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function normalizeConfidenceLevel(level, score) {
  const token = String(level || '').trim().toLowerCase();
  if (token === 'low' || token === 'medium' || token === 'high') return token;
  const s = toConfidenceScore(score);
  if (!Number.isFinite(Number(s))) return null;
  if (s < 0.55) return 'low';
  if (s <= 0.75) return 'medium';
  return 'high';
}

function toSourceMix(artifact) {
  const candidates = [];
  if (Array.isArray(artifact?.source_mix)) {
    candidates.push(...artifact.source_mix);
  }
  if (Array.isArray(artifact?.evidence)) {
    for (const item of artifact.evidence) {
      if (item && typeof item === 'object' && item.source) candidates.push(item.source);
    }
  }
  const core = ['skinType', 'barrierStatus', 'sensitivity', 'goals'];
  for (const key of core) {
    const node = artifact && artifact[key] && typeof artifact[key] === 'object' ? artifact[key] : null;
    if (!node || !Array.isArray(node.evidence)) continue;
    for (const evidence of node.evidence) {
      if (evidence && typeof evidence === 'object' && evidence.source) candidates.push(evidence.source);
    }
  }
  return Array.from(
    new Set(
      candidates
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ).slice(0, 12);
}

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function isStorageUnavailableError(err) {
  const code = String(err && err.code ? err.code : '').trim();
  if (!code) return false;
  return (
    code === 'NO_DATABASE' ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    code === '42P01' ||
    code === '42P07' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND'
  );
}

function createArtifactId() {
  return `da_${randomUUID()}`;
}

function createPlanId() {
  return `ip_${randomUUID()}`;
}

function createRecoRunId() {
  return `rr_${randomUUID()}`;
}

function mapArtifactRow(row) {
  if (!row || typeof row !== 'object') return null;
  const artifact = safeJson(row.artifact_json, {});
  return {
    artifact_id: String(row.artifact_id || '').trim() || createArtifactId(),
    aurora_uid: normalizeIdentityValue(row.aurora_uid),
    user_id: normalizeIdentityValue(row.user_id),
    session_id: normalizeSessionId(row.session_id),
    artifact_json: artifact,
    confidence_score: toConfidenceScore(row.confidence_score),
    confidence_level: normalizeConfidenceLevel(row.confidence_level, row.confidence_score),
    source_mix: Array.isArray(row.source_mix) ? row.source_mix : safeJson(row.source_mix, []),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
  };
}

function mapPlanRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    plan_id: String(row.plan_id || '').trim() || createPlanId(),
    artifact_id: String(row.artifact_id || '').trim() || null,
    aurora_uid: normalizeIdentityValue(row.aurora_uid),
    user_id: normalizeIdentityValue(row.user_id),
    plan_json: safeJson(row.plan_json, {}),
    intensity: String(row.intensity || '').trim() || null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
  };
}

function isWithinDays(isoTs, days) {
  const ts = Date.parse(String(isoTs || ''));
  if (!Number.isFinite(ts)) return false;
  const maxAgeMs = parseMaxArtifactAgeDays(days) * 24 * 60 * 60 * 1000;
  return Date.now() - ts <= maxAgeMs;
}

function toArtifactRecord({
  artifactId,
  auroraUid,
  userId,
  sessionId,
  artifact,
  confidenceScore,
  confidenceLevel,
  sourceMix,
  createdAt,
}) {
  const id = String(artifactId || '').trim() || createArtifactId();
  const created = createdAt || nowIso();
  return {
    artifact_id: id,
    aurora_uid: normalizeIdentityValue(auroraUid),
    user_id: normalizeIdentityValue(userId),
    session_id: normalizeSessionId(sessionId),
    artifact_json: artifact,
    confidence_score: toConfidenceScore(confidenceScore),
    confidence_level: normalizeConfidenceLevel(confidenceLevel, confidenceScore),
    source_mix: Array.isArray(sourceMix) ? sourceMix : [],
    created_at: created,
  };
}

async function saveDiagnosisArtifact({ auroraUid, userId, sessionId, artifact, artifactId } = {}) {
  const artifactJson = artifact && typeof artifact === 'object' ? artifact : null;
  if (!artifactJson) return null;

  const coreConfidence = artifactJson.overall_confidence && typeof artifactJson.overall_confidence === 'object'
    ? artifactJson.overall_confidence
    : {};
  const confidenceScore = toConfidenceScore(coreConfidence.score);
  const confidenceLevel = normalizeConfidenceLevel(coreConfidence.level, confidenceScore);
  const sourceMix = toSourceMix(artifactJson);
  const row = toArtifactRecord({
    artifactId,
    auroraUid,
    userId,
    sessionId,
    artifact: artifactJson,
    confidenceScore,
    confidenceLevel,
    sourceMix,
  });

  const key = identityKey({ auroraUid: row.aurora_uid, userId: row.user_id });
  if (key) {
    const arr = Array.isArray(ephemeral.artifacts.get(key)) ? ephemeral.artifacts.get(key).slice() : [];
    arr.unshift(row);
    touchMap(ephemeral.artifacts, key, arr.slice(0, 30));
  }

  if (persistenceDisabled()) return row;

  try {
    const res = await query(
      `
        INSERT INTO aurora_skin_diagnosis_artifacts (
          artifact_id, aurora_uid, user_id, session_id, artifact_json, confidence_score, confidence_level, source_mix
        )
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb)
        RETURNING *
      `,
      [
        row.artifact_id,
        row.aurora_uid,
        row.user_id,
        row.session_id,
        JSON.stringify(row.artifact_json || {}),
        row.confidence_score,
        row.confidence_level,
        JSON.stringify(Array.isArray(row.source_mix) ? row.source_mix : []),
      ],
    );
    return mapArtifactRow(res.rows && res.rows[0]) || row;
  } catch (err) {
    if (isStorageUnavailableError(err)) return row;
    throw err;
  }
}

async function getDiagnosisArtifactById({ artifactId, auroraUid, userId } = {}) {
  const id = String(artifactId || '').trim();
  if (!id) return null;

  const user = normalizeIdentityValue(userId);
  const guest = normalizeIdentityValue(auroraUid);
  const key = identityKey({ auroraUid: guest, userId: user });
  if (key) {
    const local = Array.isArray(ephemeral.artifacts.get(key)) ? ephemeral.artifacts.get(key) : [];
    const found = local.find((item) => String(item && item.artifact_id || '') === id);
    if (found) return found;
  }

  if (persistenceDisabled()) return null;

  try {
    const clauses = ['artifact_id = $1'];
    const params = [id];
    let idx = 2;
    if (user) {
      clauses.push(`user_id = $${idx}`);
      params.push(user);
      idx += 1;
    } else if (guest) {
      clauses.push(`aurora_uid = $${idx}`);
      params.push(guest);
      idx += 1;
    }
    const res = await query(
      `
        SELECT artifact_id, aurora_uid, user_id, session_id, artifact_json, confidence_score, confidence_level, source_mix, created_at
        FROM aurora_skin_diagnosis_artifacts
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT 1
      `,
      params,
    );
    return mapArtifactRow(res.rows && res.rows[0]);
  } catch (err) {
    if (isStorageUnavailableError(err)) return null;
    throw err;
  }
}

async function getLatestDiagnosisArtifact({
  auroraUid,
  userId,
  sessionId,
  maxAgeDays = 30,
  preferArtifactId,
} = {}) {
  const maxAge = parseMaxArtifactAgeDays(maxAgeDays);
  const preferred = await getDiagnosisArtifactById({ artifactId: preferArtifactId, auroraUid, userId });
  if (preferred && isWithinDays(preferred.created_at, maxAge)) return preferred;

  const user = normalizeIdentityValue(userId);
  const guest = normalizeIdentityValue(auroraUid);
  const sess = normalizeSessionId(sessionId);
  const key = identityKey({ auroraUid: guest, userId: user });

  if (key) {
    const local = Array.isArray(ephemeral.artifacts.get(key)) ? ephemeral.artifacts.get(key) : [];
    const filtered = local.filter((item) => isWithinDays(item.created_at, maxAge));
    if (sess) {
      const hit = filtered.find((item) => String(item.session_id || '') === sess);
      if (hit) return hit;
    }
    if (filtered[0]) return filtered[0];
  }

  if (persistenceDisabled()) return null;
  if (!user && !guest) return null;

  try {
    const params = [];
    const where = [];
    if (user) {
      params.push(user);
      where.push(`user_id = $${params.length}`);
    } else {
      params.push(guest);
      where.push(`aurora_uid = $${params.length}`);
    }
    let sessionIdx = null;
    if (sess) {
      params.push(sess);
      sessionIdx = params.length;
    }
    params.push(maxAge);
    const ageIdx = params.length;
    const res = await query(
      `
        SELECT artifact_id, aurora_uid, user_id, session_id, artifact_json, confidence_score, confidence_level, source_mix, created_at
        FROM aurora_skin_diagnosis_artifacts
        WHERE ${where.join(' AND ')}
          AND created_at >= now() - ($${ageIdx}::int || ' days')::interval
        ORDER BY
          ${
            sessionIdx
              ? `CASE
                   WHEN session_id = $${sessionIdx} THEN 0
                   WHEN session_id IS NULL THEN 1
                   ELSE 2
                 END,`
              : ''
          }
          created_at DESC
        LIMIT 1
      `,
      params,
    );
    return mapArtifactRow(res.rows && res.rows[0]);
  } catch (err) {
    if (isStorageUnavailableError(err)) return null;
    throw err;
  }
}

async function saveIngredientPlan({ artifactId, auroraUid, userId, plan, planId } = {}) {
  const id = String(artifactId || '').trim();
  const payload = plan && typeof plan === 'object' ? plan : null;
  if (!id || !payload) return null;

  const row = {
    plan_id: String(planId || '').trim() || createPlanId(),
    artifact_id: id,
    aurora_uid: normalizeIdentityValue(auroraUid),
    user_id: normalizeIdentityValue(userId),
    plan_json: payload,
    intensity: String(payload.intensity || '').trim() || null,
    created_at: nowIso(),
  };

  if (id) {
    const local = Array.isArray(ephemeral.plans.get(id)) ? ephemeral.plans.get(id).slice() : [];
    local.unshift(row);
    touchMap(ephemeral.plans, id, local.slice(0, 10));
  }

  if (persistenceDisabled()) return row;

  try {
    const res = await query(
      `
        INSERT INTO aurora_ingredient_plans (
          plan_id, artifact_id, aurora_uid, user_id, plan_json, intensity
        )
        VALUES ($1,$2,$3,$4,$5::jsonb,$6)
        RETURNING *
      `,
      [
        row.plan_id,
        row.artifact_id,
        row.aurora_uid,
        row.user_id,
        JSON.stringify(row.plan_json || {}),
        row.intensity,
      ],
    );
    return mapPlanRow(res.rows && res.rows[0]) || row;
  } catch (err) {
    if (isStorageUnavailableError(err)) return row;
    throw err;
  }
}

async function getIngredientPlanByArtifactId({ artifactId } = {}) {
  const id = String(artifactId || '').trim();
  if (!id) return null;
  const local = Array.isArray(ephemeral.plans.get(id)) ? ephemeral.plans.get(id) : [];
  if (local[0]) return local[0];

  if (persistenceDisabled()) return null;

  try {
    const res = await query(
      `
        SELECT plan_id, artifact_id, aurora_uid, user_id, plan_json, intensity, created_at
        FROM aurora_ingredient_plans
        WHERE artifact_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [id],
    );
    return mapPlanRow(res.rows && res.rows[0]);
  } catch (err) {
    if (isStorageUnavailableError(err)) return null;
    throw err;
  }
}

async function saveRecoRun({
  artifactId,
  planId,
  auroraUid,
  userId,
  requestContext,
  reco,
  overallConfidence,
} = {}) {
  const row = {
    reco_run_id: createRecoRunId(),
    artifact_id: String(artifactId || '').trim() || null,
    plan_id: String(planId || '').trim() || null,
    aurora_uid: normalizeIdentityValue(auroraUid),
    user_id: normalizeIdentityValue(userId),
    request_context_json:
      requestContext && typeof requestContext === 'object' && !Array.isArray(requestContext) ? requestContext : {},
    reco_json: reco && typeof reco === 'object' && !Array.isArray(reco) ? reco : {},
    overall_confidence: toConfidenceScore(overallConfidence),
    created_at: nowIso(),
  };

  const key = identityKey({ auroraUid: row.aurora_uid, userId: row.user_id });
  if (key) {
    const local = Array.isArray(ephemeral.recoRuns.get(key)) ? ephemeral.recoRuns.get(key).slice() : [];
    local.unshift(row);
    touchMap(ephemeral.recoRuns, key, local.slice(0, 20));
  }

  if (persistenceDisabled()) return row;

  try {
    await query(
      `
        INSERT INTO aurora_reco_runs (
          reco_run_id, artifact_id, plan_id, aurora_uid, user_id, request_context_json, reco_json, overall_confidence
        )
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
      `,
      [
        row.reco_run_id,
        row.artifact_id,
        row.plan_id,
        row.aurora_uid,
        row.user_id,
        JSON.stringify(row.request_context_json || {}),
        JSON.stringify(row.reco_json || {}),
        row.overall_confidence,
      ],
    );
    return row;
  } catch (err) {
    if (isStorageUnavailableError(err)) return row;
    throw err;
  }
}

module.exports = {
  createArtifactId,
  createPlanId,
  saveDiagnosisArtifact,
  getLatestDiagnosisArtifact,
  getDiagnosisArtifactById,
  saveIngredientPlan,
  getIngredientPlanByArtifactId,
  saveRecoRun,
};
