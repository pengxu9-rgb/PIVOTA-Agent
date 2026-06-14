'use strict'
/*
 * Grounded product-intel generator — Tier-G, ADR-002 item 8.
 *
 * Deterministically assembles a product_intel.v1 bundle from verified INCI ×
 * the reviewed Ingredient KB (aurora_ingredient_research_kb) × per-claim
 * grading, stamping provenance.tier='grounded'. NO LLM: pure aggregation over
 * KB facts, so it is reproducible and trustworthy by construction.
 *
 * Returns null when there is no KB grounding (→ not Tier-G; the caller falls
 * back to the existing seller/human paths). The bundle carries provenance the
 * tiered gate (item 9) recognizes as `grounded`.
 *
 * kbLookup(term, lang) is injectable for testing; defaults to the real store.
 */

const GRADE_TO_EVIDENCE = { A: 'clinical', B: 'peer_reviewed_mechanism', C: 'ingredient_function', D: 'ingredient_function' }
const EVIDENCE_RANK = { clinical: 4, peer_reviewed_mechanism: 3, ingredient_function: 2, traditional_use: 1, marketing_vs_reality: 0 }
const CONF_BY_STRENGTH = { 3: 'high', 2: 'moderate', 1: 'low', 0: 'low' }
const CONF_RANK = { high: 3, moderate: 2, low: 1 }

function asObj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null }
function asArr(v) { return Array.isArray(v) ? v : [] }
function str(v) { return v == null ? '' : String(v) }
function slug(s) { return str(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) }

