'use strict';

const nock = require('nock');
const { createProviderFromEnv, z } = require('../../src/llm/provider');

describe('pinned relgraph review providers', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-local-fixture';
    process.env.OPENAI_BASE_URL = 'http://relgraph-openai.local';
    process.env.GEMINI_API_KEY = 'local-fixture';
    process.env.GEMINI_BASE_URL = 'http://relgraph-gemini.local';
    process.env.VERTEX_AI_ENABLED = 'false';
    process.env.LLM_MAX_ATTEMPTS = '1';
    process.env.PIVOTA_INTENT_LLM_PROVIDER = 'gemini';
    process.env.PIVOTA_INTENT_LLM_FALLBACK_PROVIDER = 'gemini';
  });
  afterEach(() => { process.env = { ...savedEnv }; nock.cleanAll(); });
  test('GPT review uses Responses JSON mode, disables storage and validates returned schema', async () => {
    const scope = nock('http://relgraph-openai.local').post('/v1/responses', (body) =>
      body.model === 'gpt-fixture' && body.store === false && body.text.format.type === 'json_object' && !body.messages && !body.temperature)
      .reply(200, { output: [{ type: 'message', content: [{ type: 'output_text', text: '{"verdict":"approve"}' }] }] });
    const provider = createProviderFromEnv('relationship_graph_consensus', { provider: 'openai', model: 'gpt-fixture', disableFallback: true, useResponses: true });
    expect(await provider.analyzeTextToJson({ prompt: 'Return JSON', schema: z.object({ verdict: z.literal('approve') }) })).toEqual({ verdict: 'approve' });
    expect(provider.__meta).toMatchObject({ provider: 'openai', model: 'gpt-fixture' });
    expect(scope.isDone()).toBe(true);
  });
  test('GPT outage cannot silently fall back to Gemini', async () => {
    const scope = nock('http://relgraph-openai.local').post('/v1/responses').reply(400, { error: { message: 'fixture outage' } });
    const peer = nock('http://relgraph-gemini.local').post(/generateContent/).reply(200, {});
    const provider = createProviderFromEnv('relationship_graph_consensus', { provider: 'openai', model: 'gpt-fixture', disableFallback: true, useResponses: true });
    await expect(provider.analyzeTextToJson({ prompt: 'Return JSON', schema: z.object({ verdict: z.string() }) })).rejects.toMatchObject({ code: 'LLM_REQUEST_FAILED' });
    expect(scope.isDone()).toBe(true); expect(peer.isDone()).toBe(false);
  });
  test('Gemini uses only the pinned model and never substitutes another model', async () => {
    const scope = nock('http://relgraph-gemini.local')
      .post('/v1beta/models/gemini-2.5-flash:generateContent').query(true).reply(200, {
        candidates: [{ content: { parts: [{ text: '{"verdict":"reject"}' }] } }],
      });
    const provider = createProviderFromEnv('relationship_graph_consensus', { provider: 'gemini', model: 'gemini-2.5-flash', disableFallback: true, pinModel: true });
    expect(await provider.analyzeTextToJson({ prompt: 'Return JSON', schema: z.object({ verdict: z.literal('reject') }) })).toEqual({ verdict: 'reject' });
    expect(provider.__meta).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-flash' });
    expect(scope.isDone()).toBe(true);
    expect(() => createProviderFromEnv('relationship_graph_consensus', { provider: 'gemini', model: 'gemini-1.5-flash', disableFallback: true, pinModel: true })).toThrow('substituted');
  });
  test('schema-invalid or refusal GPT responses cannot become a verdict', async () => {
    const scope = nock('http://relgraph-openai.local').post('/v1/responses')
      .reply(200, { output: [{ content: [{ type: 'output_text', text: '{"verdict":"maybe"}' }] }] });
    const provider = createProviderFromEnv('relationship_graph_consensus', { provider: 'openai', model: 'gpt-fixture', disableFallback: true, useResponses: true });
    await expect(provider.analyzeTextToJson({ prompt: 'Return JSON', schema: z.object({ verdict: z.enum(['approve', 'reject']) }) })).rejects.toMatchObject({ code: 'LLM_SCHEMA_INVALID' });
    expect(scope.isDone()).toBe(true);
  });
});
