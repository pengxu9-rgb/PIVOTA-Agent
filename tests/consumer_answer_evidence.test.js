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
  expect(result.raw_runs[0].answer).toMatchObject({complete:false,transport_complete:true,unknown_reason:'answer_sources_missing',model:'test-model',text:'Consider Anua.'});
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
    expect(result.raw_runs[0].answer).toMatchObject({complete:false,transport_complete:true,unknown_reason:'answer_sources_missing',text:'Consider Anua.',provider});
    expect(result.scores).toBeNull();
  } finally {
    delete process.env.GEMINI_API_KEY;delete process.env.ANTHROPIC_API_KEY;
    jest.dontMock('../src/llm/vertexGemini');jest.dontMock('@google/genai');jest.dontMock('@anthropic-ai/sdk');
  }
});

test('a completed preamble or retrieved-only response cannot qualify as grounded evidence', () => {
 const result=evidence({query:'q',rawText:'I will check sources.',provider:'chatgpt',finishReason:'completed',retrievedSources:[{uri:'https://example.com'}]});
 expect(result.answer).toMatchObject({complete:false,transport_complete:true,unknown_reason:'answer_sources_missing'});
});

test('published cost estimate includes cache and reports unknown model prices explicitly', () => {
 const {buildProviderUsage,openAIProbePricing}=require('../src/internal/agentCenterLlmProbe')._internals;
 const result=buildProviderUsage({inputTokens:10974,outputTokens:235,cachedInputTokens:4352,webSearchRequests:1,pricing:openAIProbePricing('chat-latest')});
 expect(result.cost_usd_estimate).toBeCloseTo(0.067336,6);
 expect(result.cost_usd_estimate_min).toBeCloseTo(0.052336,6);
 expect(result.cached_input_tokens).toBe(4352);
 expect(buildProviderUsage({inputTokens:10,outputTokens:10,pricing:openAIProbePricing('unknown-model')}).cost_usd_estimate).toBeNull();
});

test('required-search profile changes the real request and binds answer provenance', async () => {
 process.env.OPENAI_API_KEY='test-only';process.env.PIVOTA_CONSUMER_ANSWER_ENABLED='true';
 const response={status:'completed',model:'chat-latest',output_text:'Consider Anua.',usage:{input_tokens:10,output_tokens:5},output:[
  {type:'web_search_call',status:'completed'},
  {type:'message',content:[{type:'output_text',text:'Consider Anua.',annotations:[{type:'url_citation',url:'https://example.com/source'}]}]}
 ]};
 const create=jest.fn(async()=>response);
 jest.doMock('openai',()=>jest.fn(function(){return {responses:{create}};}));
 const helper=require('../src/internal/consumerAnswerEvidence');
 const probe=require('../src/internal/agentCenterLlmProbe')._internals;
 const current={...input,provider:'chatgpt',context:{...input.context,consumer_execution_profile:helper.REQUIRED_PROFILE}};
 const result=await probe.buildChatGptProbe(current);
 expect(create.mock.calls[0][0]).toMatchObject({model:'chat-latest',tool_choice:'required',max_output_tokens:900});
 expect(result.raw_runs[0]).toMatchObject({prompt_contract:helper.REQUIRED_CONTRACT,answer:{complete:true,web_search_requests:1,execution:helper.REQUIRED_EXECUTION}});
 response.output=response.output.filter(x=>x.type!=='web_search_call');
 expect((await probe.buildChatGptProbe(current)).raw_runs[0].answer.complete).toBe(false);
 await expect(probe.buildChatGptProbe({...current,model:'gpt-4o-mini'})).rejects.toThrow('profile does not match');
});

test('HTTP handler preserves required-search execution through normalization and dispatch', async () => {
 process.env.OPENAI_API_KEY='test-only'; process.env.PIVOTA_CONSUMER_ANSWER_ENABLED='true';
 const create=jest.fn(async()=>({status:'completed',model:'chat-latest',output_text:'A sourced answer.',usage:{input_tokens:10,output_tokens:5},output:[
  {type:'web_search_call',status:'completed'},
  {type:'message',content:[{type:'output_text',text:'A sourced answer.',annotations:[{type:'url_citation',url:'https://example.com/source'}]}]}
 ]}));
 jest.doMock('openai',()=>jest.fn(function(){return {responses:{create}};}));
 const module=require('../src/internal/agentCenterLlmProbe');
 const mount=jest.fn();module.mountAgentCenterLlmProbe({post:mount});
 const handler=mount.mock.calls[0][2];
 const response={status:jest.fn().mockReturnThis(),json:jest.fn()};
 const body={...input,options:{provider:'chatgpt',max_runs:1},context:{...input.context,consumer_execution_profile:'openai_web_required_v2'}};
 await handler({body},response);
 expect(response.status).toHaveBeenCalledWith(200);
 expect(create).toHaveBeenCalledTimes(1);
 expect(create.mock.calls[0][0]).toMatchObject({model:'chat-latest',tool_choice:'required',max_output_tokens:900});
 expect(response.json.mock.calls[0][0].result.raw_runs[0]).toMatchObject({prompt_contract:'consumer_query_openai_web_required_v2',answer:{complete:true,web_search_requests:1}});
 for(const invalid of [
  {...body,context:{...body.context,consumer_execution_profile:'unsupported'}},
  {...body,options:{provider:'gemini',max_runs:1}},
  {...body,options:{provider:'chatgpt',model:'gpt-4o-mini'}}
 ]) {
  response.status.mockClear();await handler({body:invalid},response);
  expect(response.status).toHaveBeenCalledWith(400);
 }
 expect(create).toHaveBeenCalledTimes(1);
});
