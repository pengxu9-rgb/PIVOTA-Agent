import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectedReapVariantKey, tryReapAgenticCheckout, decodeReapCheckoutId } from '../src/ucpReapAgenticLane.js';
import { toToolError } from '../src/commerceToolSurface.js';
import { PivotaCommerceError } from '../../safety-kernel/src/errors.js';
import { readFileSync } from 'node:fs';
const capturedRow = JSON.parse(readFileSync(new URL('./fixtures/krave-canonical-detail.json', import.meta.url), 'utf8'));
const key = 'prod::external_seed::external_seed::ext_3e6db6ab9ff14b9fb21f45a8';
const productId = 'sig_436641888f6a84f14c02ed293d9596a7';
const row = { product_id: productId, product_key: key, source_system: 'external_product_seeds_mirror_v1', platform: 'external_seed', price: 16, currency: 'USD', external_redirect_url: 'https://kravebeauty.com/products/matcha-hemp-hydrating-cleanser', purchase_grain: 'product', variants: [
 { variant_id: '677289689108', price: {amount:16,currency:'USD'} }, {variant_id:'42199434526795',price:{amount:27,currency:'USD'}},
] };
const minorFor=id=>id==='42199434526795'?2700:1600;
const selection=id=>({product_key:key,variant_id:id,variant_key:`${key}::sku_selected_${id}`,merchant_domain:'kravebeauty.com',market:'US',currency:'USD',unit_price_minor:minorFor(id),quantity:1,item_source:'cart_link'});
const args = id => ({ checkout: {context:{address_country:'US'},fulfillment:{methods:[{type:'shipping',destinations:[{address_country:'US',street_address:'900 Brannan St',address_locality:'San Francisco',postal_code:'94103'}]}]},reap: { expected_merchant_domain:'kravebeauty.com',item_source:'cart_link', ...(id ? {selected_variant_id:id,selection:selection(id)}: {}) } } });
const preparePurchase=async request=>({kind:'accepted',selection:selection(request.variant_id)});
const env={REAP_AGENTIC_LANE_ENABLED:'1',REAP_AGENTIC_CREATE_ENABLED:'1',REAP_AGENTIC_CART_LINK_LANE_ENABLED:'1'};
const call = (id,client, extra={}) => tryReapAgenticCheckout({op:{id:'create_checkout_session'},params:{idempotency_key:'same-attempt-123', quote:{items:[{product_id:productId,quantity:1}]}},ctx:{},executor:{execute:async()=>({product:row})},ucpArgs:args(id),client,env,...extra});
for (const [id,minor] of [['677289689108',1600],['42199434526795',2700]]) {
 test(`selected ${id} reaches the cart-link backend with its own price snapshot`, async()=>{
  let body;
  const client={preparePurchase,hasCallerCredentials:()=>true,getPurchase:async()=>{},startPurchase:async b=>{body=b;return {kind:'accepted',purchase:{id:'rp_'+'a'.repeat(24),state:'resolving',product_key:key,quantity:1,totals:{currency:'USD',our_price_minor:minor}}};}};
  const view=await call(id,client);
  assert.equal(body.variant_key,selection(id).variant_key);
  assert.equal(body.item_source,'cart_link');
  assert.equal(decodeReapCheckoutId(view.id).unitMinor,minor);
 });
}
test('missing or foreign variant is a proven pre-dispatch refusal',async()=>{
 let creates=0;
 const client={preparePurchase,hasCallerCredentials:()=>true,getPurchase:async()=>{},startPurchase:async()=>{creates++;}};
 for (const id of [undefined,'999']) await assert.rejects(call(id,client),e=>e.detail?.reason==='ucp_reap_variant_not_created');
 assert.equal(creates,0);
});
test('backend proof refusal is not-created, while a timeout remains unknown',async()=>{
 for(const result of [{kind:'refused',http_status:409,code:'row_variant_unverified'},{kind:'unavailable'}]){
  const client={preparePurchase,hasCallerCredentials:()=>true,getPurchase:async()=>{},startPurchase:async()=>result};
  await assert.rejects(call('677289689108',client),e=>e.detail?.reason===(result.kind==='refused'?'ucp_reap_variant_not_created':'ucp_reap_create_outcome_unknown'));
 }
});
test('recovery derives the same selector without present-day variant reads',()=>{
 assert.equal(selectedReapVariantKey(args('42199434526795'),{},key,{recovery:true}),selection('42199434526795').variant_key);
 const legacy=args('42199434526795');delete legacy.checkout.reap.selection;assert.equal(selectedReapVariantKey(legacy,{},key,{recovery:true}),`${key}::v::42199434526795`);
 assert.equal(selectedReapVariantKey(args(),{},key,{recovery:true}),undefined);
});

