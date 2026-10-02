'use strict';const test=require('node:test'),assert=require('node:assert/strict');
const {understandShoppingQuery,buildSearchQualityContract}=require('../src/findProductsMulti/queryUnderstanding');
const {fetchCanonicalChainRows}=require('../src/services/canonicalCatalogSearch');
test('named lip ink is a beauty lip query without requiring a brand cache or claiming strict lipstick',()=>{
 const query='Judydoll Silky Matte Lip Ink 07 Burgundy Ink';const u=understandShoppingQuery({rawQuery:query});const c=buildSearchQualityContract({rawQuery:query,market:'US'});
 assert.equal(u.category_path_prefix,'beauty/makeup/lip/');assert.equal(c.target_domain,'beauty');assert.equal(c.hard_constraints.strict_lipstick,false);
 assert.equal(c.hard_constraints.brand,null);
});
test('bare ink and tattoo ink keep their existing non-beauty classification',()=>{
 for(const rawQuery of ['printer ink','tattoo ink','burgundy ink'])assert.equal(buildSearchQualityContract({rawQuery}).target_domain,'other');
});
test('lip-ink admission is own-name evidence with precise or shallow beauty scope, never description rescue',async()=>{
 const query='Judydoll Silky Matte Lip Ink';const contract=buildSearchQualityContract({rawQuery:query});let sql,params;
 await fetchCanonicalChainRows({query,categoryPathPrefix:contract.hard_constraints.category_path_prefix,categoryMode:'category_browse',searchQualityContract:contract,deps:{query:async(s,p)=>{sql=s;params=p;return{rows:[]};}}});
 assert.ok(params.includes('(^| )(lip[ ]+inks?)($| )'));assert.ok(params.some(x=>Array.isArray(x)&&x.includes('beauty')));
 const where=sql.slice(sql.indexOf('WHERE'),sql.indexOf('LIMIT $3'));assert.match(where,/p\.title, p\.product_type/);assert.ok(!where.includes('p.description'));
});
test('actual serving hard gate matches SQL lip-ink admission but rejects cross-sell/accessory/conflicting category',()=>{
 const {getSearchQualityContractHardConstraintResult}=require('../src/server')._debug;
 const query='Judydoll Silky Matte Lip Ink';const c=buildSearchQualityContract({rawQuery:query});
 const base={brand:'Judydoll',category_path:'beauty',product_type:'Beauty Product'};
 assert.equal(getSearchQualityContractHardConstraintResult({...base,title:'Silky Matte Lip Ink'},c,query).eligible,true);
 for(const product of [{...base,title:'Soft Face Cream',description:'Pair with Silky Matte Lip Ink'},{...base,title:'Brush for Lip Ink'},{...base,title:'Silky Matte Lip Ink',category_path:'beauty/skincare/moisturize/'}]){
  assert.equal(getSearchQualityContractHardConstraintResult(product,c,query).eligible,false);
 }
});
