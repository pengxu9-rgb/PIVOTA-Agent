'use strict';

const nock = require('nock');
const { createProviderFromEnv, z } = require('../../src/llm/provider');
const { VerdictSchema } = require('../../scripts/review-relationship-candidate-labels');
const { relationshipReviewGeminiSchema } = require('../../src/llm/relationshipReviewGeminiSchema');

const opts = {provider:'gemini',model:'gemini-3-flash-preview',disableFallback:true,pinModel:true,nativeJsonSchema:true,geminiThinkingLevel:'low'};
const response = {verdict:'uncertain',confidence:0.5,rationale:'The supplied facts are insufficient.',relationship_kind:'none',
  recommendation_reason:'',shared_evidence:[],tradeoffs:[],watchouts:[]};
const reply = (data=response,finishReason='STOP') => ({candidates:[{finishReason,content:{parts:[{text:JSON.stringify(data)}]}}]});
describe('scoped native Gemini relationship review',()=>{
  const saved = {...process.env};
  beforeEach(()=>{
    process.env.GEMINI_API_KEY='local-fixture';process.env.GEMINI_BASE_URL='http://relgraph-gemini.local';
    process.env.OPENAI_API_KEY='sk-local-fixture';process.env.OPENAI_BASE_URL='http://relgraph-openai.local';
    process.env.VERTEX_AI_ENABLED='false';process.env.LLM_MAX_ATTEMPTS='1';nock.disableNetConnect();
  });
  afterEach(()=>{process.env={...saved};nock.cleanAll();nock.enableNetConnect();});
  test('supported Vertex projection keeps required order, enums and numeric/array constraints',()=>{
    const schema=relationshipReviewGeminiSchema(VerdictSchema);
    expect(schema).toMatchObject({type:'OBJECT',required:Object.keys(VerdictSchema.shape),propertyOrdering:Object.keys(VerdictSchema.shape),
      properties:{confidence:{type:'NUMBER',minimum:0,maximum:1},shared_evidence:{type:'ARRAY',maxItems:6,items:{type:'OBJECT',required:['anchor_fact','candidate_fact']}},
        verdict:{type:'STRING',enum:['approve','reject','uncertain']},rationale:{type:'STRING'}}});
    expect(schema).not.toHaveProperty('additionalProperties');
    expect(schema.properties.rationale).not.toHaveProperty('minLength');
    expect(schema.properties.rationale).not.toHaveProperty('maxLength');
    expect(VerdictSchema.shape.rationale.safeParse('x'.repeat(701)).success).toBe(false);
  });
  test('pinned 3 Flash sends native schema and LOW thinking without fallback',async()=>{
    const scope=nock('http://relgraph-gemini.local').post('/v1beta/models/gemini-3-flash-preview:generateContent',body=>{
      expect(body.generationConfig).toEqual({temperature:0,responseMimeType:'application/json',
        responseSchema:relationshipReviewGeminiSchema(VerdictSchema),thinkingConfig:{thinkingLevel:'LOW'}});return true;
    }).query(true).reply(200,reply());
    const p=createProviderFromEnv('relationship_graph_consensus',opts);
    expect(await p.analyzeTextToJson({prompt:'synthetic',schema:VerdictSchema})).toEqual(response);
    expect(scope.isDone()).toBe(true);
  });
  test('2.5 Pro auditor uses native subset without incompatible thinkingLevel',async()=>{
    const schema=z.object({assessment:z.enum(['useful','incorrect','uncertain']),rationale:z.string().min(1).max(1000)}).strict();
    const scope=nock('http://relgraph-gemini.local').post('/v1beta/models/gemini-2.5-pro:generateContent',body=>{
      expect(body.generationConfig).not.toHaveProperty('thinkingConfig');
      expect(body.generationConfig.responseSchema).toEqual(relationshipReviewGeminiSchema(schema));return true;
    }).query(true).reply(200,reply({assessment:'uncertain',rationale:'Insufficient facts.'}));
    const p=createProviderFromEnv('relationship_graph_blinded_audit',{...opts,model:'gemini-2.5-pro',geminiThinkingLevel:undefined});
    await p.analyzeTextToJson({prompt:'synthetic',schema});expect(scope.isDone()).toBe(true);
  });
  test.each([
    {...response,rationale:'x'.repeat(701)}, {...response,confidence:1.1},
    {...response,shared_evidence:[{anchor_fact:'x'.repeat(351),candidate_fact:'provided quote'}]},
  ])('native subset never bypasses full authoritative local schema',async invalid=>{
    const scope=nock('http://relgraph-gemini.local').post(/generateContent/).query(true).reply(200,reply(invalid));
    const p=createProviderFromEnv('relationship_graph_consensus',opts);
    await expect(p.analyzeTextToJson({prompt:'synthetic',schema:VerdictSchema})).rejects.toMatchObject({code:'LLM_SCHEMA_INVALID'});
    expect(scope.isDone()).toBe(true);
  });
  test('strict auditor schemas still reject additional keys ignored by native subset',async()=>{
    const schema=z.object({assessment:z.enum(['useful','incorrect','uncertain']),rationale:z.string().min(1).max(1000)}).strict();
    nock('http://relgraph-gemini.local').post(/generateContent/).query(true).reply(200,reply({assessment:'uncertain',rationale:'Insufficient facts.',extra:'unsupported'}));
    const p=createProviderFromEnv('relationship_graph_blinded_audit',{...opts,model:'gemini-2.5-pro',geminiThinkingLevel:undefined});
    await expect(p.analyzeTextToJson({prompt:'synthetic',schema})).rejects.toMatchObject({code:'LLM_SCHEMA_INVALID'});
  });
  test.each(['MAX_TOKENS','SAFETY','RECITATION',undefined])('incomplete/refused envelope fails even with valid JSON (%s)',async reason=>{
    const body=reply();if(reason===undefined)delete body.candidates[0].finishReason;else body.candidates[0].finishReason=reason;
    nock('http://relgraph-gemini.local').post(/generateContent/).query(true).reply(200,body);
    const p=createProviderFromEnv('relationship_graph_consensus',opts);
    await expect(p.analyzeTextToJson({prompt:'synthetic',schema:VerdictSchema})).rejects.toMatchObject({code:'LLM_PARSE_FAILED'});
  });
  test.each([
    z.object({optional:z.string().max(10).optional()}).strict(),z.object({rationale:z.string().max(10).regex(/foo/)}).strict(),
    z.object({coerced:z.coerce.number()}).strict(),z.object({value:z.string().max(10).transform(x=>x)}).strict(),
  ])('unsupported source schema fails before HTTP',async schema=>{
    const scope=nock('http://relgraph-gemini.local').post(/generateContent/).query(true).reply(200,reply());
    const p=createProviderFromEnv('relationship_graph_consensus',opts);
    await expect(p.analyzeTextToJson({prompt:'synthetic',schema})).rejects.toMatchObject({code:'LLM_CONFIG_MISSING'});
    expect(scope.isDone()).toBe(false);
  });
  test('non-opt-in Gemini request remains byte-compatible and needs no completion metadata',async()=>{
    const expected={systemInstruction:{parts:[{text:'You are a strict JSON generator. Output JSON only. No markdown, no extra keys, no prose.'}]},
      contents:[{role:'user',parts:[{text:'synthetic'}]}],generationConfig:{temperature:0,responseMimeType:'application/json'}};
    const scope=nock('http://relgraph-gemini.local').post('/v1beta/models/gemini-2.5-flash:generateContent',body=>{
      expect(JSON.stringify(body)).toBe(JSON.stringify(expected));return true;
    }).query(true).reply(200,{candidates:[{content:{parts:[{text:'{"verdict":"reject"}'}]}}]});
    const p=createProviderFromEnv('generic',{provider:'gemini',model:'gemini-2.5-flash',disableFallback:true,pinModel:true});
    expect(await p.analyzeTextToJson({prompt:'synthetic',schema:z.object({verdict:z.literal('reject')})})).toEqual({verdict:'reject'});
    expect(p.__meta).not.toHaveProperty('nativeJsonSchema');expect(scope.isDone()).toBe(true);
  });
  test('outage cannot silently use GPT or a different Gemini model',async()=>{
    nock('http://relgraph-gemini.local').post(/generateContent/).query(true).reply(503,{error:{message:'fixture outage'}});
    const peer=nock('http://relgraph-openai.local').post(/responses/).reply(200,{});
    const p=createProviderFromEnv('relationship_graph_consensus',opts);
    await expect(p.analyzeTextToJson({prompt:'synthetic',schema:VerdictSchema})).rejects.toMatchObject({code:'LLM_REQUEST_FAILED'});
    expect(peer.isDone()).toBe(false);
  });
  test('thinking/native options cannot leak to generic, unpinned, fallback or 2.5 callers',()=>{
    for(const change of [{model:'gemini-2.5-pro'},{pinModel:false},{disableFallback:false},{geminiThinkingLevel:'high'},
      {provider:'openai'}, {nativeJsonSchema:false}]) expect(()=>createProviderFromEnv('relationship_graph_consensus',{...opts,...change})).toThrow();
    expect(()=>createProviderFromEnv('generic',opts)).toThrow();
    expect(()=>createProviderFromEnv('relationship_graph_blinded_audit',opts)).toThrow();
  });
});
