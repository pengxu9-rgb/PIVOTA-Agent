
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
