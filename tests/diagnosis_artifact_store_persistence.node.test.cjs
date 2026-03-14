'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadStoreWithQuery(queryImpl) {
  const dbModuleId = require.resolve('../src/db');
  const storeModuleId = require.resolve('../src/auroraBff/diagnosisArtifactStore');
  delete require.cache[storeModuleId];
  delete require.cache[dbModuleId];
  require.cache[dbModuleId] = {
    id: dbModuleId,
    filename: dbModuleId,
    loaded: true,
    exports: {
      query: queryImpl,
    },
  };
  return require('../src/auroraBff/diagnosisArtifactStore');
}

function makeArtifact() {
  return {
    artifact_id: `da_test_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    created_at: new Date().toISOString(),
    overall_confidence: { score: 0.82, level: 'high', rationale: ['test'] },
    skinType: { value: 'oily', confidence: { score: 0.82, level: 'high' }, evidence: [] },
    barrierStatus: { value: 'healthy', confidence: { score: 0.82, level: 'high' }, evidence: [] },
    sensitivity: { value: 'low', confidence: { score: 0.82, level: 'high' }, evidence: [] },
    goals: { values: ['acne'], confidence: { score: 0.82, level: 'high' }, evidence: [] },
  };
}

test('saveDiagnosisArtifact returns response_only outcome when storage is unavailable and readback misses', async () => {
  const previousRetention = process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS;
  process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = '90';
  try {
    const unavailableError = new Error('db unavailable');
    unavailableError.code = 'NO_DATABASE';
    const store = loadStoreWithQuery(async () => {
      throw unavailableError;
    });

    const saved = await store.saveDiagnosisArtifact({
      auroraUid: `uid_store_response_only_${Date.now()}`,
      artifact: makeArtifact(),
    });

    assert.ok(saved && saved.artifact_id);
    assert.equal(saved.persisted, false);
    assert.equal(saved.storage_mode, 'response_only');
    assert.equal(saved.persistence_error_code, 'NO_DATABASE');

    const latest = await store.getLatestDiagnosisArtifact({
      auroraUid: saved.aurora_uid,
      maxAgeDays: 30,
      preferArtifactId: saved.artifact_id,
    });
    assert.equal(latest, null);
  } finally {
    if (previousRetention === undefined) delete process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS;
    else process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = previousRetention;
  }
});
