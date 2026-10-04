// Independent 2026-10-04 adversary invariants, ported unchanged to this Jest suite.
const assert = require('node:assert/strict');
const {buildStructuredPdpIngredientModules: build} = require('../../src/services/pdpIngredientAuthority');
const fixture = require('../fixtures/ingredients/then_i_met_you_live_20261004.json');
test('exact SSR and gateway recover all 57 ingredients including final LINALOOL', () => {
  for (const capture of fixture.captures) assert.deepEqual(build({ingredients_inci:capture.ingredients_inci}).ingredientsInciData.items, fixture.expected_items);
});
test('raw-less polluted array must be withheld rather than silently discard Linalool', () => {
  assert.equal(build({ingredients_inci:['Water','Glycerin','Propanediol','Use daily','Linalool']}).ingredientsInciData,null);
});
test('polluted stored authority must be withheld rather than silently discard Linalool', () => {
  const items=['Water','Glycerin','Propanediol','Use daily','Linalool'];
  assert.equal(build({ingredient_intel:{authoritative:{items,raw_text:items.join(', '),purity_status:'authoritative',source_origin:'kb_reviewed'}}}).ingredientsInciData,null);
});
test('rejecting stored authority must not revive its unsupported Retinol active', () => {
  const items=['Water','Glycerin','Your evening routine','Linalool'];
  const modules=build({ingredient_intel:{authoritative:{items,raw_text:items.join(', '),active_items:['Retinol'],purity_status:'authoritative',source_origin:'pdp_section'}}});
  assert.equal(modules.ingredientsInciData,null);
  assert.equal(modules.activeIngredientsData,null);
});
test('structured arrays preserve boundaries across numeric chemical tokens', () => {
  const items=['Water','Glycerin','CI 77491','1,2-Hexanediol','Linalool'];
  assert.deepEqual(build({ingredients_inci:items}).ingredientsInciData.items,items);
});
test('reviewed partial structured ingredients retain not-full-INCI scope', () => {
  const modules=build({ingredients_inci:['Ceramides','Panthenol','Niacinamide'],pdp_field_quality_summary:{ingredients_raw:{source_quality_status:'reviewed_key_ingredients_partial_not_full_inci',authority_scope:'reviewed_key_ingredients_not_full_inci'}}});
  assert.equal(modules.ingredientsInciData.authority_scope,'reviewed_key_ingredients_not_full_inci');
});

test('public builder cannot revive an authority-rejected nonexternal ingredient list', () => {
  const { buildPdpPayload } = require('../../src/pdpBuilder');
  const payload = buildPdpPayload({ product: { product_id:'p_clean_boundary', merchant_id:'merch_test', title:'Moisturizing Face Cream', category:'Beauty', price:12, currency:'USD', ingredients_inci:['Water','Glycerin','Your daily routine','Panthenol'] } });
  assert.equal(payload.modules.some(m=>m.type==='ingredients_inci'), false);
});
test('partial quality from an unrelated explicit source does not attach to structured field', () => {
  const modules=build({ingredients_inci:{items:['Ceramides','Panthenol','Niacinamide'],source_url:'https://merchant.example/current'},pdp_field_quality_summary:{ingredients_raw:{source_url:'https://other.example/old',source_quality_status:'reviewed_key_ingredients_partial_not_full_inci',authority_scope:'reviewed_key_ingredients_not_full_inci'}}});
  assert.equal(modules.ingredientsInciData.authority_scope,undefined);
});

test('rejected authority cannot revive an unreviewed mirrored active array',()=>{
 const modules=build({active_ingredients:['Retinol'],ingredient_intel:{authoritative:{items:['Water','Glycerin','Your evening routine','Linalool'],raw_text:'Water, Glycerin, Your evening routine, Linalool',active_items:['Retinol'],source_origin:'pdp_section',purity_status:'authoritative'}}});
 assert.equal(modules.activeIngredientsData,null);
});
test('short clean stored INCI does not corroborate an absent active',()=>{
 const modules=build({ingredient_intel:{authoritative:{items:['Squalane','Tocopherol'],raw_text:'Squalane, Tocopherol',active_items:['Retinol'],source_origin:'pdp_section',purity_status:'authoritative'}}});
 assert.equal(modules.activeIngredientsData,null);
});
test('arbitrary stored words are not chemical evidence',()=>{
 const modules=build({ingredient_intel:{authoritative:{items:['Hello','Beautiful','Skin'],raw_text:'Hello, Beautiful, Skin',purity_status:'authoritative'}}});
 assert.equal(modules.ingredientsInciData,null);
});

test('two-item reviewed structured partial remains partial, equivalent to raw form',()=>{
 const quality={ingredients_raw:{source_quality_status:'reviewed_key_ingredients_partial_not_full_inci',authority_scope:'reviewed_key_ingredients_not_full_inci'}};
 for(const inputs of [{ingredients_inci:['Ceramides','Panthenol']},{pdp_ingredients_raw:'Ceramides, Panthenol'}]){
  const module=build({...inputs,pdp_field_quality_summary:quality}).ingredientsInciData;
  assert.equal(module.authority_scope,'reviewed_key_ingredients_not_full_inci');
  assert.equal(module.title,'Key ingredients (partial)');
 }
});

test.each(['Coumarin','Ectoin','Asiaticoside','Phytosphingosine','Squalane','Linalool'])('a later standalone %s cannot be discarded after a structured usage heading', ingredient=>{
 const modules=build({ingredients_inci:['Water','Glycerin','Propanediol','How to Use',ingredient]});
 assert.equal(modules.ingredientsInciData,null);
});

test('same-source explicitly approved short full formula is retained without a legacy bypass',()=>{
 const inputs={ingredients_inci:['Squalane','Tocopherol'],pdp_ingredients_raw:'Squalane, Tocopherol',pdp_field_quality_summary:{ingredients_raw:{source_origin:'official_html',source_quality_status:'high',review_state:'approved'}}};
 assert.deepEqual(build(inputs).ingredientsInciData.items,inputs.ingredients_inci);
 for(const review_state of ['not approved','unreviewed','pending','rejected'])assert.equal(build({...inputs,pdp_field_quality_summary:{ingredients_raw:{...inputs.pdp_field_quality_summary.ingredients_raw,review_state}}}).ingredientsInciData,null);
 assert.equal(build({...inputs,pdp_ingredients_raw:'Squalane, Retinol'}).ingredientsInciData,null);
 assert.equal(build({...inputs,source_url:'https://merchant.example/a',pdp_field_quality_summary:{ingredients_raw:{...inputs.pdp_field_quality_summary.ingredients_raw,source_url:'https://other.example/b'}}}).ingredientsInciData,null);
});