for (const code of ['create_disabled', 'pilot_scope_invalid', 'reap_create_paused']) {
 test(`backend-only ${code} cannot fall through to another checkout route`,async()=>{
  let dispatches=0;
  const client={preparePurchase,hasCallerCredentials:()=>true,getPurchase:async()=>{},startPurchase:async()=>{
   dispatches++;return {kind:'refused',http_status:404,code};
  }};
  await assert.rejects(call('677289689108',client),error=>{
   assert.equal(error.code,'CHECKOUT_OUTCOME_UNKNOWN');
   assert.deepEqual(JSON.parse(toToolError(error).content[0].text).error.detail,{reason:'ucp_reap_create_outcome_unknown'});
   return true;
  });
  assert.equal(dispatches,1);
 });
}

test('the UCP adapter accepts the variant extension only on an enabled Reap create',async()=>{
 const { ucpToNativeToolArgs } = await import('../src/ucpArgumentAdapter.js');
 const wire={meta:{'idempotency-key':'selected-variant-key'},checkout:{line_items:[{item:{id:productId},quantity:1}],reap:{expected_merchant_domain:'kravebeauty.com',selected_variant_id:'677289689108'}}};
 assert.doesNotThrow(()=>ucpToNativeToolArgs({id:'create_checkout_session'},wire,env));
 assert.throws(()=>ucpToNativeToolArgs({id:'create_checkout_session'},wire,{}));
});

for (const [id,minor] of [['677289689108',1600],['42199434526795',2700]]) {
 test(`captured canonical price.current for ${id} preserves its exact amount`,async()=>{
  let body;
  const client={preparePurchase,hasCallerCredentials:()=>true,getPurchase:async()=>{},startPurchase:async b=>{body=b;return {kind:'accepted',purchase:{id:'rp_'+'b'.repeat(24),state:'resolving',product_key:key,quantity:1,totals:{currency:'USD',our_price_minor:minor}}};}};
  const view=await call(id,client,{executor:{execute:async()=>({product:capturedRow})}});
  assert.equal(body.variant_key,selection(id).variant_key);
  assert.equal(decodeReapCheckoutId(view.id).unitMinor,minor);
 });
 test(`captured ${id} reaches pause and publishes a definitive wire refusal`,async()=>{
  let dispatches=0;
  const client={preparePurchase,hasCallerCredentials:()=>true,getPurchase:async()=>{},startPurchase:async()=>{dispatches++;}};
  await assert.rejects(call(id,client,{executor:{execute:async()=>({product:capturedRow})},env:{...env,REAP_AGENTIC_CREATE_ENABLED:'0'}}),error=>{
   const wire=JSON.parse(toToolError(error).content[0].text);
   assert.equal(wire.error.code,'OPERATION_NOT_ALLOWED');
   assert.deepEqual(wire.error.detail,{reason:'reap_create_paused'});
   return true;
  });
  assert.equal(dispatches,0);
 });
}
test('unpriced captured variant publishes not-created without falling back to product price',async()=>{
 const product=structuredClone(capturedRow);delete product.variants[0].price.current.currency;
 let dispatches=0;
 await assert.rejects(call('677289689108',{hasCallerCredentials:()=>true,getPurchase:async()=>{},startPurchase:async()=>{dispatches++;}},{executor:{execute:async()=>({product})}}),error=>{
  assert.deepEqual(JSON.parse(toToolError(error).content[0].text).error.detail,{reason:'ucp_reap_variant_not_created'});return true;
 });
 assert.equal(dispatches,0);
});
test('lane wire reasons are allowlisted and never publish arbitrary detail',()=>{
 const err=new PivotaCommerceError('QUOTE_REQUIRED',{reason:'ucp_reap_variant_not_created',secret:'must_not_leak',cause:'private'});
 const wire=JSON.parse(toToolError(err).content[0].text);
 assert.deepEqual(wire.error.detail,{reason:'ucp_reap_variant_not_created'});
 assert.ok(!JSON.stringify(wire).includes('must_not_leak'));
 assert.equal(JSON.parse(toToolError(new PivotaCommerceError('QUOTE_REQUIRED',{reason:'other_private_value'})).content[0].text).error.detail,undefined);
 assert.deepEqual(JSON.parse(toToolError(new PivotaCommerceError('CHECKOUT_OUTCOME_UNKNOWN',{reason:'reap_create_paused'})).content[0].text).error.detail,{reason:'ucp_reap_create_outcome_unknown'});
});
