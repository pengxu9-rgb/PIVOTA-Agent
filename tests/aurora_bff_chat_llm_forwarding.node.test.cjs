const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

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
    if (out && typeof out.then === 'function') {
      return out.finally(restore);
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

test('/v1/chat forwards llm_provider + llm_model from body to aurora upstream', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
    },
    async () => {
      const clientModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[clientModuleId];
      const clientMod = require(clientModuleId);
      const originalAuroraChat = clientMod.auroraChat;
      let capturedCall = null;
      clientMod.auroraChat = async (args = {}) => {
        capturedCall = { ...args };
        return { answer: 'ok', intent: 'chat', cards: [] };
      };

      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];

      try {
        const { mountAuroraBffRoutes } = require(routesModuleId);
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/chat')
          .set('X-Aurora-UID', 'uid_llm_forwarding')
          .set('X-Trace-ID', 'trace_llm_forwarding')
          .set('X-Brief-ID', 'brief_llm_forwarding')
          .set('X-Lang', 'EN')
          .send({
            message: 'Hello there',
            llm_provider: 'openai',
            llm_model: 'gpt-4o-mini',
          });

        assert.equal(resp.status, 200);
        assert.ok(capturedCall);
        assert.equal(capturedCall.llm_provider, 'openai');
        assert.equal(capturedCall.llm_model, 'gpt-4o-mini');
      } finally {
        clientMod.auroraChat = originalAuroraChat;
        delete require.cache[routesModuleId];
      }
    },
  );
});

test('/v1/chat accepts llm provider/model via headers when body does not include them', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
    },
    async () => {
      const clientModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[clientModuleId];
      const clientMod = require(clientModuleId);
      const originalAuroraChat = clientMod.auroraChat;
      let capturedCall = null;
      clientMod.auroraChat = async (args = {}) => {
        capturedCall = { ...args };
        return { answer: 'ok', intent: 'chat', cards: [] };
      };

      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];

      try {
        const { mountAuroraBffRoutes } = require(routesModuleId);
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/chat')
          .set('X-Aurora-UID', 'uid_llm_header_forwarding')
          .set('X-Trace-ID', 'trace_llm_header_forwarding')
          .set('X-Brief-ID', 'brief_llm_header_forwarding')
          .set('X-Lang', 'EN')
          .set('X-LLM-Provider', 'gemini')
          .set('X-LLM-Model', 'gemini-2.5-flash')
          .send({
            message: 'Hello again',
          });

        assert.equal(resp.status, 200);
        assert.ok(capturedCall);
        assert.equal(capturedCall.llm_provider, 'gemini');
        assert.equal(capturedCall.llm_model, 'gemini-2.5-flash');
      } finally {
        clientMod.auroraChat = originalAuroraChat;
        delete require.cache[routesModuleId];
      }
    },
  );
});

test('/v1/chat uses configurable upstream timeout for main chat call', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_CHAT_UPSTREAM_TIMEOUT_MS: '34567',
    },
    async () => {
      const clientModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[clientModuleId];
      const clientMod = require(clientModuleId);
      const originalAuroraChat = clientMod.auroraChat;
      let capturedCall = null;
      clientMod.auroraChat = async (args = {}) => {
        capturedCall = { ...args };
        return { answer: 'ok', intent: 'chat', cards: [] };
      };

      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];

      try {
        const { mountAuroraBffRoutes } = require(routesModuleId);
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/chat')
          .set('X-Aurora-UID', 'uid_chat_timeout')
          .set('X-Trace-ID', 'trace_chat_timeout')
          .set('X-Brief-ID', 'brief_chat_timeout')
          .set('X-Lang', 'EN')
          .send({
            message: 'Hello there',
            llm_provider: 'openai',
            llm_model: 'gpt-4o-mini',
          });

        assert.equal(resp.status, 200);
        assert.ok(capturedCall);
        assert.equal(capturedCall.timeoutMs, 34567);
      } finally {
        clientMod.auroraChat = originalAuroraChat;
        delete require.cache[routesModuleId];
      }
    },
  );
});

