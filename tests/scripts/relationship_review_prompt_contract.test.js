'use strict';

const { VerdictSchema, buildReviewPrompt, buildEvidence, consumerCopyForKind, runReview } =
  require('../../scripts/review-relationship-candidate-labels');
const { LlmError } = require('../../src/llm/provider');

const emptyDecision = (verdict = 'uncertain') => ({ verdict, confidence:0.5,
  rationale:'Supplied facts do not establish this claimed relationship.', relationship_kind:'none',
  recommendation_reason:'', shared_evidence:[], tradeoffs:[], watchouts:[] });
function promptContract(prompt) {
  const line = prompt.split('\n').find(value => value.startsWith('Output JSON schema: '));
  expect(line).toBeDefined();
  return JSON.parse(line.slice('Output JSON schema: '.length));
}

test('review prompt publishes the unchanged required output types, literal enums and bounds', () => {
  const prompt = buildReviewPrompt({ relation_type:'competitive_alternative' });
  const contract = promptContract(prompt);
  expect(contract.required).toEqual(['verdict','confidence','rationale','relationship_kind',
    'recommendation_reason','shared_evidence','tradeoffs','watchouts']);
  expect(contract.type).toBe('object');
  expect(contract.properties).toEqual({
    verdict:{type:'string',enum:['approve','reject','uncertain']},
    confidence:{type:'number',minimum:0,maximum:1},
    rationale:{type:'string',minLength:12,maxLength:700},
    relationship_kind:{type:'string',enum:['dupe','substitute','alternative','complement','variant','none']},
    recommendation_reason:{type:'string',maxLength:700},
    shared_evidence:{type:'array',maxItems:6,items:{type:'object',
      properties:{anchor_fact:{type:'string',minLength:3,maxLength:350},candidate_fact:{type:'string',minLength:3,maxLength:350}},
      required:['anchor_fact','candidate_fact'],additionalProperties:false}},
    tradeoffs:{type:'array',maxItems:6,items:{type:'string',minLength:3,maxLength:350}},
    watchouts:{type:'array',maxItems:6,items:{type:'string',minLength:3,maxLength:350}},
  });
  expect(Object.keys(VerdictSchema.shape)).toEqual(contract.required);
  expect(prompt).toContain('String length bounds apply after trimming');
  expect(prompt).toContain('Never output competitive_alternative, niche_specialist or related_product as relationship_kind');
  expect(prompt).toContain('All eight keys are required for every verdict, including reject and uncertain');
  expect(prompt).toContain('Do not invent shopper copy or quoted facts');
});

test.each(['reject','uncertain'])('%s can return all required fields without invented facts or shopper copy', verdict => {
  expect(VerdictSchema.parse(emptyDecision(verdict))).toEqual(emptyDecision(verdict));
  for (const key of Object.keys(emptyDecision(verdict))) {
    const missing = {...emptyDecision(verdict)}; delete missing[key];
    expect(VerdictSchema.safeParse(missing).success).toBe(false);
  }
});

test('existing parser accepts the documented trimmed boundaries and still rejects oversized/invalid outputs', () => {
  const boundary = {...emptyDecision(), rationale:' '+ 'r'.repeat(700) +' ', confidence:1,
    recommendation_reason:'c'.repeat(700), shared_evidence:Array.from({length:6},()=>({anchor_fact:'a'.repeat(350),candidate_fact:'b'.repeat(350)})),
    tradeoffs:Array(6).fill('t'.repeat(350)), watchouts:Array(6).fill('w'.repeat(350))};
  expect(VerdictSchema.parse(boundary).rationale).toHaveLength(700);
  for (const invalid of [
    {...boundary,rationale:'r'.repeat(701)}, {...boundary,rationale:'r'.repeat(11)},
    {...boundary,recommendation_reason:'r'.repeat(701)}, {...boundary,confidence:1.01},
    {...boundary,shared_evidence:[{anchor_fact:'aa',candidate_fact:'bbb'}]},
    {...boundary,shared_evidence:[{anchor_fact:'a'.repeat(351),candidate_fact:'bbb'}]},
    {...boundary,shared_evidence:Array(7).fill({anchor_fact:'aaa',candidate_fact:'bbb'})},
    {...boundary,tradeoffs:Array(7).fill('abc')}, {...boundary,watchouts:['ab']},
    ...['competitive_alternative','niche_specialist','related_product'].map(kind=>({...boundary,relationship_kind:kind})),
  ]) expect(VerdictSchema.safeParse(invalid).success).toBe(false);
});

