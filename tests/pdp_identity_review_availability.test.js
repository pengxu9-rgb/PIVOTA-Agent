const { _internals: { aggregateReviewSummary, buildReviewScopeMetadata } } = require('../src/services/pdpIdentityGraph');
const { buildPdpPayload } = require('../src/pdpBuilder');
const product = { product_id: 'p', merchant_id: 'm', title: 'Cream', price: 20, currency: 'USD' };
test.each(['empty','error','withheld','unavailable'])('identity graph projection retains %s without count-based upgrading', state => {
 const source={review_count:state==='empty'?0:7,rating:4.4,availability_state:state,review_scope:'linked_review_store'};
 const aggregate=aggregateReviewSummary([{review_summary:source}],source);
 const scoped=buildReviewScopeMetadata(aggregate,aggregate);
 const built=buildPdpPayload({product:{...product,review_summary:scoped},includeEmptyReviews:true});
 const reviews=built.modules.find(m=>m.type==='reviews_preview').data;
 expect(reviews.availability_state).toBe(state);
 expect(reviews.scoped_summaries.exact_item.availability_state).toBe(state);
 expect(reviews.review_count).toBe(0);
});
test('a withheld listing cannot leak cached reviews via another listing summary',()=>{
 const source={review_count:7,rating:4.4,availability_state:'withheld',preview_items:[{review_id:'secret'}]};
 expect(aggregateReviewSummary([{review_summary:source},{review_summary:{review_count:3,rating:4}}])).toEqual(expect.objectContaining({availability_state:'withheld',review_count:0,preview_items:[]}));
});
test('ordinary unpopulated sibling does not erase available source-backed reviews',()=>{
 expect(aggregateReviewSummary([{review_summary:{}},{review_summary:{review_count:3,rating:4}}])).toEqual(expect.objectContaining({availability_state:'ready',review_count:3}));
});

test('unavailable exact scope stays unavailable while independently ready family evidence survives',()=>{
 const failed={review_count:7,rating:4.4,availability_state:'error',preview_items:[{review_id:'failed'}]};
 const good={review_count:20,rating:4.7,availability_state:'ready',preview_items:[{review_id:'good'}]};
 const exact=aggregateReviewSummary([{review_summary:failed}],failed);
 const family=aggregateReviewSummary([{review_summary:failed},{review_summary:good}],exact);
 expect(family).toMatchObject({review_count:20,availability_state:'ready',partial_sources:true,preview_items:[{review_id:'good'}]});
 const scopes=buildReviewScopeMetadata(exact,family).scoped_summaries;
 expect(scopes.exact_item.availability_state).toBe('error');
 expect(scopes.product_line).toMatchObject({availability_state:'ready',review_count:20});
});

test.each([
 [{availability_state:'loading'},'loading'], [{availability_state:'failed'},'error'],
 [{availability_state:'rejected'},'withheld'], [{source:'synthetic',force_filled:true},'unavailable'],
 [{availability_state:'ready',distribution_estimated:true},'unavailable'],
 [{source_origin:'official_mock_import'},'unavailable'], [{status:'unknown_parser_status'},'unavailable'],
])('noneligible review summary cannot acquire ready status through graph aggregation: %j',(patch,state)=>{
 const source={review_count:7,rating:4.4,preview_items:[{review_id:'untrusted',text_snippet:'Untrusted testimonial'}],...patch};
 const aggregate=aggregateReviewSummary([{review_summary:source}],source);
 for(const summary of [source,buildReviewScopeMetadata(aggregate,aggregate)]) {
  const data=buildPdpPayload({product:{...product,review_summary:summary},includeEmptyReviews:true}).modules.find(m=>m.type==='reviews_preview').data;
  expect(data.availability_state).toBe(state);expect(data.review_count).toBe(0);expect(data.preview_items).toEqual([]);
 }
});
