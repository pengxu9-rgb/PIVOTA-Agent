import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectedReapVariantKey, tryReapAgenticCheckout, decodeReapCheckoutId } from '../src/ucpReapAgenticLane.js';
const key = 'prod::external_seed::external_seed::ext_3e6db6ab9ff14b9fb21f45a8';
const productId = 'sig_436641888f6a84f14c02ed293d9596a7';
const row = { product_id: productId, product_key: key, source_system: 'external_product_seeds_mirror_v1', platform: 'external_seed', price: 16, currency: 'USD', external_redirect_url: 'https://kravebeauty.com/products/matcha-hemp-hydrating-cleanser', purchase_grain: 'product', variants: [
 { variant_id: '677289689108', price: {amount:16,currency:'USD'} }, {variant_id:'42199434526795',price:{amount:27,currency:'USD'}},
] };
const args = id => ({ checkout: { reap: { expected_merchant_domain:'kravebeauty.com', ...(id ? {selected_variant_id:id}: {}) } } });
const env={REAP_AGENTIC_LANE_ENABLED:'1',REAP_AGENTIC_CART_LINK_LANE_ENABLED:'1'};
const call = (id,client, extra={}) => tryReapAgenticCheckout({op:{id:'create_checkout_session'},params:{idempotency_key:'same-attempt-123', quote:{items:[{product_id:productId,quantity:1}]}},ctx:{},executor:{execute:async()=>({product:row})},ucpArgs:args(id),client,env,...extra});
for (const [id,minor] of [['677289689108',1600],['42199434526795',2700]]) {
 test(`selected ${id} reaches the cart-link backend with its own price snapshot`, async()=>{
  let body;
  const client={hasCallerCredentials:()=>true,getPurchase:async()=>{},startPurchase:async b=>{body=b;return {kind:'accepted',purchase:{id:'rp_'+'a'.repeat(24),state:'resolving',product_key:key,quantity:1,totals:{currency:'USD',our_price_minor:minor}}};}};
  const view=await call(id,client);
  assert.equal(body.variant_key,`${key}::v::${id}`);
  assert.equal(body.item_source,'cart_link');
  assert.equal(decodeReapCheckoutId(view.id).unitMinor,minor);
 });
}
test('missing or foreign variant is a proven pre-dispatch refusal',async()=>{
 let creates=0;
 const client={hasCallerCredentials:()=>true,getPurchase:async()=>{},startPurchase:async()=>{creates++;}};
 for (const id of [undefined,'999']) await assert.rejects(call(id,client),e=>e.detail?.reason==='ucp_reap_variant_not_created');
 assert.equal(creates,0);
});
test('backend proof refusal is not-created, while a timeout remains unknown',async()=>{
 for(const result of [{kind:'refused',http_status:409,code:'row_variant_unverified'},{kind:'unavailable'}]){
  const client={hasCallerCredentials:()=>true,getPurchase:async()=>{},startPurchase:async()=>result};
  await assert.rejects(call('677289689108',client),e=>e.detail?.reason===(result.kind==='refused'?'ucp_reap_variant_not_created':'ucp_reap_create_outcome_unknown'));
 }
});
test('recovery derives the same selector without present-day variant reads',()=>{
 assert.equal(selectedReapVariantKey(args('42199434526795'),{},key,{recovery:true}),`${key}::v::42199434526795`);
 assert.equal(selectedReapVariantKey(args(),{},key,{recovery:true}),undefined);
});

test('the UCP adapter accepts the variant extension only on an enabled Reap create',async()=>{
 const { ucpToNativeToolArgs } = await import('../src/ucpArgumentAdapter.js');
 const wire={meta:{'idempotency-key':'selected-variant-key'},checkout:{line_items:[{item:{id:productId},quantity:1}],reap:{expected_merchant_domain:'kravebeauty.com',selected_variant_id:'677289689108'}}};
 assert.doesNotThrow(()=>ucpToNativeToolArgs({id:'create_checkout_session'},wire,env));
 assert.throws(()=>ucpToNativeToolArgs({id:'create_checkout_session'},wire,{}));
});
