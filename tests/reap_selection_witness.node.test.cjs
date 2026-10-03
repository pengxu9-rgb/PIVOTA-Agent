'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createReapAgenticPurchaseClient}=require('../src/services/reapAgenticPurchaseClient');
const {readSelectionWitness}=require('../src/services/reapSelectionWitness');
const KEY='prod::external_seed::external_seed::ext_fixture';
const ID='49819267301653';
const SKU=KEY+'::sku_58ae6f8de2c8797993f2';
const PID='rp_283fba3ce85c4e59bb331e54';
const SELECTION={product_key:KEY,variant_id:ID,variant_key:SKU,merchant_domain:'judydoll.com',market:'US',currency:'USD',unit_price_minor:1399,quantity:1,item_source:'cart_link'};
const ROW={product_id:'sig_fixture',product_key:KEY,platform:'external_seed',source_system:'external_product_seeds_mirror_v1',source_domain:'judydoll.com',external_redirect_url:'https://judydoll.com/products/fixture',
  variants:[{variant_id:ID,sku_key:SKU,price:{amount:'13.99',currency:'USD'}},{variant_id:'49819267301654',sku_key:KEY+'::sku_other',price:{amount:'15.00',currency:'USD'}}]};
const VIEW={id:PID,state:'resolving',merchant_domain:'judydoll.com',product_key:KEY,variant_key:'shopify:'+ID,quantity:1,product_name:'Fixture',totals:{currency:'USD',our_price_minor:1399,quoted_total_minor:null,final_total_minor:null},poll_after_seconds:5};
function args(selection=SELECTION) {return {meta:{'ucp-agent':{profile:'https://fixture.invalid/profile'},'idempotency-key':'same-original-selected-key'},checkout:{line_items:[{item:{id:'sig_fixture'},quantity:1}],context:{address_country:'US'},buyer:{email:'synthetic@example.test',consent_version:'reap-agentic-v1'},fulfillment:{methods:[{type:'shipping',destinations:[{first_name:'Synthetic',last_name:'Fixture',phone_number:'+14155550100',street_address:'900 Brannan St',address_locality:'San Francisco',address_region:'CA',postal_code:'94103',address_country:'US'}]}]},reap:{expected_merchant_domain:'judydoll.com',item_source:'cart_link',selected_variant_id:ID,...(selection===undefined?{}:{selection})}}};}
async function setup({row=ROW,selection=SELECTION,prepareStatus=200,prepareBody,throwPrepare=false}={}) {
 const m=await import('../mcp-server/src/commerceToolSurface.js');
 const calls=[],executorCalls=[],identityCalls=[];
 const client=createReapAgenticPurchaseClient({baseUrl:'https://backend.invalid',authHeaders:()=>({'X-API-Key':'ak_fixture','X-Agent-User-JWT':'synthetic-token'}),fetchImpl:async(url,init)=>{
   const path=new URL(url).pathname;const body=init.body?JSON.parse(init.body):null;calls.push({path,method:init.method,body});
   if(path.endsWith('/prepare')) {if(throwPrepare)throw Error('read unavailable');return{status:prepareStatus,text:async()=>JSON.stringify(prepareBody??{selection})};}
   if(path.endsWith('/recover'))return{status:200,text:async()=>JSON.stringify(VIEW)};
   if(init.method==='POST')return{status:202,text:async()=>JSON.stringify({purchase_id:PID,status:'resolving'})};
   return{status:200,text:async()=>JSON.stringify(VIEW)};
 }});
 const surface=m.ucpDialectSurface(m.createCommerceToolSurface({execute:async(op)=>{executorCalls.push(op);if(op!=='get_product')throw Error('alternate executor');return{product:row};}},{cache:false,reapAgentic:{client,recoveryIdentityReader:async(id)=>{identityCalls.push(id);return{product_id:id,product_key:KEY,source_domain:'now-foreign.invalid',platform:'external_seed',source_system:'changed',canonical_url:'https://now-foreign.invalid/pdp'};}}}));
 return{surface,calls,executorCalls,identityCalls};
}
async function armed(fn){const vars={REAP_AGENTIC_LANE_ENABLED:'1',REAP_AGENTIC_CREATE_ENABLED:'1',REAP_AGENTIC_CART_LINK_LANE_ENABLED:'1',MERCHANT_PURCHASABILITY_GATE_ENABLED:'0',AGENT_CHECKOUT_UCP_ESCALATION_ENABLED:'1'};const before={};for(const[k,v]of Object.entries(vars)){before[k]=process.env[k];process.env[k]=v;}try{return await fn();}finally{for(const[k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;}}
const SESSION={user_ref:'fixture-buyer',acp_session_id:'fixture-session',agent_id:'fixture-agent'};
const posts=x=>x.calls.filter(c=>c.method==='POST'&&!c.path.endsWith('/prepare')&&!c.path.endsWith('/recover'));

test('published read-only preparation exposes exact hashed SKU, then one selected first POST uses it',()=>armed(async()=>{
 const x=await setup();const prepared=await x.surface.callTool('prepare_checkout',args(undefined),SESSION);
 assert.deepEqual(prepared,{selection:SELECTION});assert.equal(posts(x).length,0);
 const out=await x.surface.callTool('create_checkout',args(prepared.selection),SESSION);
 assert.match(out.id,/^reap_rp_/);assert.equal(posts(x).length,1);assert.equal(posts(x)[0].body.variant_key,SKU);
 assert.equal(posts(x)[0].body.item_source,'cart_link');assert.equal(x.calls.filter(c=>c.path.endsWith('/prepare')).length,2);
 assert.ok(x.executorCalls.every(op=>op==='get_product'));
}));
test('numeric-only create cannot fabricate hashed mirror key after authoritative preparation; legacy recovery retains original spelling',()=>armed(async()=>{
 const x=await setup();const old=args();delete old.checkout.reap.selection;
 await assert.rejects(x.surface.callTool('create_checkout',old,SESSION));assert.equal(posts(x).length,0);
 await x.surface.callTool('recover_checkout',old,SESSION);
 const recovery=x.calls.find(c=>c.path.endsWith('/recover'));assert.equal(recovery.body.variant_key,KEY+'::v::'+ID);
 assert.equal(x.calls.filter(c=>c.path.endsWith('/prepare')).length,1);
}));
test('original canonical witness recovery is read-only after catalog, source, price and create gates drift',()=>armed(async()=>{
 const x=await setup({row:{...ROW,variants:[],price:999,currency:'EUR'}});
 process.env.REAP_AGENTIC_CREATE_ENABLED='0';process.env.REAP_AGENTIC_CART_LINK_LANE_ENABLED='0';
 const out=await x.surface.callTool('recover_checkout',args(),SESSION);assert.match(out.id,/^reap_rp_/);
 assert.equal(x.calls.length,1);assert.ok(x.calls[0].path.endsWith('/recover'));assert.equal(x.calls[0].body.variant_key,SKU);
 assert.equal(x.calls[0].body.merchant_domain,'judydoll.com');assert.equal(x.calls[0].body.item_source,'cart_link');
 assert.equal(x.executorCalls.length,0);assert.equal(x.identityCalls.length,0);
}));
for(const [name,edit]of Object.entries({foreign_product:s=>({...s,product_key:'foreign'}),foreign_sku:s=>({...s,variant_key:KEY+'::sku_other'}),foreign_variant:s=>({...s,variant_id:'49819267301654'}),foreign_seller:s=>({...s,merchant_domain:'foreign.invalid'}),market:s=>({...s,market:'CA'}),currency:s=>({...s,currency:'EUR'}),price:s=>({...s,unit_price_minor:1400}),quantity:s=>({...s,quantity:2}),source:s=>({...s,item_source:'reap_variant'}),float_price:s=>({...s,unit_price_minor:1399.5}),boolean_price:s=>({...s,unit_price_minor:true}),extra_key:s=>({...s,proof:'trusted'})})) {
 test('conflicting original '+name+' selection refuses before any checkout POST or alternate executor',()=>armed(async()=>{
  const x=await setup();await assert.rejects(x.surface.callTool('create_checkout',args(edit(SELECTION)),SESSION));assert.equal(posts(x).length,0);assert.ok(x.executorCalls.every(op=>op==='get_product'));
 }));
}
for(const [name,options]of Object.entries({price_drift:{selection:{...SELECTION,unit_price_minor:1599}},sku_drift:{selection:{...SELECTION,variant_key:KEY+'::sku_new'}},timeout:{throwPrepare:true},malformed:{prepareBody:{selection:{...SELECTION,unit_price_minor:'1399'}}},gate:{prepareStatus:503,prepareBody:{error:'not_available_on_this_rail'}}})) {
 test('prepare-to-create '+name+' refuses without a checkout POST or alternate route',()=>armed(async()=>{const x=await setup(options);await assert.rejects(x.surface.callTool('create_checkout',args(),SESSION),error=>error.detail?.reason==='ucp_reap_variant_not_created');assert.equal(posts(x).length,0);assert.ok(x.executorCalls.every(op=>op==='get_product'));}));
}
test('preparation and witness schema never accept defaults, false money, numeric-string money or extra proof',()=>{
 for(const value of [{...SELECTION,variant_key:''},{...SELECTION,variant_id:'Default'},{...SELECTION,unit_price_minor:false},{...SELECTION,unit_price_minor:'1399'},{...SELECTION,proof:{}},[]])assert.equal(readSelectionWitness(value),null);
});

test('structurally valid long original selector cannot authorize fresh preparation or a checkout POST',()=>armed(async()=>{const x=await setup();const long='123456789012345678901';const original={...SELECTION,variant_id:long};assert.ok(readSelectionWitness(original));const a=args(original);a.checkout.reap.selected_variant_id=long;await assert.rejects(x.surface.callTool('create_checkout',a,SESSION));assert.equal(posts(x).length,0);assert.equal(x.calls.filter(c=>c.path.endsWith('/prepare')).length,0);}));
