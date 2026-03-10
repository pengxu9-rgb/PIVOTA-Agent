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

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function memoryIdentityKey({ auroraUid, userId } = {}) {
  const user = String(userId || '').trim();
  if (user) return `u:${user}`;
  const guest = String(auroraUid || '').trim();
  if (guest) return `g:${guest}`;
  return 'anon';
}

function createInMemoryMemoryStore() {
  const profiles = new Map();
  const recentLogs = new Map();
  const chatContexts = new Map();
  let nextLogId = 1;

  return {
    async getProfileForIdentity({ auroraUid, userId }) {
      return cloneValue(profiles.get(memoryIdentityKey({ auroraUid, userId })) || null);
    },
    async upsertProfileForIdentity({ auroraUid, userId }, patch) {
      const key = memoryIdentityKey({ auroraUid, userId });
      const prev = profiles.get(key) || {};
      const next = { ...cloneValue(prev), ...(patch && typeof patch === 'object' ? cloneValue(patch) : {}) };
      profiles.set(key, next);
      return cloneValue(next);
    },
    async getRecentSkinLogsForIdentity({ auroraUid, userId }) {
      const key = memoryIdentityKey({ auroraUid, userId });
      const rows = Array.isArray(recentLogs.get(key)) ? recentLogs.get(key).slice() : [];
      rows.sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')));
      return cloneValue(rows);
    },
    async upsertSkinLogForIdentity({ auroraUid, userId }, log) {
      const key = memoryIdentityKey({ auroraUid, userId });
      const rows = Array.isArray(recentLogs.get(key)) ? recentLogs.get(key).slice() : [];
      const incoming = log && typeof log === 'object' ? cloneValue(log) : {};
      const index = rows.findIndex((row) => String(row && row.date || '') === String(incoming.date || ''));
      const now = new Date().toISOString();
      const saved = {
        ...(index >= 0 ? rows[index] : {}),
        ...incoming,
        id: index >= 0 ? rows[index].id : String(nextLogId++),
        aurora_uid: String(auroraUid || '').trim() || null,
        routine_id: incoming.routine_id || null,
        targetProduct: incoming.targetProduct || incoming.target_product || null,
        sensation: incoming.sensation || null,
        created_at: index >= 0 ? rows[index].created_at : now,
        updated_at: now,
      };
      if (index >= 0) rows[index] = saved;
      else rows.unshift(saved);
      recentLogs.set(key, rows);
      return cloneValue(saved);
    },
    async getChatContextForIdentity({ auroraUid, userId }) {
      return cloneValue(chatContexts.get(memoryIdentityKey({ auroraUid, userId })) || null);
    },
    async upsertChatContextForIdentity({ auroraUid, userId }, patch) {
      const key = memoryIdentityKey({ auroraUid, userId });
      const prev = chatContexts.get(key) || {};
      const next = { ...cloneValue(prev), ...(patch && typeof patch === 'object' ? cloneValue(patch) : {}) };
      chatContexts.set(key, next);
      return cloneValue(next);
    },
  };
}

function createAppWithPatchedAuroraChat(options = {}) {
  const normalized =
    typeof options === 'function'
      ? { auroraChatImpl: options }
      : options && typeof options === 'object'
        ? options
        : {};
  const { auroraChatImpl, geminiJsonImpl, openAiJsonImpl, useMemoryStore = true } = normalized;
  const clientModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
  delete require.cache[clientModuleId];
  const clientMod = require(clientModuleId);
  const originalAuroraChat = clientMod.auroraChat;
  if (typeof auroraChatImpl === 'function') clientMod.auroraChat = auroraChatImpl;

  const memoryStoreModuleId = require.resolve('../src/auroraBff/memoryStore');
  delete require.cache[memoryStoreModuleId];
  const memoryStoreMod = require(memoryStoreModuleId);
  const originalMemoryStoreFns = {};
  if (useMemoryStore) {
    const patchedMemoryStore = createInMemoryMemoryStore();
    for (const [key, value] of Object.entries(patchedMemoryStore)) {
      originalMemoryStoreFns[key] = memoryStoreMod[key];
      memoryStoreMod[key] = value;
    }
  }

  const routesModuleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[routesModuleId];
  const routesMod = require(routesModuleId);
  const internalHooks =
    routesMod && routesMod.__internal && typeof routesMod.__internal === 'object'
      ? routesMod.__internal
      : {};
  if (typeof geminiJsonImpl === 'function' && typeof internalHooks.__setCallGeminiJsonObjectForTest === 'function') {
    internalHooks.__setCallGeminiJsonObjectForTest(geminiJsonImpl);
  }
  if (typeof openAiJsonImpl === 'function' && typeof internalHooks.__setCallOpenAiJsonObjectForTest === 'function') {
    internalHooks.__setCallOpenAiJsonObjectForTest(openAiJsonImpl);
  }
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  routesMod.mountAuroraBffRoutes(app, { logger: null });

  return {
    app,
    request: supertest(app),
    routesMod,
    restore() {
      clientMod.auroraChat = originalAuroraChat;
      if (typeof internalHooks.__resetCallGeminiJsonObjectForTest === 'function') internalHooks.__resetCallGeminiJsonObjectForTest();
      if (typeof internalHooks.__resetCallOpenAiJsonObjectForTest === 'function') internalHooks.__resetCallOpenAiJsonObjectForTest();
      for (const [key, value] of Object.entries(originalMemoryStoreFns)) {
        memoryStoreMod[key] = value;
      }
      delete require.cache[routesModuleId];
      delete require.cache[clientModuleId];
      delete require.cache[memoryStoreModuleId];
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
