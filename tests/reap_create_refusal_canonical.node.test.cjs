
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createReapAgenticPurchaseClient}=require('../src/services/reapAgenticPurchaseClient');
const authHeaders=()=>({'X-API-Key':'synthetic-agent','X-Agent-User-JWT':'synthetic-buyer'});
const mainEnvelope=(status,code)=>({status:'error',error:{code:status===400?'INVALID_REQUEST':'CONFLICT',message:code,details:{error:code}},detail:{error:code}});
const shapes={flat:(s,c)=>({error:c}),nested:(s,c)=>({detail:{error:c}}),main:mainEnvelope};
for(const strict of [false,true])for(const [shape,envelope]of Object.entries(shapes))for(const [status,code]of [[400,'invalid_request'],[409,'merchant_not_eligible'],[409,'idempotency_conflict']]){
 test(`Canonical create refusal: ${strict?'private':'ordinary'} recognizes ${shape} ${status} ${code}`,async()=>{
  const c=createReapAgenticPurchaseClient({baseUrl:'https://backend.invalid',authHeaders,requireAuthoritativeRefusal:strict,fetchImpl:async()=>({status,text:async()=>JSON.stringify(envelope(status,code))})});
  const result=await c.startPurchase({});assert.equal(result.kind,'refused');assert.equal(result.code,code);
 });
}
const bad=[
 ['empty409',409,{}],['HTML409',409,'<html>platform error</html>'],
 ['unknown flat409',409,{error:'unknown_refusal'}],['unknown nested409',409,{detail:{error:'unknown_refusal'}}],
 ['auth401',401,{error:'agent_user_required'}],['auth403',403,{detail:{error:'forbidden'}}],
 ['rail404',404,{error:'not_available_on_this_rail'}],['pilot404',404,{error:'pilot_scope_refused'}],
 ['rate429',429,{error:'rate_limited'}],['wrong status',400,{error:'merchant_not_eligible'}],
 ['conflicting strings',409,{error:'merchant_disabled',detail:{error:'merchant_not_eligible'}}],
 ['malformed detail',409,{error:'merchant_not_eligible',detail:null}],
 ['conflicting main details',409,{...mainEnvelope(409,'merchant_not_eligible'),error:{code:'CONFLICT',message:'merchant_not_eligible',details:{error:'merchant_disabled'}}}],
 ['conflicting main message',409,{...mainEnvelope(409,'merchant_not_eligible'),error:{code:'CONFLICT',message:'merchant_disabled',details:{error:'merchant_not_eligible'}}}],
 ['wrong main status marker',409,{...mainEnvelope(409,'merchant_not_eligible'),status:'success'}],
 ['wrong main class',409,{...mainEnvelope(409,'merchant_not_eligible'),error:{code:'INVALID_REQUEST',message:'merchant_not_eligible',details:{error:'merchant_not_eligible'}}}],
];
for(const strict of [false,true])for(const[label,status,body]of bad){
 test(`Canonical create refusal: ${strict?'private':'ordinary'} dispatched ${label} stays unavailable`,async()=>{
  const c=createReapAgenticPurchaseClient({baseUrl:'https://backend.invalid',authHeaders,requireAuthoritativeRefusal:strict,fetchImpl:async()=>({status,text:async()=>JSON.stringify(body)})});
  assert.equal((await c.startPurchase({})).kind,'unavailable');
 });
}

// Only a coherent original-owner miss may advance legacy namespace recovery.
const ownerMissShapes = [
 ['flat', {error:'purchase_not_found'}, 'not_found'],
 ['detail', {detail:{error:'purchase_not_found'}}, 'not_found'],
 ['full-main', {status:'error',error:{code:'PRODUCT_NOT_FOUND',message:'purchase_not_found',details:{error:'purchase_not_found'}},detail:{error:'purchase_not_found'}}, 'not_found'],
 ['conflicting flat/detail', {detail:{error:'purchase_not_found'},error:'rail_unconfigured'}, 'unavailable'],
 ['success detailed', {status:'success',detail:{error:'purchase_not_found'}}, 'unavailable'],
 ['success flat', {status:'success',error:'purchase_not_found'}, 'unavailable'],
 ['malformed error object', {detail:{error:'purchase_not_found'},error:{}}, 'unavailable'],
 ['wrong structured class', {status:'error',error:{code:'NOT_FOUND',message:'purchase_not_found',details:{error:'purchase_not_found'}},detail:{error:'purchase_not_found'}}, 'unavailable'],
 ['conflicting structured message', {status:'error',error:{code:'PRODUCT_NOT_FOUND',message:'rail_unconfigured',details:{error:'purchase_not_found'}},detail:{error:'purchase_not_found'}}, 'unavailable'],
 ['conflicting structured detail', {status:'error',error:{code:'PRODUCT_NOT_FOUND',message:'purchase_not_found',details:{error:'rail_unconfigured'}},detail:{error:'purchase_not_found'}}, 'unavailable'],
];
for(const strict of [false,true])for(const [shape,body,expected]of ownerMissShapes)for(const operation of ['getPurchase','recoverPurchase']){
 test(`Canonical owner404: ${strict?'private':'ordinary'} ${operation} ${shape}`,async()=>{
  const c=createReapAgenticPurchaseClient({baseUrl:'https://backend.invalid',authHeaders,requireAuthoritativeRefusal:strict,fetchImpl:async()=>({status:404,text:async()=>JSON.stringify(body)})});
  const result=await c[operation](operation==='getPurchase'?'rp_'+'1'.repeat(24):{idempotency_key:'synthetic'});assert.equal(result.kind,expected);
 });
}
