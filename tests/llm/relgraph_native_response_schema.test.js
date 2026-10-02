'use strict';

const nock = require('nock');
const {createProviderFromEnv,z} = require('../../src/llm/provider');
const {VerdictSchema,createConsensusProviders,buildReviewPrompt} = require('../../scripts/review-relationship-candidate-labels');
const {relationshipReviewNativeSchema} = require('../../src/llm/relationshipReviewNativeSchema');
const response = {verdict:'uncertain',confidence:0.5,rationale:'Supplied facts do not establish this claimed relationship.',
  relationship_kind:'none',recommendation_reason:'',shared_evidence:[],tradeoffs:[],watchouts:[]};
const nativeOptions = {provider:'openai',model:'gpt-4.1',disableFallback:true,pinModel:true,useResponses:true,nativeJsonSchema:true};
const openaiReply = value => ({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});

describe('opt-in native relgraph response schema',()=>{
  const savedEnv={...process.env};
  beforeEach(()=>{
    process.env.OPENAI_API_KEY='sk-local-fixture'; process.env.OPENAI_BASE_URL='http://relgraph-openai.local';
    process.env.GEMINI_API_KEY='local-fixture'; process.env.GEMINI_BASE_URL='http://relgraph-gemini.local';
    process.env.VERTEX_AI_ENABLED='false'; process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED='false';
    process.env.LLM_MAX_ATTEMPTS='1'; process.env.RELGRAPH_REVIEW_OPENAI_MODEL='gpt-4.1';
    process.env.RELGRAPH_REVIEW_GEMINI_MODEL='gemini-3-flash-preview';
    nock.disableNetConnect();
  });
  afterEach(()=>{process.env={...savedEnv};nock.cleanAll();nock.enableNetConnect();});

  test('actual consensus factory sends strict Responses schema while pinned Gemini stays in JSON mode',async()=>{
    let sent;
    const first=nock('http://relgraph-openai.local').post('/v1/responses',body=>{
      sent=body;return true;
    }).reply(200,openaiReply(response));
    let geminiBody;
    const second=nock('http://relgraph-gemini.local').post('/v1beta/models/gemini-3-flash-preview:generateContent',body=>{
      geminiBody=body;return true;
    }).query(true).reply(200,{candidates:[{content:{parts:[{text:JSON.stringify(response)}]}}]});
    const ps=createConsensusProviders();
    const prompt=buildReviewPrompt({relation_type:'competitive_alternative'});
    expect(ps[0].__meta).toMatchObject({provider:'openai',model:'gpt-4.1',nativeJsonSchema:true});
    expect(ps[1].__meta).not.toHaveProperty('nativeJsonSchema');
    for(const p of ps) expect(await p.analyzeTextToJson({prompt,schema:VerdictSchema})).toEqual(response);
    expect(sent).toMatchObject({model:'gpt-4.1',store:false,max_output_tokens:6000,
      text:{format:{type:'json_schema',name:'relgraph_review',strict:true}},input:prompt});
    expect(sent).not.toHaveProperty('messages'); expect(sent).not.toHaveProperty('temperature');
    const schema=sent.text.format.schema;
    expect(schema).toEqual(relationshipReviewNativeSchema(VerdictSchema));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(VerdictSchema.shape));
    expect(schema.properties.rationale).toEqual({type:'string',pattern:'^[\\s\\S]{12,700}(?![\\s\\S])'});
    expect(schema.properties.relationship_kind.enum).toEqual(['dupe','substitute','alternative','complement','variant','none']);
    expect(schema.properties.confidence).toEqual({type:'number',minimum:0,maximum:1});
    expect(schema.properties.shared_evidence.maxItems).toBe(6);
    expect(schema.properties.shared_evidence.items.additionalProperties).toBe(false);
    expect(schema.properties.shared_evidence.items.properties.anchor_fact.pattern).toBe('^[\\s\\S]{3,350}(?![\\s\\S])');
    expect(schema).not.toHaveProperty('$schema');
    expect(geminiBody.generationConfig).toEqual({temperature:0,responseMimeType:'application/json'});
    expect(first.isDone()).toBe(true);expect(second.isDone()).toBe(true);
  });

  test('converted patterns preserve multiline and final-newline bounds for untrimmed auditor fields',()=>{
    const schema=z.object({rationale:z.string().min(1).max(1000),quote:z.string().min(1).max(350)}).strict();
    const native=relationshipReviewNativeSchema(schema);
    for(const [key,max]of [['rationale',1000],['quote',350]]) {
      const regex=new RegExp(native.properties[key].pattern);
      expect(regex.test('x'.repeat(max))).toBe(true);
      expect(regex.test('x'.repeat(max-1)+'\n')).toBe(true);
      expect(regex.test('x'.repeat(max)+'\n')).toBe(false);
      expect(regex.test('x'.repeat(max+1))).toBe(false);
      expect(regex.test('')).toBe(false);
      expect(regex.test('short\nmultiline text')).toBe(true);
    }
  });

  test('the bounded five-key blinded-auditor schema uses the same acknowledged native text path',async()=>{
    // Exact schema used by the operator's auditSchema(z), including its
    // required expected_kind and the unchanged quote/rationale limits.
    const schema=z.object({assessment:z.enum(['useful','incorrect','uncertain']),
      expected_kind:z.enum(['dupe','alternative','substitute','complement','variant','none','unknown']),
      confidence:z.number().min(0).max(1),rationale:z.string().min(1).max(1000),
      shared_evidence:z.array(z.object({product_a_fact:z.string().min(1).max(350),
        product_b_fact:z.string().min(1).max(350)})).max(6)}).strict();
    const fixture={assessment:'uncertain',expected_kind:'unknown',confidence:0.5,
      rationale:'Evidence is incomplete.',shared_evidence:[]};
    const scope=nock('http://relgraph-openai.local').post('/v1/responses',body=>{
      const native=body.text.format.schema;
      return body.model==='gpt-5.4' && body.text.format.strict===true && native.required.length===5 && native.additionalProperties===false &&
        native.properties.assessment.enum.join(',')==='useful,incorrect,uncertain' &&
        native.properties.expected_kind.enum.join(',')==='dupe,alternative,substitute,complement,variant,none,unknown' &&
        native.properties.rationale.pattern==='^[\\s\\S]{1,1000}(?![\\s\\S])' &&
        native.properties.shared_evidence.items.required.length===2 &&
        native.properties.shared_evidence.items.properties.product_a_fact.pattern==='^[\\s\\S]{1,350}(?![\\s\\S])';
    }).reply(200,openaiReply(fixture));
    const p=createProviderFromEnv('relationship_graph_blinded_audit',{...nativeOptions,model:'gpt-5.4'});
    expect(p.__meta.nativeJsonSchema).toBe(true);
    expect(await p.analyzeTextToJson({prompt:'Synthetic independent audit JSON',schema})).toEqual(fixture);
    expect(scope.isDone()).toBe(true);
  });

  test.each([
    ['rationale overflow',{...response,rationale:'r'.repeat(701)}],
    ['quote overflow',{...response,shared_evidence:[{anchor_fact:'a'.repeat(351),candidate_fact:'bbb'}]}],
    ['enum mismatch',{...response,relationship_kind:'competitive_alternative'}],
    ['array overflow',{...response,tradeoffs:Array(7).fill('abc')}],
  ])('native output still rejects %s through unchanged local Zod without truncation',async(_,invalid)=>{
    const scope=nock('http://relgraph-openai.local').post('/v1/responses').reply(200,openaiReply(invalid));
    const p=createProviderFromEnv('relationship_graph_consensus',nativeOptions);
    await expect(p.analyzeTextToJson({prompt:'Return JSON',schema:VerdictSchema})).rejects.toMatchObject({code:'LLM_SCHEMA_INVALID'});
    expect(scope.isDone()).toBe(true);
  });

  test.each([
    ['pattern plus length',z.object({value:z.string().regex(/^x/).max(350)})],
    ['custom refinement',z.object({value:z.string().max(350).refine(x=>x==='approved')})],
    ['object refinement',z.object({value:z.string().max(350)}).refine(x=>x.value==='approved')],
    ['transform',z.object({value:z.string().transform(x=>x.toLowerCase())})],
    ['overwrite',z.object({value:z.string().toLowerCase().max(350)})],
    ['optional',z.object({value:z.string().max(350).optional()})],
    ['default',z.object({value:z.string().max(350).default('none')})],
    ['union',z.object({value:z.union([z.string().max(350),z.number()])})],
    ['passthrough object',z.object({value:z.string().max(350)}).passthrough()],
    ['unbounded string',z.object({value:z.string()})],
    ['minimum-only string',z.object({value:z.string().min(1)})],
    ['infinite numeric bound',z.object({value:z.number().max(Infinity)})],
    ['NaN numeric bound',z.object({value:z.number().min(NaN)})],
    ['negative array limit',z.object({value:z.array(z.string().max(10)).max(-1)})],
    ['infinite array limit',z.object({value:z.array(z.string().max(10)).max(Infinity)})],
    ['fractional array limit',z.object({value:z.array(z.string().max(10)).max(1.5)})],
  ])('unsupported %s fails before HTTP rather than weakening constraints or reverting mode',async(_,schema)=>{
    const untouched=nock('http://relgraph-openai.local').post('/v1/responses').reply(200,openaiReply(response));
    const p=createProviderFromEnv('relationship_graph_consensus',nativeOptions);
    await expect(p.analyzeTextToJson({prompt:'Return JSON',schema})).rejects.toMatchObject({code:'LLM_CONFIG_MISSING'});
    expect(untouched.isDone()).toBe(false);
  });

  test('invalid native API shape does not retry in JSON mode or fall back to Gemini',async()=>{
    const scope=nock('http://relgraph-openai.local').post('/v1/responses',body=>body.text.format.type==='json_schema')
      .reply(400,{error:{message:'Unsupported schema'}});
    const peer=nock('http://relgraph-gemini.local').post(/generateContent/).reply(200,{});
    const p=createProviderFromEnv('relationship_graph_consensus',nativeOptions);
    await expect(p.analyzeTextToJson({prompt:'Return JSON',schema:VerdictSchema})).rejects.toMatchObject({code:'LLM_REQUEST_FAILED'});
    expect(scope.isDone()).toBe(true);expect(peer.isDone()).toBe(false);
  });

  test('non-opt-in Responses and Chat callers retain their existing JSON request format',async()=>{
    const responses=nock('http://relgraph-openai.local').post('/v1/responses',body=>body.text.format.type==='json_object')
      .reply(200,openaiReply(response));
    const chat=nock('http://relgraph-openai.local').post('/v1/chat/completions',body=>body.response_format.type==='json_object'&&!body.text)
      .reply(200,{choices:[{message:{content:JSON.stringify(response)}}]});
    const first=createProviderFromEnv('generic',{provider:'openai',model:'gpt-4.1',disableFallback:true,useResponses:true});
    const second=createProviderFromEnv('generic',{provider:'openai',model:'gpt-4.1',disableFallback:true});
    for(const p of [first,second]) {
      expect(p.__meta).not.toHaveProperty('nativeJsonSchema');
      expect(await p.analyzeTextToJson({prompt:'Return JSON',schema:VerdictSchema})).toEqual(response);
    }
    expect(responses.isDone()).toBe(true);expect(chat.isDone()).toBe(true);
  });

  test('native mode is scoped to pinned text relgraph callers, including auditor acknowledgement',async()=>{
    expect(()=>createProviderFromEnv('generic',nativeOptions)).toThrow('pinned OpenAI');
    for(const extra of [{useResponses:false},{pinModel:false},{disableFallback:false},{provider:'gemini'}]) {
      expect(()=>createProviderFromEnv('relationship_graph_consensus',{...nativeOptions,...extra})).toThrow('pinned OpenAI');
    }
    const p=createProviderFromEnv('relationship_graph_blinded_audit',nativeOptions);
    expect(p.__meta.nativeJsonSchema).toBe(true);
    await expect(p.analyzeImageToJson({prompt:'Return JSON',image:{kind:'url',url:'https://synthetic.invalid/image'},schema:VerdictSchema}))
      .rejects.toMatchObject({code:'LLM_CONFIG_MISSING'});
  });
});
