const test = require('node:test');
const assert = require('node:assert/strict');

test('auroraDecisionClient posts machine requests to /api/upstream/chat', async () => {
  const moduleId = require.resolve('../src/auroraBff/auroraDecisionClient');
  delete require.cache[moduleId];
  const axios = require('axios');
  const originalPost = axios.post;
  let captured = null;

  axios.post = async (url, body, options) => {
    captured = { url, body, options };
    return { status: 200, data: { ok: true, answer: 'ok', structured: { alternatives: [] } } };
  };

  try {
    const { auroraChat } = require(moduleId);
    const resp = await auroraChat({
      baseUrl: 'https://aurora-decision.test',
      query: 'Return JSON',
      prompt_template_id: 'reco_alternatives_v1_0',
      required_structured_keys: ['alternatives'],
      trace_id: 'trace_1',
      request_id: 'req_1',
    });

    assert.ok(captured);
    assert.equal(captured.url, 'https://aurora-decision.test/api/upstream/chat');
    assert.equal(captured.body.prompt_template_id, 'reco_alternatives_v1_0');
    assert.deepEqual(captured.body.required_structured_keys, ['alternatives']);
    assert.equal(captured.options.headers['X-Prompt-Template'], 'reco_alternatives_v1_0');
    assert.equal(resp.ok, true);
  } finally {
    axios.post = originalPost;
    delete require.cache[moduleId];
  }
});

test('auroraDecisionClient merges effective llm routing metadata from upstream headers', async () => {
  const moduleId = require.resolve('../src/auroraBff/auroraDecisionClient');
  delete require.cache[moduleId];
  const axios = require('axios');
  const originalPost = axios.post;

  axios.post = async () => ({
    status: 200,
    headers: {
      'x-llm-provider': 'gemini',
      'x-llm-model': 'gemini-3-pro-preview',
    },
    data: {
      ok: true,
      answer: 'ok',
      structured: { alternatives: [] },
    },
  });

  try {
    const { auroraChat } = require(moduleId);
    const resp = await auroraChat({
      baseUrl: 'https://aurora-decision.test',
      query: 'Return JSON',
      llm_provider: 'gemini',
      llm_model: 'gemini-3-flash-preview',
    });

    assert.equal(resp.llm_provider, 'gemini');
    assert.equal(resp.llm_model, 'gemini-3-pro-preview');
  } finally {
    axios.post = originalPost;
    delete require.cache[moduleId];
  }
});
