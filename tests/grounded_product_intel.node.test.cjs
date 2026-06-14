'use strict'
// Pure unit test for the Tier-G grounded generator (ADR-002 item 8).
// Injected fake KB — no DB, no deps. Run: node --test tests/grounded_product_intel.node.test.cjs
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { buildGroundedProductIntelBundle } = require('../src/groundedProductIntel.js')

function entry(seedSlug, grade, o) {
  const profile = {
    status: 'ready',
    ingredient: { display_name: o.name, inci: o.name, aliases: o.aliases || [], what_it_is: o.what, marketing_vs_reality: o.mvr || [] },
    overview: o.what,
    benefits: o.benefits || [],
    safety: { watchouts: o.watchouts || [] },
    usage: { routine_step: 'treatment', pair_well: o.pair || [] },
    evidence: { grade, summary: 'evidence summary', citations: o.cites || [] },
    source_meta: { tier: 'grounded', seed_slug: seedSlug },
  }
  return { status: 'ready', source_meta: { tier: 'grounded', seed_slug: seedSlug }, ingredient_profile_json: profile }
}

const FAKE = {
  niacinamide: entry('niacinamide', 'A', {
    name: 'Niacinamide', aliases: ['vitamin b3'], what: 'A form of vitamin B3.',
    mvr: [{ claim_in_market: "niacinamide 'shrinks pores'", reality: 'pore size is largely fixed; it refines the look of pores by reducing sebum', evidence_type: 'marketing_vs_reality' }],
    benefits: [
      { concern: 'uneven tone', strength: 3, what_it_means: 'evens tone', mechanism: 'inhibits melanosome transfer' },
      { concern: 'barrier support', strength: 2, what_it_means: 'supports the barrier', mechanism: 'boosts ceramide synthesis' },
    ],
    watchouts: [{ issue: 'Niacin allergy (rare)', likelihood: 'very_low', what_to_do: 'patch test' }],
    cites: [{ title: 'RCT', url: 'https://pubmed.ncbi.nlm.nih.gov/16766489/', year: 2006, source: 'PubMed' }],
    pair: ['hyaluronic acid'],
  }),
  'centella asiatica extract': entry('centella', 'C', {
    name: 'Centella asiatica', aliases: ['cica'], what: 'A soothing botanical.',
    mvr: [{ claim_in_market: "'cica heals wounds'", reality: 'cosmetic soothing-appearance, not medical wound repair', evidence_type: 'marketing_vs_reality' }],
    benefits: [
      { concern: 'barrier support', strength: 2, what_it_means: 'looks calmer', mechanism: 'triterpene saponins support barrier proteins' },
      { concern: 'redness appearance', strength: 2, what_it_means: 'reduces the look of redness', mechanism: 'antioxidant activity' },
    ],
    cites: [{ title: 'review', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9983323/', year: 2023, source: 'PMC' }],
  }),
  // non-grounded entry (tier != grounded) — MUST be ignored
  glycerin: { status: 'ready', source_meta: { tier: null }, ingredient_profile_json: { ingredient: { display_name: 'Glycerin' }, benefits: [{ concern: 'hydration', strength: 2, what_it_means: 'hydrates', mechanism: 'humectant' }], evidence: { grade: 'B', citations: [] }, safety: { watchouts: [] }, usage: {} } },
}
const kbLookup = async (term) => FAKE[term] || null

test('builds a Tier-G bundle from KB-grounded actives', async () => {
  const bundle = await buildGroundedProductIntelBundle(
    { role_label: 'Test serum', key_ingredients: ['Niacinamide'], inci: 'Niacinamide, Centella Asiatica Extract, Glycerin, Butylene Glycol, Water' },
    { kbLookup, now: '2026-06-14' },
  )
  assert.ok(bundle, 'bundle produced')
  assert.equal(bundle.contract_version, 'pivota.product_intel.v1')
  assert.equal(bundle.provenance.tier, 'grounded')
  assert.equal(bundle.provenance.reviewer_kind, 'automated_grounded')
  assert.equal(bundle.provenance.review_decision, 'grounded_pass')
  assert.notEqual(bundle.provenance.reviewer_kind, 'human')

  const core = bundle.product_intel_core
  assert.ok(core.why_it_stands_out.length >= 1, 'why_it_stands_out present')
  const claims = core.evidence_claims
  const mvr = claims.filter((c) => c.source_type === 'marketing_vs_reality')
  const graded = claims.filter((c) => c.source_type !== 'marketing_vs_reality')
  assert.ok(mvr.length >= 1, 'marketing_vs_reality honesty present')
  assert.ok(graded.length >= 1, 'graded claims present')
  // canonical ProductClaim atom shape (models/catalog.py) — matches the read side
  assert.ok(claims.every((c) => !!c.claim_text && !!c.source_type), 'claims carry claim_text + source_type')
  assert.ok(graded.every((c) => /^[ABC]$/.test(String(c.evidence_grade))), 'graded claims carry evidence_grade A/B/C')
  assert.ok(claims.every((c) => ['unverified', 'substantiated', 'flagged', 'rejected'].includes(c.substantiation_status)), 'substantiation_status valid')
  assert.ok(['observed', 'reviewed', 'flagged'].includes(core.evidence_review_state), 'review_state valid')
  assert.equal(mvr[0].substantiation_status, 'flagged', 'marketing-vs-reality myth is flagged')

  const barrier = graded.find((c) => /barrier/i.test(c.concern))
  // Single-active provenance: each claim binds to ONE driving active (no cross-active
  // splice). Convergent-merge was removed to keep source_ref honest.
  assert.ok(barrier, 'barrier-support claim present')
  assert.ok(!String(barrier.source_ref || '').includes(','), 'claim bound to a single active (no splice)')
  assert.ok(!barrier.drivers || barrier.drivers.length <= 1, 'single driver per claim')
  assert.ok(!graded.some((c) => /hydration/i.test(c.concern)), 'non-grounded KB entry (glycerin) ignored')
  assert.ok(graded.some((c) => Array.isArray(c.source_refs) && c.source_refs.length >= 1), 'graded claims carry citations')
  assert.equal(bundle.provenance.grounding.citations_present, true)
  assert.ok(core.not_fit.some((n) => /allergy/i.test(n.label)), 'allergy watchout → not_fit')

  const DRUG = /\b(treats?|cures?|heals?|healing|anti-?inflammator\w*|antibacterial|antimicrobial)\b/i
  const assertive = [core.what_it_is.headline, core.what_it_is.body, ...core.why_it_stands_out.flatMap((w) => [w.headline, w.body]), ...graded.flatMap((c) => [c.claim_text, c.mechanism])].filter(Boolean)
  assert.ok(!assertive.some((t) => DRUG.test(t)), 'no drug verbs in assertive fields')
})

test('returns null when no actives are KB-grounded', async () => {
  const bundle = await buildGroundedProductIntelBundle({ inci: 'Water, Glycerin, Fragrance' }, { kbLookup })
  assert.equal(bundle, null)
})
