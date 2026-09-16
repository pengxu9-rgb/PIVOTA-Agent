const { fetchCanonicalChainRows } = require('../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');

async function statement(rawQuery) {
  const contract=buildSearchQualityContract({rawQuery});
  let result;
  await fetchCanonicalChainRows({query:rawQuery,searchQualityContract:contract,brandFilter:contract.hard_constraints.brand,
    categoryPathPrefix:contract.hard_constraints.category_path_prefix,categoryMode:'category_browse',
    deps:{query:async(sql,params)=>{result={sql,params};return {rows:[]};}}});
  return result;
}

test('brand-only main SQL has no framing phrase requirement or seed brand rescue',async()=>{
  const {sql,params}=await statement('Stila Cosmetics products');
  expect(sql).toContain("LIKE 'beauty/%'");
  expect(sql).toContain("IN ('', 'beauty')");
  expect(params).toContainEqual(expect.arrayContaining(['stilacosmetics','stila']));
  expect(sql).not.toContain('eps_brand');
});
test.each(['Stila Stay All Day Liquid Lipstick','M·A·C MACximal Silky Matte Lipstick'])(
  'exact-line main SQL binds all own-name anchor tokens before candidate LIMIT: %s',async(q)=>{
    const {sql,params}=await statement(q);
    const beforeLimit=sql.slice(0,sql.indexOf('LIMIT $3'));
    expect(beforeLimit).toMatch(/p\.title, p\.product_type, p\.product_payload->>'canonical_title'/);
    expect(params).toContain('(^| )lipstick($| )');
    expect(params).toContain(q.startsWith('Stila')?'(^| )stay($| )':'(^| )macximal($| )');
    expect(beforeLimit.slice(beforeLimit.indexOf('WHERE'))).not.toContain('p.description');
});
test('category main SQL includes shallow ancestors only alongside own product-form evidence',async()=>{
  const {sql,params}=await statement('romand lip tint');
  expect(params).toContainEqual(['beauty','beauty/makeup']);
  expect(params).toContainEqual(expect.arrayContaining(['romand','romnd']));
  expect(params).toContain('(^| )((lip[ ]*)?tints?)($| )');
  expect(sql).toMatch(/p\.category_path = ANY\(\$\d+::text\[\]\) AND .*p\.title/);
});
test.each(['dry lips','chapstick','唇膏'])(
  'a lip query no FORM_RULE matches still admits depth-2 rows by own-name lip evidence: %s',async(q)=>{
    const {sql,params}=await statement(q);
    expect(params).toContainEqual(['beauty','beauty/makeup']);
    expect(params.some((p)=>typeof p==='string'&&p.includes('lips?|lipsticks?')&&p.includes('gloss(?:es)?'))).toBe(true);
    expect(sql).toMatch(/p\.category_path = ANY\(\$\d+::text\[\]\) AND /);
});
test('the lip ancestor form admits CJK, chapstick and rouge titles, and not a foundation',async()=>{
  // Behaviour, not substrings: run the bound pattern the way Postgres does, over titles
  // normalised the way identitySql normalises them (non-alnum -> one space). Verified
  // against Postgres 15.15 for the CJK case: `[^ ]*唇[^ ]*` is what lets 润唇膏 match.
  const {params}=await statement('dry lips');
  const form=params.find((p)=>typeof p==='string'&&p.includes('chapsticks?'));
  expect(form).toBeDefined();
  const re=new RegExp(form);
  const norm=(t)=>t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  for (const t of ['润唇膏','Chapstick Classic','Rouge Allure Velvet','Gloss Drip']) expect(re.test(norm(t))).toBe(true);
  for (const t of ['Soft Matte Foundation','Eclipse Cushion']) expect(re.test(norm(t))).toBe(false);
});
