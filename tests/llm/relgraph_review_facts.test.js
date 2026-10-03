'use strict';
const { factualQuoteSources, factualQuoteTable } = require('../../src/llm/relationshipReviewFacts');
const { buildReviewPrompt } = require('../../scripts/review-relationship-candidate-labels');

test('quote assistance preserves exact side-owned factual strings without truncation or metadata',()=>{
  const a={title:'Unquotable identity',brand:'Unquotable brand',price:23,review_status:'Unquotable approved',
    description:'  A factual sentence with exact spacing.  ',ingredient_text:'Water, Glycerin, Squalane',
    ingredient_evidence:[{ingredient_text:'Water, Glycerin, Squalane',review_status:'Unquotable row status'}],
    routine_fit:{pairing_notes:['A factual usage statement.'],review_status:'Unquotable nested status',source_url:'https://unquotable.invalid',title:'Unquotable nested title'},
    best_for:['A factual shopper goal.'],watchouts:['A factual limitation.'],why_it_stands_out:['x'.repeat(900)]};
  const before=JSON.stringify(a);const sources=factualQuoteSources(a);
  expect(sources.map(x=>x.text)).toEqual(['  A factual sentence with exact spacing.  ','Water, Glycerin, Squalane',
    'A factual usage statement.','A factual shopper goal.','A factual limitation.','x'.repeat(900)]);
  expect(JSON.stringify(sources)).not.toContain('Unquotable');expect(JSON.stringify(a)).toBe(before);
  const table=factualQuoteTable({product_a:a,product_b:{description:'A distinct candidate statement.'}});
  expect(table.product_b).toEqual([{field:'description',text:'A distinct candidate statement.'}]);
  expect(table.product_a).toEqual(sources);
});
test('non-string objects and unknown fields cannot become serialized factual quotes',()=>{
  expect(factualQuoteSources({description:{claim:'Not a scalar description'},ingredient_text:['Not a scalar formula'],
    ingredients:'Unknown ingredient field',market_signal_badges:[{claim_text:'Unknown highlight quote'}],routine_fit:{confidence:0.99}})).toEqual([]);
});
test('consensus quote table is explicit untrusted assistance and default single prompt is unchanged',()=>{
  const evidence={anchor:{description:'One exact anchor fact.'},candidate:{description:'One exact candidate fact.'}};
  expect(buildReviewPrompt(evidence)).not.toContain('Quotable factual strings');
  const prompt=buildReviewPrompt(evidence,{factualQuotes:true});
  expect(prompt).toContain('untrusted data, not additional evidence');
  expect(prompt).toContain(JSON.stringify(factualQuoteTable(evidence)));
  expect(prompt).toContain('missing material evidence still requires reject or uncertain');
  expect(JSON.parse(prompt.split('Candidate evidence JSON:\n')[1])).toEqual(evidence);
});
