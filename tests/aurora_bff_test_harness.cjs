const express = require('express');
const supertest = require('supertest');
const axios = require('axios');

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAsSAAALEgHS3X78AAAA' +
    'B3RJTUUH5AICDgYk4fYQPgAAAB1pVFh0Q29tbWVudAAAAAAAvK6ymQAAAHVJREFUWMPtzsENwCAQ' +
    'BEG9/5f2QxA6i1xAikQW2L8z8V8YfM+K7QwAAAAAAAAAAAAAAAB4t6x3K2W3fQn2eZ5n4J1wV2k8vT' +
    '3uQv2bB0hQ7m9t9h9m9M6r8f3A2f0A8Qf8Sg8x9I3hM8AAAAASUVORK5CYII=',
  'base64',
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withEnv(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch || {})) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

function buildTestUid(seed) {
  return `uid_${seed}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function headersFor(uid, lang = 'EN') {
  return {
    'X-Aurora-UID': uid,
    'X-Trace-ID': `trace_${uid}`,
    'X-Brief-ID': `brief_${uid}`,
    'X-Lang': lang,
  };
}

function createAppWithPatchedAuroraChat(auroraChatImpl) {
  const clientModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
  delete require.cache[clientModuleId];
  const clientMod = require(clientModuleId);
  const originalAuroraChat = clientMod.auroraChat;
  if (typeof auroraChatImpl === 'function') clientMod.auroraChat = auroraChatImpl;

  const routesModuleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[routesModuleId];
  const routesMod = require(routesModuleId);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  routesMod.mountAuroraBffRoutes(app, { logger: null });

  return {
    app,
    request: supertest(app),
    routesMod,
    restore() {
      clientMod.auroraChat = originalAuroraChat;
      delete require.cache[routesModuleId];
      delete require.cache[clientModuleId];
    },
  };
}

async function seedCompleteProfile(request, uid, lang = 'EN', patch = {}) {
  await request
    .post('/v1/profile/update')
    .set(headersFor(uid, lang))
    .send({
      skinType: 'oily',
      sensitivity: 'low',
      barrierStatus: 'healthy',
      goals: ['acne', 'hydration'],
      budgetTier: '$50',
      region: 'US',
      ...patch,
    })
    .expect(200);
}

function parseCards(body) {
  return Array.isArray(body && body.cards) ? body.cards : [];
}

function findCard(cards, type) {
  return (Array.isArray(cards) ? cards : []).find((c) => c && c.type === type) || null;
}

function patchPhotoDownloadAxios({
  signedDownloadUrl = 'https://signed-download.test/test-photo',
  mode = 'ok',
} = {}) {
  const originalGet = axios.get;
  const originalPost = axios.post;
  const originalRequest = axios.request;

  axios.post = originalPost;
  axios.request = originalRequest;
  axios.get = async (url) => {
    const u = String(url || '');
    if (u.endsWith('/photos/download-url')) {
      return {
        status: 200,
        data: {
          download: {
            url: signedDownloadUrl,
            expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
          },
          content_type: 'image/png',
        },
      };
    }
    if (u === signedDownloadUrl) {
      if (mode === 'reset') {
        const err = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      }
      if (mode === 'timeout') {
        const err = new Error('timeout of 1200ms exceeded');
        err.code = 'ECONNABORTED';
        throw err;
      }
      return {
        status: 200,
        data: PNG_BYTES,
        headers: { 'content-type': 'image/png' },
      };
    }
    throw new Error(`Unexpected axios.get url: ${u}`);
  };

  return () => {
    axios.get = originalGet;
    axios.post = originalPost;
    axios.request = originalRequest;
  };
}

function createDiagnosisArtifactFixture({
  confidenceScore = 0.85,
  confidenceLevel = undefined,
  analysisSource = 'rule_based',
  qualityGrade = 'pass',
  usePhoto = true,
} = {}) {
  const score = Number.isFinite(Number(confidenceScore)) ? Math.max(0, Math.min(1, Number(confidenceScore))) : 0.85;
  const level =
    confidenceLevel ||
    (score < 0.55 ? 'low' : score <= 0.75 ? 'medium' : 'high');
  const now = new Date().toISOString();
  return {
    artifact_id: `da_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    created_at: now,
    use_photo: Boolean(usePhoto),
    overall_confidence: {
      score,
      level,
      rationale: ['test_fixture'],
    },
    skinType: {
      value: 'oily',
      confidence: { score: 0.8, level: 'high', rationale: ['profile'] },
      evidence: [{ source: 'profile', supports: ['skinType'] }],
    },
    barrierStatus: {
      value: 'healthy',
      confidence: { score: 0.8, level: 'high', rationale: ['profile'] },
      evidence: [{ source: 'profile', supports: ['barrierStatus'] }],
    },
    sensitivity: {
      value: 'low',
      confidence: { score: 0.8, level: 'high', rationale: ['profile'] },
      evidence: [{ source: 'profile', supports: ['sensitivity'] }],
    },
    goals: {
      values: ['acne', 'hydration'],
      confidence: { score: 0.8, level: 'high', rationale: ['profile'] },
      evidence: [{ source: 'profile', supports: ['goals'] }],
    },
    concerns: [],
    photos: usePhoto
      ? [{ slot: 'daylight', photo_id: `photo_${Date.now()}`, qc_status: qualityGrade === 'fail' ? 'failed' : 'passed' }]
      : [],
    safety: {
      non_medical_disclaimer_version: 'v1',
      red_flags: [],
    },
    analysis_context: {
      analysis_source: analysisSource,
      used_photos: Boolean(usePhoto),
      quality_grade: qualityGrade,
    },
    source_mix: usePhoto ? ['photo', 'profile'] : ['profile', 'rule'],
    session_patch: { next_state: 'S5_ANALYSIS_SUMMARY' },
  };
}

async function seedDiagnosisArtifactForUid(uid, artifact) {
  const store = require('../src/auroraBff/diagnosisArtifactStore');
  return store.saveDiagnosisArtifact({ auroraUid: uid, artifact });
}

module.exports = {
  sleep,
  withEnv,
  buildTestUid,
  headersFor,
  createAppWithPatchedAuroraChat,
  seedCompleteProfile,
  parseCards,
  findCard,
  patchPhotoDownloadAxios,
  createDiagnosisArtifactFixture,
  seedDiagnosisArtifactForUid,
};
