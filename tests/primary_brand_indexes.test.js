const {primaryBrandIndexDefinitions,inspectReadiness}=require('../scripts/catalog/primary_brand_indexes');
const {buildBrandIdentityPredicate,CANONICAL_OWN_BRAND_SQL}=require('../src/services/canonicalSearchQualitySql');
const {SEED_OWN_BRAND_SQL}=require('../src/services/seedSearchOfferScope');
test.each(primaryBrandIndexDefinitions())('index $name is bounded and exactly matches the query accelerator',index=>{
  const params=[];
  const expression=index.table==='catalog_products'?CANONICAL_OWN_BRAND_SQL.replace(/\bp\./g,''):SEED_OWN_BRAND_SQL;
  const where=buildBrandIdentityPredicate({brand_key:'mac_cosmetics',brand:'MAC'},expression,params);
  expect(where).toContain(index.expression+' = ANY(');
  expect(where).toContain('AND regexp_replace(');
  expect(params[0]).toContain('mac');expect(params[1].every(v=>/^[a-f0-9]{32}$/.test(v))).toBe(true);
  expect(index.sql).toContain('CREATE INDEX CONCURRENTLY');
  expect(index.sql).not.toContain('IF NOT EXISTS');
});
test('index readiness fails on missing/invalid indexes or unreviewed definitions',()=>{
  const rows=primaryBrandIndexDefinitions().map(i=>({index_name:i.name,table_name:i.table,table_schema:'public',indisvalid:true,indisready:true}));
  expect(inspectReadiness([]).ready).toBe(false);
  expect(inspectReadiness(rows).ready).toBe(false);
  expect(inspectReadiness(rows.map(row=>({...row,table_schema:'wrong'})),{definitionsReviewed:true}).ready).toBe(false);
  expect(inspectReadiness(rows.map(row=>({...row,table_name:'wrong'})),{definitionsReviewed:true}).ready).toBe(false);
  expect(inspectReadiness([{...rows[0],indisvalid:false},rows[1]],{definitionsReviewed:true}).ready).toBe(false);
  expect(inspectReadiness(rows,{definitionsReviewed:true}).ready).toBe(true);
});
