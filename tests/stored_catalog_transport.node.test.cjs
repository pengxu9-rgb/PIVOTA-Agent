'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const axios=require('axios');
const {assertStoredCatalogHttp,installStoredCatalogHttpGuard}=require('../src/config/storedCatalogTransport');
const env={GATEWAY_STORED_CATALOG_REHEARSAL:'1',PORT:'8795'};
test('ordinary config and transport remain unchanged when rehearsal is absent',async()=>{
 const config={url:'https://merchant.invalid/x',maxRedirects:3};assert.equal(assertStoredCatalogHttp(config,{}),config);
 const instance=axios.create();assert.equal(installStoredCatalogHttpGuard(instance,{}),null);
});
test('remote backend, merchant, redirected/credentialed and alternate-loopback reads refuse before transport',async()=>{
 for(const url of ['https://merchant.invalid/products/x','https://backend.run.app/agent/shop/v1/invoke','http://127.0.0.1:8776/agent/shop/v1/invoke','http://localhost:8795/agent/shop/v1/invoke','http://user:password@127.0.0.1:8795/agent/shop/v1/invoke','http://127.0.0.1:8795/other','not a url']){
  let calls=0;const instance=axios.create({adapter:async()=>{calls++;throw Error('TRANSPORT_MUST_NOT_RUN');}});installStoredCatalogHttpGuard(instance,env);
  await assert.rejects(instance.post(url,{}),e=>e.code==='STORED_CATALOG_REMOTE_READ_DISABLED');assert.equal(calls,0);
 }
});
test('exact self invoke preserves app headers/body and disables redirect dispatch',async()=>{
 let seen;const instance=axios.create({adapter:async(config)=>{seen=config;return{data:{ok:true},status:200,statusText:'OK',headers:{},config};}});installStoredCatalogHttpGuard(instance,env);
 const result=await instance.post('http://127.0.0.1:8795/agent/shop/v1/invoke',{operation:'get_pdp_v2'},{headers:{Authorization:'Bearer synthetic','X-Agent-User-JWT':'synthetic-owner'},maxRedirects:8});
 assert.equal(result.status,200);assert.equal(seen.maxRedirects,0);assert.equal(seen.headers.Authorization,'Bearer synthetic');assert.equal(seen.headers['X-Agent-User-JWT'],'synthetic-owner');assert.equal(JSON.parse(seen.data).operation,'get_pdp_v2');
});
