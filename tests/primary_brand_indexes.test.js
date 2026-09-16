const {primaryBrandIndexDefinitions,inspectReadiness}=require('../scripts/catalog/primary_brand_indexes');
const {buildBrandIdentityPredicate,CANONICAL_OWN_BRAND_SQL}=require('../src/services/canonicalSearchQualitySql');
const {SEED_OWN_BRAND_SQL}=require('../src/services/seedSearchOfferScope');
const {seedBrandIdentitySql,seedTitleSql,BRAND_SEED_SCAN_PREDICATE}=require('../src/services/brandSeedScanSql');
// An index only accelerates an expression it matches CHARACTER FOR CHARACTER, so every definition
// must be tied back to the query that is meant to use it. `accelerates` names that query; a
// definition carrying an unknown value fails here rather than quietly matching nothing.
const ACCELERATORS={
  // buildBrandIdentityPredicate's md5 + full-equality pair.
  md5_equality(index){
    const params=[];
    const expression=index.table==='catalog_products'?CANONICAL_OWN_BRAND_SQL.replace(/\bp\./g,''):SEED_OWN_BRAND_SQL;
    const where=buildBrandIdentityPredicate({brand_key:'mac_cosmetics',brand:'MAC'},expression,params);
    expect(where).toContain(index.expression+' = ANY(');
    expect(where).toContain('AND regexp_replace(');
    expect(params[0]).toContain('mac');expect(params[1].every(v=>/^[a-f0-9]{32}$/.test(v))).toBe(true);
  },
  // discoveryFeed's brand-page seed scan: one `= ANY(identity keys)` plus one `LIKE alias%` per
  // alias, both over seedBrandIdentitySql.
  identity_prefix(index){
    expect(index.expression).toBe(seedBrandIdentitySql());
    // It is buildBrandIdentityPredicate's brand identity plus ONE documented leg: the domain as
    // brand-of-last-resort, which the predicate this scan replaced also had. Everything else must
    // still be shared, so assert the whole seed brand chain is embedded verbatim and that the only
    // addition is the domain fallback — a second normalization would put the brand lanes back into
    // disagreement about what a brand is.
    const params=[];
    const where=buildBrandIdentityPredicate({brand_key:'mac_cosmetics',brand:'MAC'},SEED_OWN_BRAND_SQL,params);
    expect(where).toContain(SEED_OWN_BRAND_SQL);
    expect(index.expression).toContain(SEED_OWN_BRAND_SQL);
    expect(index.expression).toContain("split_part(domain, '.', 1)");
    expect(index.expression.replace(`coalesce(nullif(${SEED_OWN_BRAND_SQL}, ''), split_part(domain, '.', 1), '')`,SEED_OWN_BRAND_SQL))
      .toBe(where.slice(where.lastIndexOf('AND ')+4,where.lastIndexOf(' = ANY(')));
    expect(index.opclass).toBe('text_pattern_ops');
  },
  // The same scan's underfill backfill: one `LIKE 'alias %'` per alias over seedTitleSql.
  title_prefix(index){
    expect(index.expression).toBe(seedTitleSql());
    expect(index.opclass).toBe('text_pattern_ops');
  },
};
test.each(primaryBrandIndexDefinitions())('index $name is bounded and exactly matches the query accelerator',index=>{
  expect(Object.keys(ACCELERATORS)).toContain(index.accelerates);
  ACCELERATORS[index.accelerates](index);
  expect(index.sql).toContain('CREATE INDEX CONCURRENTLY');
  expect(index.sql).not.toContain('IF NOT EXISTS');
  // A partial index is only usable when the query's own predicate implies it, so both sides must be
  // the one shared string rather than two spellings of the same idea.
  if(index.table==='external_product_seeds') expect(index.predicate).toBe(BRAND_SEED_SCAN_PREDICATE);
  // The prefix indexes also serve the scan's ORDER BY, which trails the key.
  if(index.recency) expect(index.sql).toContain('updated_at DESC NULLS LAST, created_at DESC NULLS LAST');
});
test('the brand-page seed scan reads its expressions from the same module the indexes do',()=>{
  // Cheap drift alarm next to the definitions. The proof that the planner can actually use them is
  // tests/integration/discovery_brand_seed_scan_postgres.test.js, which EXPLAINs the fetcher's own
  // statements against real PostgreSQL.
  const source=require('fs').readFileSync(require.resolve('../src/services/discoveryFeed'),'utf8');
  const start=source.indexOf('async function fetchBrandScopedExternalSeedCandidates(');
  expect(start).toBeGreaterThan(-1);
  const body=source.slice(start,source.indexOf('\nasync function ',start+1));
  expect(body).toContain("seedBrandIdentitySql('eps')");
  expect(body).toContain("seedTitleSql('eps')");
  expect(body).toContain('BRAND_SEED_SCAN_PREDICATE');
  // Not asserted here: that the STATEMENT carries no `LIKE ANY(array)` / `unnest` — a source grep
  // cannot tell code from the comment that explains why they were removed. That claim is made
  // against the SQL the fetcher actually builds, in the integration test named above.
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
