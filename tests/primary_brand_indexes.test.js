const {primaryBrandIndexDefinitions,inspectReadiness}=require('../scripts/catalog/primary_brand_indexes');
const {buildBrandIdentityPredicate,CANONICAL_OWN_BRAND_SQL}=require('../src/services/canonicalSearchQualitySql');
const {SEED_OWN_BRAND_SQL}=require('../src/services/seedSearchOfferScope');
const {seedBrandIdentitySql,seedDomainIdentitySql,seedTitleSql,BRAND_SEED_SCAN_PREDICATE,IDENTITY_MAX_CHARS}=require('../src/services/brandSeedScanSql');
const {RELATIONSHIP_GRAPH_REF_KEY_COLUMNS,REF_KEY_PREFIX_CHARS,refKeyIndexExpressionSql,refKeyIndexName,refKeyMatchSql}=require('../src/services/relationshipGraphRefKeySql');
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
    // The scan probes TWO chains, so each definition must be exactly one of them — byte-identical to
    // the module the query reads, or the index accelerates nothing.
    const chains={idx_external_seeds_brand_identity_prefix_v1:seedBrandIdentitySql(),
      idx_external_seeds_brand_domain_identity_prefix_v1:seedDomainIdentitySql()};
    expect(Object.keys(chains)).toContain(index.name);
    expect(index.expression).toBe(chains[index.name]);
    // Same normalization as buildBrandIdentityPredicate's identity — a second normalization would
    // put the brand lanes back into disagreement about what a brand is. Only the field chain and the
    // length bound differ, both deliberately, so compare the normalization with the chain masked out.
    const params=[];
    const where=buildBrandIdentityPredicate({brand_key:'mac_cosmetics',brand:'MAC'},SEED_OWN_BRAND_SQL,params);
    const sharedIdentity=where.slice(where.lastIndexOf('AND ')+4,where.lastIndexOf(' = ANY('));
    const maskChain=(sql)=>sql.replace(/coalesce\([^]*?, ''\), '\[·•\]'/,"<CHAIN>, '[·•]'");
    expect(maskChain(index.expression)).toBe(`left(${maskChain(sharedIdentity)}, ${IDENTITY_MAX_CHARS})`);
    // A btree key must fit 2704 bytes or writes to the table start failing, so the expression is
    // bounded (#2204's sibling index hashes instead, which cannot serve prefixes).
    expect(index.expression.startsWith('left(')).toBe(true);
    expect(index.expression.endsWith(`, ${IDENTITY_MAX_CHARS})`)).toBe(true);
    expect(index.opclass).toBe('text_pattern_ops');
  },
  // The same scan's underfill backfill: one `LIKE 'alias %'` per alias over seedTitleSql.
  title_prefix(index){
    expect(index.expression).toBe(seedTitleSql());
    expect(index.opclass).toBe('text_pattern_ops');
  },
  // The relationship graph ref resolution: one equality branch per key column, probing the bounded
  // prefix and rechecking the full value.
  ref_key_equality(index){
    const column=RELATIONSHIP_GRAPH_REF_KEY_COLUMNS.find(c=>refKeyIndexName(c)===index.name);
    expect(column).toBeTruthy();
    expect(index.table).toBe('catalog_products');
    expect(index.expression).toBe(refKeyIndexExpressionSql(column));
    expect(index.expression).toBe(`left(lower(${column}), ${REF_KEY_PREFIX_CHARS})`);
    const match=refKeyMatchSql(column,'cp_key','i.ref_key');
    expect(match).toBe(`left(lower(cp_key.${column}), ${REF_KEY_PREFIX_CHARS}) = left(i.ref_key, ${REF_KEY_PREFIX_CHARS}) AND lower(cp_key.${column}) = i.ref_key`);
    expect(index.opclass).toBeUndefined();
    expect(index.predicate).toBeNull();
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
  // No recency columns: a UNION of branches cannot return index order, so every plan sorts anyway
  // and the extra columns only inflated the index.
  expect(index.sql).not.toContain('updated_at DESC');
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
  // Both brand chains must be probed: dropping the domain one silently moves seeds named only by
  // their domain off that brand's page.
  expect(body).toContain("seedDomainIdentitySql('eps')");
  expect(body).toContain("seedTitleSql('eps')");
  expect(body).toContain("brandSeedScanPredicateSql('eps')");
  // Every bound LIKE pattern goes through the escaper; an unescaped '%' in an alias ("100% PURE")
  // both widens the match and defeats the index prefix scan.
  expect(body).not.toMatch(/LIKE \$\{[a-zA-Z]+Bind\}?\(`/);
  expect(body.match(/likePrefixPattern\(/g) || []).toHaveLength(2);
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
test('every relationship graph ref key column has exactly one index, and the resolver probes each',()=>{
  const names=primaryBrandIndexDefinitions().filter(i=>i.accelerates==='ref_key_equality').map(i=>i.name);
  expect(names).toEqual(RELATIONSHIP_GRAPH_REF_KEY_COLUMNS.map(refKeyIndexName));
  const source=require('fs').readFileSync(require.resolve('../src/services/catalogEntityResolution'),'utf8');
  expect(source).toContain("refKeyMatchSql(column, 'cp_key', 'i.ref_key')");
  expect(source).not.toMatch(/OR lower\(cp\.(source_product_id|product_key|pivota_signature_id|canonical_url|pivota_canonical_url)\) = i\.ref_key/);
});
