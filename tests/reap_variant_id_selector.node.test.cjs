'use strict';
// A numeric-only selected cart-link create (no prepare witness) sends the storefront id as `variant_id`, never a
// spelled sku key; recovery and resume probe exactly the spellings an attempt may have been created with. The fake
// backend below keeps ONE fingerprint per idempotency key, spelled the way pivota-backend's `_variant_selector`
// spells it (`variant_id:<n>`, else the sent `variant_key`), and answers a different body with
// `409 idempotency_conflict` — so a retry that does not hash the same as its original body fails here.
const test=require('node:test');
const assert=require('node:assert/strict');
const {createReapAgenticPurchaseClient}=require('../src/services/reapAgenticPurchaseClient');
const KEY='prod::external_seed::external_seed::ext_fixture';
const ID='49819267301653';
const SKU=KEY+'::sku_58ae6f8de2c8797993f2';
const LEGACY_KEY=KEY+'::v::'+ID;
const PID='rp_283fba3ce85c4e59bb331e54';
const SELECTION={product_key:KEY,variant_id:ID,variant_key:SKU,merchant_domain:'fixture-store.com',market:'US',currency:'USD',unit_price_minor:1399,quantity:1,item_source:'cart_link'};
const ROW={product_id:'sig_fixture',product_key:KEY,platform:'external_seed',source_system:'external_product_seeds_mirror_v1',source_domain:'fixture-store.com',external_redirect_url:'https://fixture-store.com/products/fixture',
  variants:[{variant_id:ID,sku_key:SKU,price:{amount:'13.99',currency:'USD'}},{variant_id:'49819267301654',sku_key:KEY+'::sku_other',price:{amount:'15.00',currency:'USD'}}]};
