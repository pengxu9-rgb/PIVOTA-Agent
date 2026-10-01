#!/usr/bin/env node
'use strict';

// Offline title-policy replay. No database, LLM, network, or write mode.
const sample = require('../tests/fixtures/relgraph_1001_recommendation_sample.json');
const oldImpact = require('../tests/fixtures/relgraph_prod_29_titles.json');
const { getRelationshipEdgeServingSuppressionReasons } = require('../src/auroraBff/productRelationshipGraph');
function snapshot(row, side) { return {brand: row[`${side}_brand`], title: row[`${side}_title`]}; }
function reasons(row) {
  return getRelationshipEdgeServingSuppressionReasons({anchor_type:'product', anchor_ref:'product:a', candidate_product_ref:'product:b',
    anchor_snapshot:snapshot(row,'anchor'), candidate_snapshot:snapshot(row,'candidate'), relation_type:row.rel || 'related_product', label_state:'ai_approved'});
}
function evaluate() {
  const results = sample.map(row=>({i:row.i,expected_kind:row.expected_kind,suppression_reasons:reasons(row)}));
  const variants = results.filter(row=>row.expected_kind==='variant');
  const retained = results.filter(row=>row.expected_kind!=='variant');
  const impact = oldImpact.map(reasons);
  return {
    schema_version:'relationship_recommendation_utility_offline.v1',sample_count:sample.length,
    expected_variants:variants.length,blocked_variants:variants.filter(row=>row.suppression_reasons.length).length,
    false_suppressions_of_retained:retained.filter(row=>row.suppression_reasons.length).length,
    retained_complement_opportunities:retained.filter(row=>row.expected_kind==='complement' && !row.suppression_reasons.length).length,
    retained_alternative_opportunities:retained.filter(row=>row.expected_kind==='alternative' && !row.suppression_reasons.length).length,
    unresolved_pairs:retained.filter(row=>row.expected_kind==='unknown').length,
    earlier_29_same_product_reason:impact.filter(reasons=>reasons.includes('related_product_same_product_across_listings_or_sizes')).length,
    earlier_29_total_suppressed:impact.filter(reasons=>reasons.length).length,
    limits:['Titles and prior rationales are truncated; this measures deterministic variant detection, not LLM approval precision.',
      'Full-run approximately 70% variant estimate is user-reported, not measured from this 30-pair sample.',
      'No claim about production serving coverage, broader catalog cross-brand yield or formula/performance equivalence.'],
    results,
  };
}
if(require.main===module)process.stdout.write(`${JSON.stringify(evaluate(),null,2)}\n`);
module.exports={evaluate};