// keep in sync with ingredientResearchKbStore.normalizeQueryText (key parity)
function normalizeTerm(v) {
  const raw = str(v).trim().toLowerCase()
  if (!raw) return ''
  return raw.replace(/[^\p{L}\p{N}\s+\-/,().]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
}

const DRUG_RE = /\b(treats?|cures?|cured|heals?|healing|anti-?inflammator\w*|antibacterial|antimicrobial|antifungal|wound[- ]?heal\w*)\b/i
function claimSafe(text) { return !DRUG_RE.test(str(text)) }

function extractActiveTerms(product) {
  const terms = []
  const push = (v) => { const t = normalizeTerm(v); if (t && t.length >= 3) terms.push(t) }
  for (const l of [product.key_ingredients, product.keyIngredients, product.hero_ingredients, product.heroIngredients]) {
    asArr(l).forEach(push)
  }
  const inci = product.inci || product.ingredients_inci || product.ingredientsInci || product.ingredient_list || product.ingredients
  if (typeof inci === 'string') inci.split(/[,;\n]/).forEach(push)
  else if (Array.isArray(inci)) inci.forEach(push)
  return [...new Set(terms)]
}

async function defaultKbLookup(term, lang) {
  const { getIngredientResearchKbEntry } = require('./auroraBff/ingredientResearchKbStore')
  return getIngredientResearchKbEntry({ query: term, lang: lang || 'EN', layer: 'generic' })
}

async function collectActives(product, kbLookup, lang) {
  const bySlug = new Map()
  for (const term of extractActiveTerms(product)) {
    let entry = null
    try { entry = await kbLookup(term, lang) } catch { entry = null }
    if (!entry) continue
    const profile = asObj(entry.ingredient_profile_json) || asObj(entry)
    if (!profile) continue
    if (str(entry.status || profile.status) !== 'ready') continue
    const ing = asObj(profile.ingredient) || {}
    const sm = asObj(entry.source_meta) || asObj(profile.source_meta) || {}
    if (str(sm.tier) !== 'grounded') continue // only grounded KB entries feed a grounded bundle
    const key = str(sm.seed_slug) || slug(ing.display_name || ing.inci || term)
    if (bySlug.has(key)) continue // first term wins per active
    bySlug.set(key, { term, profile, ing, slug: key })
  }
  return [...bySlug.values()]
}

function gradeOf(a) { return (str(a.profile && a.profile.evidence && a.profile.evidence.grade).toUpperCase()) || 'C' }
function evidenceOf(a) { return GRADE_TO_EVIDENCE[gradeOf(a)] || 'ingredient_function' }
function topBenefit(a) { return asArr(a.profile.benefits).slice().sort((x, y) => (y.strength || 0) - (x.strength || 0))[0] || null }

function rankActives(actives) {
  return [...actives].sort((a, b) => {
    const am = asArr(a.ing.marketing_vs_reality).length ? 1 : 0
    const bm = asArr(b.ing.marketing_vs_reality).length ? 1 : 0
    if (am !== bm) return bm - am
    const ag = EVIDENCE_RANK[evidenceOf(a)] || 0
    const bg = EVIDENCE_RANK[evidenceOf(b)] || 0
    if (ag !== bg) return bg - ag
    const at = Math.max(0, ...asArr(a.profile.benefits).map((x) => x.strength || 0))
    const bt = Math.max(0, ...asArr(b.profile.benefits).map((x) => x.strength || 0))
    return bt - at
  })
}

function buildWhatItIs(product, ranked) {
  const names = ranked.map((a) => str(a.ing.display_name || a.term)).filter(Boolean)
  const roleLabel = str(product.role_label || product.category || 'Skincare formula')
  const hero = ranked[0]
  const heroMvr = hero && asArr(hero.ing.marketing_vs_reality)[0]
  let body = `Grounded analysis of the verified formula. Active drivers: ${names.slice(0, 4).join(', ')}.`
  if (heroMvr && claimSafe(heroMvr.reality)) body += ` ${str(heroMvr.reality).slice(0, 200)}`
  return { headline: names.length ? `${roleLabel} — ${names[0]} forward` : roleLabel, body: body.slice(0, 320) }
}

function buildWhy(ranked) {
  const out = []
  for (const a of ranked.slice(0, 4)) {
    const top = topBenefit(a)
    if (!top) continue
    const headline = str(a.ing.display_name || a.term)
    const body = [str(top.what_it_means), str(top.mechanism)].filter(Boolean).join(' ')
    if (!body || !claimSafe(`${headline} ${body}`)) continue
    out.push({ headline, body: body.slice(0, 300), evidence_strength: evidenceOf(a) })
  }
  return out
}

function buildEvidenceClaims(ranked) {
  // graded claims merged by concern (convergent support → one claim, many drivers)
  const graded = new Map()
  const mvr = []
  for (const a of ranked) {
    const grade = gradeOf(a)
    const etype = GRADE_TO_EVIDENCE[grade] || 'ingredient_function'
    const cites = asArr(a.profile.evidence && a.profile.evidence.citations).map((c) => str(c.url)).filter(Boolean)
    const driver = str(a.ing.display_name || a.term)
    for (const b of asArr(a.profile.benefits)) {
      const concern = str(b.concern)
      if (!concern || !claimSafe(`${b.what_it_means} ${b.mechanism}`)) continue
      let conf = CONF_BY_STRENGTH[b.strength == null ? 1 : b.strength] || 'low'
      if (grade === 'C' && conf === 'high') conf = 'moderate'
      const tag = slug(concern)
      const prev = graded.get(tag)
      if (!prev) {
        graded.set(tag, { claim: concern, drivers: [driver], mechanism: str(b.mechanism).slice(0, 240), evidence_type: etype, confidence: conf, source_refs: cites.slice(0, 3) })
      } else {
        if (!prev.drivers.includes(driver)) prev.drivers.push(driver)
        if ((CONF_RANK[conf] || 0) > (CONF_RANK[prev.confidence] || 0)) prev.confidence = conf
        if ((EVIDENCE_RANK[etype] || 0) > (EVIDENCE_RANK[prev.evidence_type] || 0)) {
          prev.evidence_type = etype
          if (str(b.mechanism)) prev.mechanism = str(b.mechanism).slice(0, 240)
        }
        for (const u of cites) if (prev.source_refs.length < 4 && !prev.source_refs.includes(u)) prev.source_refs.push(u)
      }
    }
    for (const m of asArr(a.ing.marketing_vs_reality)) {
      const finding = str(m.reality || m.finding)
      const claim = str(m.claim_in_market || m.claim)
      if (!finding || !claim) continue
      mvr.push({ claim, drivers: [driver], evidence_type: 'marketing_vs_reality', confidence: 'high', finding: finding.slice(0, 260) })
    }
  }
  const gradedArr = [...graded.values()].sort((x, y) => (CONF_RANK[y.confidence] || 0) - (CONF_RANK[x.confidence] || 0)).slice(0, 10)
  return [...gradedArr, ...mvr.slice(0, 5)]
}

function buildBestFor(ranked) {
  const byTag = new Map()
  for (const a of ranked) {
    for (const b of asArr(a.profile.benefits)) {
      const label = str(b.concern)
      if (!label) continue
      const tag = slug(label)
      const conf = CONF_BY_STRENGTH[b.strength == null ? 1 : b.strength] || 'low'
      const prev = byTag.get(tag)
      if (!prev || (CONF_RANK[conf] || 0) > (CONF_RANK[prev.confidence] || 0)) byTag.set(tag, { tag, label, confidence: conf })
    }
  }
  return [...byTag.values()].slice(0, 6)
}

function buildWatchoutsAndNotFit(ranked) {
  const watchouts = []
  const notFit = []
  const seen = new Set()
  for (const a of ranked) {
    for (const w of asArr(a.profile.safety && a.profile.safety.watchouts)) {
      const label = str(w.issue)
      if (!label) continue
      const k = slug(label)
      if (seen.has(k)) continue
      seen.add(k)
      const sev = /allerg|pregnan|photosens/i.test(label) ? 'moderate' : 'mild'
      const row = { type: 'safety', label, severity: sev }
      const wtd = str(w.what_to_do)
      if (wtd) row.what_to_do = wtd.slice(0, 200)
      watchouts.push(row)
      if (/allerg|pregnan/i.test(label)) notFit.push({ tag: k, label })
    }
  }
  return { watchouts: watchouts.slice(0, 6), notFit: notFit.slice(0, 4) }
}

function buildRoutineFit(ranked) {
  const usage = asObj(ranked[0] && ranked[0].profile.usage) || {}
  return {
    step: str(usage.routine_step) || 'treatment',
    am_pm: 'either',
    pairing_notes: asArr(usage.pair_well).map(str).filter(Boolean).slice(0, 4),
  }
}

function buildConfidence(ranked) {
  const grades = ranked.map(gradeOf)
  const best = grades.includes('A') ? 'high' : grades.includes('B') ? 'moderate' : 'low'
  return { overall: 'grounded', fields: { why_it_stands_out: best, evidence_claims: 'graded_per_claim', best_for: best } }
}

async function buildGroundedProductIntelBundle(product, opts = {}) {
  const lang = opts.lang || 'EN'
  const kbLookup = opts.kbLookup || ((t, l) => defaultKbLookup(t, l))
  const p = asObj(product) || {}
  const actives = await collectActives(p, kbLookup, lang)
  if (!actives.length) return null
  const ranked = rankActives(actives)
  const why = buildWhy(ranked)
  if (!why.length) return null

  const { watchouts, notFit } = buildWatchoutsAndNotFit(ranked)
  const allCites = ranked.flatMap((a) => asArr(a.profile.evidence && a.profile.evidence.citations).map((c) => str(c.url)).filter(Boolean))
  const generatedAt = opts.now || new Date().toISOString().slice(0, 10)
  const freshness = { generated_at: generatedAt, source_version: 'grounded_synthesis:v1' }

  const core = {
    display_name: 'Pivota Insights',
    what_it_is: buildWhatItIs(p, ranked),
    best_for: buildBestFor(ranked),
    not_fit: notFit,
    why_it_stands_out: why,
    evidence_claims: buildEvidenceClaims(ranked),
    routine_fit: buildRoutineFit(ranked),
    watchouts,
    confidence: buildConfidence(ranked),
    freshness,
    quality_state: 'eligible',
    evidence_profile: 'grounded_verified',
  }

  const provenance = {
    source: 'pivota_grounded_synthesis_v1',
    tier: 'grounded',
    review_tier: 'grounded',
    reviewer_kind: 'automated_grounded',
    review_status: 'completed',
    review_decision: 'grounded_pass',
    generator: 'pivota_grounded_v1',
    field_sources: {
      ingredients: 'ingredient_kb',
      why_it_stands_out: 'ingredient_mechanism+citation',
      evidence_claims: 'ingredient_mechanism_graded',
    },
    grounding: {
      inci_verified: true,
      citations_present: allCites.length > 0,
      claim_safety: 'cosmetic_screened',
      active_slugs: ranked.map((a) => a.slug),
    },
  }

  return {
    contract_version: 'pivota.product_intel.v1',
    display_name: 'Pivota Insights',
    canonical_product_ref: opts.canonicalProductRef || null,
    product_group_id: opts.productGroupId || null,
    product_intel_core: core,
    provenance,
    freshness,
    evidence_profile: 'grounded_verified',
    quality_state: 'eligible',
  }
}

module.exports = {
  buildGroundedProductIntelBundle,
  extractActiveTerms,
  _internal: { collectActives, buildEvidenceClaims, normalizeTerm, claimSafe, rankActives },
}