test('/v1/chat exposes llm routing metadata in session patch and events', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
    },
    async () => {
      const clientModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[clientModuleId];
      const clientMod = require(clientModuleId);
      const originalAuroraChat = clientMod.auroraChat;
      clientMod.auroraChat = async () => ({
        answer: 'ok',
        intent: 'chat',
        cards: [],
        llm_provider: 'gemini',
        llm_model: 'gemini-2.5-flash',
      });

      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];

      try {
        const { mountAuroraBffRoutes } = require(routesModuleId);
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/chat')
          .set('X-Aurora-UID', 'uid_chat_llm_meta')
          .set('X-Trace-ID', 'trace_chat_llm_meta')
          .set('X-Brief-ID', 'brief_chat_llm_meta')
          .set('X-Lang', 'EN')
          .send({
            message: 'Hello there',
            llm_provider: 'openai',
            llm_model: 'gpt-4o-mini',
          });

        assert.equal(resp.status, 200);
        assert.equal(resp.body?.session_patch?.llm?.llm_provider_requested, 'openai');
        assert.equal(resp.body?.session_patch?.llm?.llm_model_requested, 'gpt-4o-mini');
        assert.equal(resp.body?.session_patch?.llm?.llm_provider_effective, 'gemini');
        assert.equal(resp.body?.session_patch?.llm?.llm_model_effective, 'gemini-2.5-flash');

        const llmRouteEvent = Array.isArray(resp.body?.events)
          ? resp.body.events.find((evt) => evt && evt.event_name === 'llm_route')
          : null;
        assert.ok(llmRouteEvent);
        assert.equal(llmRouteEvent.data?.llm_provider_requested, 'openai');
        assert.equal(llmRouteEvent.data?.llm_model_requested, 'gpt-4o-mini');
        assert.equal(llmRouteEvent.data?.llm_provider_effective, 'gemini');
        assert.equal(llmRouteEvent.data?.llm_model_effective, 'gemini-2.5-flash');
      } finally {
        clientMod.auroraChat = originalAuroraChat;
        delete require.cache[routesModuleId];
      }
    },
  );
});

test('/v1/chat keeps requested llm metadata on profile-gate early return (no upstream call)', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
    },
    async () => {
      const clientModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[clientModuleId];
      const clientMod = require(clientModuleId);
      const originalAuroraChat = clientMod.auroraChat;
      let upstreamCalls = 0;
      clientMod.auroraChat = async () => {
        upstreamCalls += 1;
        return { answer: 'ok', intent: 'chat', cards: [] };
      };

      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];

      try {
        const { mountAuroraBffRoutes } = require(routesModuleId);
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/chat')
          .set('X-Aurora-UID', 'uid_chat_llm_gate_meta')
          .set('X-Trace-ID', 'trace_chat_llm_gate_meta')
          .set('X-Brief-ID', 'brief_chat_llm_gate_meta')
          .set('X-Lang', 'EN')
          .send({
            message: 'Recommend a brightening serum under $30.',
            llm_provider: 'gemini',
            llm_model: 'gemini-2.5-flash',
          });

        assert.equal(resp.status, 200);
        assert.equal(upstreamCalls, 0);
        assert.equal(resp.body?.session_patch?.llm?.llm_provider_requested, 'gemini');
        assert.equal(resp.body?.session_patch?.llm?.llm_model_requested, 'gemini-2.5-flash');
        assert.equal(resp.body?.session_patch?.llm?.llm_provider_effective, null);
        assert.equal(resp.body?.session_patch?.llm?.llm_model_effective, null);

        const llmRouteEvent = Array.isArray(resp.body?.events)
          ? resp.body.events.find((evt) => evt && evt.event_name === 'llm_route')
          : null;
        assert.ok(llmRouteEvent);
        assert.equal(llmRouteEvent.data?.llm_provider_requested, 'gemini');
        assert.equal(llmRouteEvent.data?.llm_model_requested, 'gemini-2.5-flash');
        assert.equal(llmRouteEvent.data?.llm_provider_effective, null);
        assert.equal(llmRouteEvent.data?.llm_model_effective, null);
      } finally {
        clientMod.auroraChat = originalAuroraChat;
        delete require.cache[routesModuleId];
      }
    },
  );
});