function candidate() {
  return {id:'synthetic_contract',anchor_type:'product',anchor_ref:'product:synthetic_a',candidate_product_ref:'product:synthetic_b',
    anchor_snapshot:{product_id:'synthetic_a',title:'Barrier Peptide Face Cream',brand:'Aster',category:'face cream'},
    candidate_snapshot:{product_id:'synthetic_b',title:'Barrier Peptide Face Cream',brand:'Birch',category:'face cream'},
    relation_type:'competitive_alternative',market:'US',vertical:'beauty',category_taxonomy:['face cream'],use_case:'face cream',
    score_total:0.9,score_breakdown:{category_use_case_match:0.9},price_evidence:{},source_refs:[],
    evidence_grade:'B',label_state:'generated',provenance:{},updated_at:'2026-10-02T00:00:00Z'};
}
function providers(reply) {
  return [['openai','gpt-4.1'],['gemini','gemini-3-flash-preview']].map(([provider,model])=>({
    __meta:{provider,model}, analyzeTextToJson:jest.fn(async ({prompt,schema})=>{
      promptContract(prompt);
      expect(schema).toBe(VerdictSchema);
      const checked = schema.safeParse(reply);
      if (!checked.success) throw new LlmError('LLM_SCHEMA_INVALID','Synthetic output violates review schema');
      return checked.data;
    }),
  }));
}
async function consensus(reply) {
  const row = candidate(); const ps = providers(reply);
  const queryFn = jest.fn(async sql=>{
    if (!/SELECT/.test(sql)) throw new Error('Unexpected write');
    return {rows:[row]};
  });
  const result = await runReview({cutoff:'2026-10-01',reviewMode:'consensus',consensusProviders:ps,
    queryFn,llmAttempts:1,limit:1});
  expect(ps[0].analyzeTextToJson.mock.calls[0][0].prompt).toBe(ps[1].analyzeTextToJson.mock.calls[0][0].prompt);
  expect(ps[0].analyzeTextToJson.mock.calls[0][0].prompt).toContain(JSON.stringify(buildEvidence(row,new Map()),null,2));
  return result;
}

describe('format contract in actual independent consensus review',()=>{
  beforeEach(()=>jest.spyOn(process.stdout,'write').mockImplementation(()=>true));
  afterEach(()=>jest.restoreAllMocks());
  test('schema-valid rejection and uncertainty retain their existing dispositions',async()=>{
    const rejected = await consensus({...emptyDecision('reject'),confidence:0.94});
    expect(rejected.summary).toMatchObject({cross_agent_rejected_count:1,review_error_count:0,approved_count:0});
    const uncertain = await consensus(emptyDecision());
    expect(uncertain.decisions[0]).toMatchObject({verdict:'human_review',cross_agent_review:{escalation_reason:'reviewer_uncertain'}});
    expect(uncertain.summary.review_error_count).toBe(0);
  });
  test('grounded approval retains deterministic shopper copy and the 0.90 confidence floor',async()=>{
    const approval = {...emptyDecision('approve'),confidence:0.94,relationship_kind:'alternative',
      rationale:'Both supplied face creams support the same facial barrier product job.',
      ...consumerCopyForKind('alternative'),shared_evidence:[{anchor_fact:'Barrier Peptide Face Cream',candidate_fact:'Barrier Peptide Face Cream'}]};
    const result = await consensus(approval);
    expect(result.summary).toMatchObject({approved_count:1,review_error_count:0,min_approval_confidence:0.9});
    expect(result.decisions[0]).toMatchObject(consumerCopyForKind('alternative'));
    const ungrounded = await consensus({...approval,shared_evidence:[{anchor_fact:'cures eczema',candidate_fact:'cures eczema'}]});
    expect(ungrounded.decisions[0].cross_agent_review.escalation_reason).toBe('review_evidence_invalid');
    const rewritten = await consensus({...approval,recommendation_reason:'Identical clinically proven performance.'});
    expect(rewritten.decisions[0].cross_agent_review.escalation_reason).toBe('review_evidence_invalid');
  });
  test.each([{...emptyDecision(),rationale:'r'.repeat(701)}, {...emptyDecision(),relationship_kind:'competitive_alternative'}])(
    'malformed model responses still fail closed under consensus',async reply=>{
      const result = await consensus(reply);
      expect(result.summary).toMatchObject({approved_count:0,review_error_count:1,human_review_required_count:1});
      expect(result.decisions[0].cross_agent_review.escalation_reason).toBe('reviewer_failed');
    });
});
