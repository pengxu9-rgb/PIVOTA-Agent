'use strict';
const {normalizedBrandIdentitySql,CANONICAL_OWN_BRAND_SQL}=require('../../src/services/canonicalSearchQualitySql');
const {SEED_OWN_BRAND_SQL}=require('../../src/services/seedSearchOfferScope');

function primaryBrandIndexDefinitions() {
  const canonical=normalizedBrandIdentitySql(CANONICAL_OWN_BRAND_SQL.replace(/\bp\./g,''));
  const seed=normalizedBrandIdentitySql(SEED_OWN_BRAND_SQL);
  return [
    {name:'idx_catalog_products_primary_brand_md5_v1',table:'catalog_products',expression:`md5(${canonical})`,predicate:null},
    {name:'idx_external_seeds_primary_brand_md5_v1',table:'external_product_seeds',expression:`md5(${seed})`,
      predicate:"status = 'active' AND coalesce(attached_product_key, '') <> ''"},
  ].map(index=>({...index,sql:`CREATE INDEX CONCURRENTLY ${index.name} ON ${index.table} (${index.table==='external_product_seeds'?'market, tool, ':''}(${index.expression}))${index.predicate?' WHERE '+index.predicate:''};`}));
}
function readinessSql() {
  const names=primaryBrandIndexDefinitions().map(index=>`'${index.name}'`).join(',');
  return `SELECT c.relname AS index_name, t.relname AS table_name, ns.nspname AS table_schema, i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS definition, pg_get_expr(i.indexprs, i.indrelid) AS expression, pg_get_expr(i.indpred, i.indrelid) AS predicate FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace WHERE ns.nspname=current_schema() AND c.relname IN (${names});`;
}
function inspectReadiness(rows, {definitionsReviewed=false,schema='public'}={}) {
  const expected=primaryBrandIndexDefinitions();
  const matching=rows.filter(row=>row.table_schema===schema && expected.some(index=>index.name===row.index_name && index.table===row.table_name));
  const missing=expected.filter(index=>!matching.some(row=>row.index_name===index.name)).map(index=>index.name);
  const invalid=matching.filter(row=>expected.some(index=>index.name===row.index_name) && (!row.indisvalid || !row.indisready)).map(row=>row.index_name);
  const structuralReady=!missing.length&&!invalid.length;
  return {structural_ready:structuralReady,ready:structuralReady&&definitionsReviewed,missing,invalid,definition_review_required:!definitionsReviewed};
}
if(require.main===module) {
  const definitions=primaryBrandIndexDefinitions();
  if(process.argv.includes('--sql')) console.log('-- Run each statement in autocommit, outside a transaction. Review existing definitions/readiness first.\nSET search_path TO public;\n'+definitions.map(index=>index.sql).join('\n\n'));
  else console.log(JSON.stringify({schema:'public',session_sql:'SET search_path TO public;',indexes:definitions,readiness_sql:readinessSql()},null,2));
}
module.exports={primaryBrandIndexDefinitions,readinessSql,inspectReadiness};