const VIEW={id:PID,state:'resolving',merchant_domain:'fixture-store.com',product_key:KEY,quantity:1,product_name:'Fixture',totals:{currency:'USD',our_price_minor:1399,quoted_total_minor:null,final_total_minor:null},poll_after_seconds:5};
const SESSION={user_ref:'fixture-buyer',acp_session_id:'fixture-session',agent_id:'fixture-agent'};
// `source: null` sends no item_source (the lane then probes both key namespaces).
function args({selected=ID,source='cart_link'}={}) {
  const reap={expected_unit_price_minor:1399,expected_currency:'USD',expected_merchant_domain:'fixture-store.com',selected_variant_id:selected};
  if (source!==null) reap.item_source=source;
  return {meta:{'ucp-agent':{profile:'https://fixture.invalid/profile'},'idempotency-key':'same-original-selected-key'},checkout:{line_items:[{item:{id:'sig_fixture'},quantity:1}],context:{address_country:'US'},buyer:{email:'synthetic@example.test',consent_version:'reap-agentic-v1'},fulfillment:{methods:[{type:'shipping',destinations:[{first_name:'Synthetic',last_name:'Fixture',phone_number:'+14155550100',street_address:'900 Brannan St',address_locality:'San Francisco',address_region:'CA',postal_code:'94103',address_country:'US'}]}]},reap}};
}
// The backend's fingerprint: what was SENT, the selector spelled by `_variant_selector`.
function fingerprint(body) {
  const {idempotency_key:_k,variant_id,variant_key,...rest}=body;
  const variant=variant_id!==undefined?'variant_id:'+variant_id:(variant_key||null);
  return canonical({...rest,item_source:rest.item_source||'reap_variant',variant});
}
// The backend hashes parsed fields, never the order a body spelled them in.
function canonical(value){return Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);}
// The backend's conflict body names the purchase the key opened (`_refused`, owner-scoped).
const CONFLICT={error:'idempotency_conflict',purchase_id:PID,rail:'reap'};
function json(status,body){return{status,text:async()=>JSON.stringify(body)};}
async function setup({ledger=new Map(),view=VIEW}={}) {
  const m=await import('../mcp-server/src/commerceToolSurface.js');
  const calls=[];
  const lookup=(body)=>{const held=ledger.get(body.idempotency_key);return !held?'absent':held.hash===fingerprint(body)?'match':'conflict';};
  const client=createReapAgenticPurchaseClient({baseUrl:'https://backend.invalid',authHeaders:()=>({'X-API-Key':'ak_fixture','X-Agent-User-JWT':'synthetic-token'}),fetchImpl:async(url,init)=>{
    const path=new URL(url).pathname;const body=init.body?JSON.parse(init.body):null;calls.push({path,method:init.method,body});
    if(path.endsWith('/prepare'))return json(200,{selection:SELECTION});
    if(path.endsWith('/recover')){const hit=lookup(body);return hit==='absent'?json(404,{error:'purchase_not_found'}):hit==='match'?json(200,view):json(409,CONFLICT);}
    if(path.endsWith('/resume')){return lookup(body)==='match'?json(202,{purchase_id:PID,status:'resolving'}):json(409,{error:'idempotency_conflict'});}
    if(init.method==='POST'){
      const hit=lookup(body);
      if(hit==='conflict')return json(409,CONFLICT);
      if(hit==='absent')ledger.set(body.idempotency_key,{hash:fingerprint(body)});
      return json(202,{purchase_id:PID,status:'resolving'});
    }
    return json(200,view);
  }});
  const surface=m.ucpDialectSurface(m.createCommerceToolSurface({execute:async(op)=>{if(op!=='get_product')throw Error('alternate executor');return{product:ROW};}},{cache:false,reapAgentic:{client,recoveryIdentityReader:async(id)=>({product_id:id,product_key:KEY,source_domain:'fixture-store.com',platform:'external_seed',source_system:'external_product_seeds_mirror_v1',external_redirect_url:'https://fixture-store.com/products/fixture'})}}));
  return{surface,calls,ledger};
}
async function armed(fn){const vars={REAP_AGENTIC_LANE_ENABLED:'1',REAP_AGENTIC_CREATE_ENABLED:'1',REAP_AGENTIC_CART_LINK_LANE_ENABLED:'1',MERCHANT_PURCHASABILITY_GATE_ENABLED:'0',AGENT_CHECKOUT_UCP_ESCALATION_ENABLED:'1'};const before={};for(const[k,v]of Object.entries(vars)){before[k]=process.env[k];process.env[k]=v;}try{return await fn();}finally{for(const[k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;}}
const creates=x=>x.calls.filter(c=>c.method==='POST'&&!/\/(prepare|recover|resume)$/.test(c.path));
const recovers=x=>x.calls.filter(c=>c.path.endsWith('/recover'));
// EXACTLY what the gateway sent for this numeric-only selected create BEFORE it sent `variant_id`: captured from
// origin/main's lane (e6708859a, prepare answering the guessed key, the only case that lane dispatched). A literal, so a
// change to any other create field cannot move this legacy body along with it.
const LEGACY_BODY={merchant_domain:'fixture-store.com',product_key:KEY,quantity:1,
  buyer:{email:'synthetic@example.test',consent_version:'reap-agentic-v1',shipping_address:{firstName:'Synthetic',lastName:'Fixture',phone:'+14155550100',addressLine1:'900 Brannan St',city:'San Francisco',region:'CA',postalCode:'94103',country:'US'}},
  idempotency_key:'ucp-reap-v1-f00a66ff39227d741319966c657bb798578a625a92912761',expected_unit_price_minor:1399,expected_currency:'USD',
  variant_key:LEGACY_KEY,item_source:'cart_link'};
async function legacyOriginalBody(){return structuredClone(LEGACY_BODY);}
const seeded=body=>new Map([[body.idempotency_key,{hash:fingerprint(body)}]]);
const unknown=e=>e.code==='CHECKOUT_OUTCOME_UNKNOWN';

test('a numeric-only selected create sends variant_id, never a spelled key, even where the catalog keys the variant by hash',()=>armed(async()=>{
  const x=await setup();const out=await x.surface.callTool('create_checkout',args(),SESSION);
  assert.match(out.id,/^reap_rp_/);
  const body=creates(x)[0].body;
  assert.equal(creates(x).length,1);
  assert.equal(body.variant_id,ID);
  assert.equal(Object.hasOwn(body,'variant_key'),false,'no key is guessed for a create');
  assert.equal(body.item_source,'cart_link');
  const {variant_key:_legacy,...rest}=LEGACY_BODY;
  assert.deepEqual(body,{...rest,variant_id:ID},'only the selector differs from the legacy body');
}));

test('a variant_id attempt recovers with the identical body: one probe, same fingerprint',()=>armed(async()=>{
  const x=await setup();const created=await x.surface.callTool('create_checkout',args(),SESSION);
  const original=creates(x)[0].body;
  process.env.REAP_AGENTIC_CREATE_ENABLED='0';
  const out=await x.surface.callTool('recover_checkout',args(),SESSION);
  assert.equal(out.id,created.id);
  assert.equal(recovers(x).length,1);
  assert.deepEqual(recovers(x)[0].body,original);
  assert.equal(creates(x).length,1);
}));

test('a legacy attempt keyed with the guessed variant_key recovers by sending exactly that key',()=>armed(async()=>{
  const legacy=await legacyOriginalBody();
  const x=await setup({ledger:seeded(legacy)});
  process.env.REAP_AGENTIC_CREATE_ENABLED='0';
  const out=await x.surface.callTool('recover_checkout',args(),SESSION);
  assert.match(out.id,/^reap_rp_/);
  const probes=recovers(x);
  assert.equal(probes.length,2);
  assert.equal(probes[0].body.variant_id,ID,'the current spelling is probed first and conflicts');
  assert.deepEqual(probes[1].body,legacy,'the legacy body is reconstructed byte for byte');
  assert.equal(Object.hasOwn(probes[1].body,'variant_id'),false);
  assert.equal(creates(x).length,0);
}));

test('resume of a legacy attempt continues with the legacy body it was recovered by',()=>armed(async()=>{
  const legacy=await legacyOriginalBody();
  const view={...VIEW,checkout_dispatch_state:'not_dispatched',contact_reentry_required:true};
  const x=await setup({ledger:seeded(legacy),view});
  const recovered=await x.surface.callTool('recover_checkout',args(),SESSION);
  const out=await x.surface.callTool('resume_checkout',{...args(),checkout_id:recovered.id},SESSION);
  assert.equal(out.id,recovered.id);
  const resumes=x.calls.filter(c=>c.path.endsWith('/resume'));
  assert.equal(resumes.length,1);
  assert.deepEqual(resumes[0].body,legacy);
  assert.equal(creates(x).length,0);
}));

test('a create retried across the switch over a legacy attempt conflicts and is unknown, never a second purchase',()=>armed(async()=>{
  const legacy=await legacyOriginalBody();
  const x=await setup({ledger:seeded(legacy)});
  await assert.rejects(x.surface.callTool('create_checkout',args(),SESSION),unknown);
  assert.equal(creates(x).length,1);
  assert.equal(creates(x)[0].body.variant_id,ID);
  assert.equal(x.ledger.size,1);
}));

test('a key holding a body neither spelling matches stays unknown',()=>armed(async()=>{
  const legacy=await legacyOriginalBody();
  const x=await setup({ledger:seeded({...legacy,quantity:2})});
  process.env.REAP_AGENTIC_CREATE_ENABLED='0';
  await assert.rejects(x.surface.callTool('recover_checkout',args(),SESSION),unknown);
  assert.equal(recovers(x).length,2);
}));

test('no attempt under either spelling stays unknown, never permission to start another',()=>armed(async()=>{
  const x=await setup();process.env.REAP_AGENTIC_CREATE_ENABLED='0';
  await assert.rejects(x.surface.callTool('recover_checkout',args(),SESSION),unknown);
  assert.deepEqual(recovers(x).map(c=>c.body.variant_id??c.body.variant_key),[ID,LEGACY_KEY]);
}));

test('a witness attempt probes only its own sku, even on a conflict',()=>armed(async()=>{
  const legacy=await legacyOriginalBody();
  const x=await setup({ledger:seeded(legacy)});
  process.env.REAP_AGENTIC_CREATE_ENABLED='0';
  const a=args();a.checkout.reap.selection={...SELECTION};
  await assert.rejects(x.surface.callTool('recover_checkout',a,SESSION),unknown);
  assert.equal(recovers(x).length,1);
  assert.equal(recovers(x)[0].body.variant_key,SKU);
  assert.equal(Object.hasOwn(recovers(x)[0].body,'variant_id'),false);
}));

test('a selector longer than the backend bound recovers by its legacy key alone',()=>armed(async()=>{
  const long='1234567890123456789012';
  const x=await setup();process.env.REAP_AGENTIC_CREATE_ENABLED='0';
  await assert.rejects(x.surface.callTool('recover_checkout',args({selected:long}),SESSION),unknown);
  assert.deepEqual(recovers(x).map(c=>[c.body.variant_id,c.body.variant_key]),[[undefined,KEY+'::v::'+long]]);
}));

test('without an explicit source, only the cart-link namespace ever carries variant_id',()=>armed(async()=>{
  const x=await setup();process.env.REAP_AGENTIC_CREATE_ENABLED='0';
  await assert.rejects(x.surface.callTool('recover_checkout',args({source:null}),SESSION),unknown);
  const probes=recovers(x);
  assert.ok(probes.some(c=>c.body.item_source===undefined),'the variant-lane namespace is probed');
  for(const c of probes){
    if(c.body.item_source!=='cart_link'){assert.equal(c.body.variant_key,LEGACY_KEY);assert.equal(Object.hasOwn(c.body,'variant_id'),false);}
  }
  assert.ok(probes.some(c=>c.body.item_source==='cart_link'&&c.body.variant_id===ID));
  assert.ok(probes.some(c=>c.body.item_source==='cart_link'&&c.body.variant_key===LEGACY_KEY));
}));

test('a conflict in one namespace is never outvoted by a match in the other',()=>armed(async()=>{
  // Learn both namespaces' bodies from an empty ledger, then: the variant lane's key matches, while the cart-link
  // key holds some OTHER body. Two attempts may exist; the answer must stay unknown.
  const probe=await setup();process.env.REAP_AGENTIC_CREATE_ENABLED='0';
  await assert.rejects(probe.surface.callTool('recover_checkout',args({source:null}),SESSION),unknown);
  const variantLane=recovers(probe).find(c=>c.body.item_source===undefined).body;
  const cartLegacy=recovers(probe).find(c=>c.body.item_source==='cart_link'&&c.body.variant_key===LEGACY_KEY).body;
  const ledger=new Map([[variantLane.idempotency_key,{hash:fingerprint(variantLane)}],[cartLegacy.idempotency_key,{hash:fingerprint({...cartLegacy,quantity:2})}]]);
  const x=await setup({ledger});
  await assert.rejects(x.surface.callTool('recover_checkout',args({source:null}),SESSION),unknown);
}));
