'use strict';
const {normalizedBrandIdentitySql,CANONICAL_OWN_BRAND_SQL}=require('../../src/services/canonicalSearchQualitySql');
const {SEED_OWN_BRAND_SQL}=require('../../src/services/seedSearchOfferScope');
const {BRAND_SEED_SCAN_PREDICATE,seedBrandIdentitySql,seedDomainIdentitySql,seedTitleSql}=require('../../src/services/brandSeedScanSql');
const {CANONICAL_BRAND_MATCH_PREDICATE,canonicalBrandCompactSql,canonicalBrandLowerSql}=require('../../src/services/canonicalBrandMatchSql');
const {PRODUCT_GROUP_REF_KEY_INDEX,RELATIONSHIP_GRAPH_REF_KEY_COLUMNS,productGroupRefKeyIndexExpressionSql,refKeyIndexExpressionSql,refKeyIndexName}=require('../../src/services/relationshipGraphRefKeySql');

function primaryBrandIndexDefinitions() {
  const canonical=normalizedBrandIdentitySql(CANONICAL_OWN_BRAND_SQL.replace(/\bp\./g,''));
  const seed=normalizedBrandIdentitySql(SEED_OWN_BRAND_SQL);
  return [
    {name:'idx_catalog_products_primary_brand_md5_v1',table:'catalog_products',expression:`md5(${canonical})`,accelerates:'md5_equality',predicate:null},
    {name:'idx_external_seeds_primary_brand_md5_v1',table:'external_product_seeds',expression:`md5(${seed})`,accelerates:'md5_equality',
      predicate:"status = 'active' AND coalesce(attached_product_key, '') <> ''"},
    // The brand-page seed scan (discoveryFeed's fetchBrandScopedExternalSeedCandidates)
    // needs equality AND prefix on the same identity, so it indexes that identity as
    // text with text_pattern_ops; the md5 index above can only answer equality.
    // No recency columns: every observed plan sorts anyway (a UNION of branches
    // cannot return index order), so they only made the index ~9x larger.
    {name:'idx_external_seeds_brand_identity_prefix_v1',table:'external_product_seeds',
      expression:seedBrandIdentitySql(),accelerates:'identity_prefix',opclass:'text_pattern_ops',predicate:BRAND_SEED_SCAN_PREDICATE},
    // The scan probes a SECOND chain (brand, snapshot.brand, domain), which the
    // retired predicate ORed in — a seed can be named by its brand AND its domain.
    {name:'idx_external_seeds_brand_domain_identity_prefix_v1',table:'external_product_seeds',
      expression:seedDomainIdentitySql(),accelerates:'identity_prefix',opclass:'text_pattern_ops',predicate:BRAND_SEED_SCAN_PREDICATE},
    // The same scan's underfill backfill matches title LIKE 'alias %'.
    {name:'idx_external_seeds_attached_title_prefix_v1',table:'external_product_seeds',
      expression:seedTitleSql(),accelerates:'title_prefix',opclass:'text_pattern_ops',predicate:BRAND_SEED_SCAN_PREDICATE},
    // The relationship graph's ref resolution (catalogEntityResolution's
    // resolveRelationshipGraphRefsToCanonicalEntities) probes each key column by equality.
    ...RELATIONSHIP_GRAPH_REF_KEY_COLUMNS.map(column=>({name:refKeyIndexName(column),table:'catalog_products',
      expression:refKeyIndexExpressionSql(column),accelerates:'ref_key_equality',predicate:null})),
    // ...and its product-group branch, which matches the ref against product_group_members.product_group_id.
    {name:PRODUCT_GROUP_REF_KEY_INDEX.name,table:PRODUCT_GROUP_REF_KEY_INDEX.table,
      expression:productGroupRefKeyIndexExpressionSql(),accelerates:'ref_key_equality',predicate:null},
    // The brand page's commerce-index lane matches catalog_products.brand lowercased and compacted.
    {name:'idx_catalog_products_canonical_brand_lower_v1',table:'catalog_products',
      expression:canonicalBrandLowerSql(),accelerates:'canonical_brand_equality',predicate:CANONICAL_BRAND_MATCH_PREDICATE},
    {name:'idx_catalog_products_canonical_brand_compact_v1',table:'catalog_products',
      expression:canonicalBrandCompactSql(),accelerates:'canonical_brand_equality',predicate:CANONICAL_BRAND_MATCH_PREDICATE},
  ].map(index=>{
    const scoped=index.table==='external_product_seeds'?'market, tool, ':'';
    const key=`(${index.expression})${index.opclass?' '+index.opclass:''}`;
    const recency=index.recency?', updated_at DESC NULLS LAST, created_at DESC NULLS LAST':'';
    return {...index,sql:`CREATE INDEX CONCURRENTLY ${index.name} ON ${index.table} (${scoped}${key}${recency})${index.predicate?' WHERE '+index.predicate:''};`};
  });
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
