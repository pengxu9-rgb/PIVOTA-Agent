'use strict';
const { evidence, prompt, MODE } = require('../src/internal/consumerAnswerEvidence');
const input = { scan_mode: MODE, merchant_id: 'm', store_id: 's', scan_target_id: 't', max_runs: 1,
  context: { queries: ['best moisturizer'], product: { title: 'SECRET PRODUCT', vendor: 'SECRET BRAND' }, merchant_pdp_url: 'https://secret.example' } };
afterEach(() => {
  delete process.env.PIVOTA_CONSUMER_ANSWER_ENABLED;
  delete process.env.OPENAI_API_KEY;
  jest.resetModules(); jest.dontMock('openai');
});
test('consumer prompt never adds target merchant context', () => {
  expect(prompt().userPerQuery(input.context.queries[0])).toBe('best moisturizer');
  expect(prompt().system).not.toMatch(/SECRET/);
});
test.each(['chatgpt', 'claude', 'gemini'])('unknown or truncated %s finish is never complete', provider => {
  for (const finishReason of [null, 'max_tokens', 'length', 'MAX_TOKENS', 'refusal']) {
    expect(evidence({ query: 'q', rawText: 'Brand', provider, finishReason }).answer.complete).toBe(false);
  }
});
test.each([['chatgpt','completed'], ['claude','end_turn'], ['gemini','STOP']])('%s records complete evidence separately from retrieved sources', (provider, finishReason) => {
  const run = evidence({ query: 'q', rawText: 'Brand', provider, finishReason, chunks: [{uri:'https://cited.example'}], retrievedSources: [{uri:'https://retrieved.example'}] });
  expect(run.answer.complete).toBe(true);
  expect(run.parsed).toBeNull();
  expect(run.answer.sha256).toHaveLength(64);
  expect(run.grounding_chunks).toEqual(['https://cited.example']);
});
test('error and empty responses stay unmeasured', () => {
  for (const rawText of ['', '__error__:timeout']) {
    expect(evidence({query:'q', rawText, provider:'chatgpt', finishReason:'completed'}).answer.complete).toBe(false);
  }
});
test('actual ChatGPT path uses consumer question, preserves completeness and bills usage without diagnostic scores', async () => {
  process.env.OPENAI_API_KEY = 'test-only'; process.env.PIVOTA_CONSUMER_ANSWER_ENABLED = 'true';
  const create = jest.fn(async () => ({status:'completed', model:'test-model', output_text:'Consider Anua.', usage:{input_tokens:10,output_tokens:5}, output:[]}));
  jest.doMock('openai', () => jest.fn(function(){return {responses:{create}};}));
  const probe = require('../src/internal/agentCenterLlmProbe')._internals;
  const result = await probe.buildChatGptProbe(input);
  expect(create.mock.calls[0][0].input).toBe('best moisturizer');
  expect(JSON.stringify(create.mock.calls[0][0])).not.toContain('SECRET');
  expect(result.scores).toBeNull(); expect(result.findings).toEqual([]);
  expect(result.raw_runs[0].answer).toMatchObject({complete:true,model:'test-model',text:'Consider Anua.'});
  expect(result.usage.input_tokens).toBe(10);
  delete process.env.PIVOTA_CONSUMER_ANSWER_ENABLED;
  await expect(probe.buildChatGptProbe(input)).rejects.toThrow(/enabled gate/);
  expect(create).toHaveBeenCalledTimes(1);
});

test.each(['gemini','claude'])('actual %s path captures consumer prose without target context', async provider => {
  jest.resetModules(); process.env.PIVOTA_CONSUMER_ANSWER_ENABLED='true';
  process.env.GEMINI_API_KEY='test-only';process.env.ANTHROPIC_API_KEY='test-only';
  const invoke=jest.fn(async () => provider === 'gemini'
    ? {text:'Consider Anua.',modelVersion:'fixture-gemini',candidates:[{finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:5}}
    : {content:[{type:'text',text:'Consider Anua.'}],stop_reason:'end_turn',model:'fixture-claude',usage:{input_tokens:10,output_tokens:5}});
  jest.doMock('../src/llm/vertexGemini', () => ({...jest.requireActual('../src/llm/vertexGemini'),vertexEnabled:()=>false,credentialsAvailable:()=>true,geminiClientOptions:()=>({apiKey:'test-only'})}));
  jest.doMock('@google/genai',()=>({GoogleGenAI:jest.fn(function(){return {models:{generateContent:invoke}};})}));
  jest.doMock('@anthropic-ai/sdk',()=>jest.fn(function(){return {messages:{create:invoke}};}));
  try {
    const probe=require('../src/internal/agentCenterLlmProbe')._internals;
    const result=await (provider === 'gemini' ? probe.buildGeminiProbe(input) : probe.buildClaudeProbe(input));
    expect(JSON.stringify(invoke.mock.calls[0][0])).not.toContain('SECRET');
    expect(result.raw_runs[0].answer).toMatchObject({complete:true,text:'Consider Anua.',provider});
    expect(result.scores).toBeNull();
  } finally {
    delete process.env.GEMINI_API_KEY;delete process.env.ANTHROPIC_API_KEY;
    jest.dontMock('../src/llm/vertexGemini');jest.dontMock('@google/genai');jest.dontMock('@anthropic-ai/sdk');
  }
});
