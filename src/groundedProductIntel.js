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

// Trailing INCI form-words. Botanical INCI names ("Centella Asiatica Leaf
// Water", "Glycine Soja Seed Extract") carry these as suffixes; the curated KB
// is keyed by the active core ("centella asiatica extract"), so we generate a
// stripped core + a "<core> extract" variant as extra lookup candidates.
const INCI_FORM_WORDS = new Set([
  'water', 'extract', 'leaf', 'seed', 'root', 'flower', 'fruit', 'bark', 'peel', 'stem', 'oil',
  'powder', 'ferment', 'filtrate', 'juice', 'sap', 'callus', 'culture', 'cell', 'meristem', 'butter', 'wax',
])

// One ingredient token (already paren-stripped + split out) -> normalized
// KB-query candidates. Adds a form-word-stripped botanical core and its
// "<core> extract" form so suffixed INCI names still resolve to curated KB keys.
function addTermVariants(token, out) {
  const t = normalizeTerm(token)
  if (!t || t.length < 3) return
  out.push(t)
  const words = t.split(' ').filter(Boolean)
  let end = words.length
  while (end > 1 && INCI_FORM_WORDS.has(words[end - 1])) end--
  if (end >= 1 && end < words.length) {
    const core = words.slice(0, end).join(' ')
    if (core.length >= 3) { out.push(core); out.push(`${core} extract`) }
  }
}

// INCI-name container fields, in priority order (cleanest actives first so the
// MAX_LOOKUP_TERMS cap keeps the real ones). Used to descend into objects like
// ingredient_intel / ingredients_inci that wrap the list under varying keys.
const INGREDIENT_CONTAINER_FIELDS = ['active_items', 'items', 'list', 'ingredients', 'inci_list', 'inciList', 'raw_text', 'rawText', 'inci']

// Pull normalized active candidates from any ingredient value, whatever its
// shape: a raw INCI string, an array, a leaf record ({name|inci|display_name}),
// or a container object (ingredient_intel / ingredients_inci = {raw_text,items}).
// Strips parenthetical noise ("(389,929ppm)") BEFORE splitting so the comma
// inside it doesn't shatter the name.
function pushIngredientValue(v, out, depth = 0) {
  if (v == null || depth > 5) return
  if (typeof v === 'string') {
    v.replace(/\([^)]*\)/g, ' ').split(/[,;\n]/).forEach((tok) => addTermVariants(tok, out))
    return
  }
  if (Array.isArray(v)) { for (const x of v) pushIngredientValue(x, out, depth + 1); return }
  if (typeof v === 'object') {
    let descended = false
    for (const f of INGREDIENT_CONTAINER_FIELDS) {
      if (v[f] != null) { pushIngredientValue(v[f], out, depth + 1); descended = true }
    }
    if (descended) return
    const name = v.name || v.inci_name || v.inciName || v.display_name || v.displayName ||
      v.ingredient || v.value || v.text || v.label
    if (name) pushIngredientValue(name, out, depth + 1)
  }
}

// Pull active candidates from however the PDP carries ingredients: explicit
// key/hero lists, the authoritative ingredient_intel view (active_items / items
// / raw_text — what hydrateProductWithReviewedIngredientAuthority populates),
// and any raw INCI string/array/object.
function extractActiveTerms(product) {
  const out = []
  pushIngredientValue(product.key_ingredients, out)
  pushIngredientValue(product.keyIngredients, out)
  pushIngredientValue(product.hero_ingredients, out)
  pushIngredientValue(product.heroIngredients, out)
  pushIngredientValue(asObj(product.ingredient_intel) || asObj(product.ingredientIntel), out)
  pushIngredientValue(product.inci, out)
  pushIngredientValue(product.ingredients_inci || product.ingredientsInci, out)
  pushIngredientValue(product.ingredient_list, out)
  pushIngredientValue(product.ingredients, out)
  return [...new Set(out)]
}

// Bound the term list so the batched IN-list stays sane for pathological INCI.
const MAX_LOOKUP_TERMS = 64

// BATCHED default lookup: one `WHERE kb_key = ANY($1)` round-trip for all terms,
// not N serial point-reads (the load-check finding). Returns Map<term, entry>.
async function defaultKbLookupBatch(terms, lang) {
  const { getIngredientResearchKbEntries } = require('./auroraBff/ingredientResearchKbStore')
  return getIngredientResearchKbEntries({ queries: terms, lang: lang || 'EN', layer: 'generic' })
}

function readBatchResult(resultMap, term) {
  if (!resultMap) return null
  if (typeof resultMap.get === 'function') return resultMap.get(term) || null
  return resultMap[term] || null
}

async function collectActives(product, kbLookupBatch, lang) {
  const terms = extractActiveTerms(product).slice(0, MAX_LOOKUP_TERMS)
  if (!terms.length) return []
  let resultMap = null
  try { resultMap = await kbLookupBatch(terms, lang) } catch { resultMap = null }
  const bySlug = new Map()
  for (const term of terms) {
    const entry = readBatchResult(resultMap, term)
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

// Emits canonical ProductClaim atoms (models/catalog.py) so the produce side
// matches the read side (pdpReviewedIngredientAuthority.evidence_profile.claims):
//   { claim_text, source_ref, source_type, evidence_grade, substantiation_status }
// Pivota grounded extras (drivers, mechanism, confidence, source_refs, concern,
// finding) are ADDITIVE — strict ProductClaim consumers ignore them.
const GRADE_RANK = { A: 3, B: 2, C: 1, D: 0 }
function buildEvidenceClaims(ranked) {
  const graded = new Map() // merged by concern (convergent support → one claim, many drivers)
  const mvr = []
  for (const a of ranked) {
    const grade = gradeOf(a)
    const cites = asArr(a.profile.evidence && a.profile.evidence.citations).map((c) => str(c.url)).filter(Boolean)
    const driver = str(a.ing.display_name || a.term)
    for (const b of asArr(a.profile.benefits)) {
      const concern = str(b.concern)
      const claimText = str(b.what_it_means) || concern
      if (!concern || !claimSafe(`${b.what_it_means} ${b.mechanism}`)) continue
      let conf = CONF_BY_STRENGTH[b.strength == null ? 1 : b.strength] || 'low'
      if (grade === 'C' && conf === 'high') conf = 'moderate'
      const substantiated = cites.length > 0 || grade === 'A' || grade === 'B'
      const tag = slug(concern)
      const prev = graded.get(tag)
      if (!prev) {
        graded.set(tag, {
          claim_text: claimText,
          source_ref: driver,
          source_type: 'ingredient_mechanism',
          evidence_grade: grade,
          substantiation_status: substantiated ? 'substantiated' : 'unverified',
          concern,
          drivers: [driver],
          mechanism: str(b.mechanism).slice(0, 240) || undefined,
          confidence: conf,
          source_refs: cites.slice(0, 3),
        })
      } else {
        if (!prev.drivers.includes(driver)) { prev.drivers.push(driver); prev.source_ref = prev.drivers.join(', ') }
        if ((CONF_RANK[conf] || 0) > (CONF_RANK[prev.confidence] || 0)) { prev.confidence = conf; if (str(b.what_it_means)) prev.claim_text = claimText }
        if ((GRADE_RANK[grade] || 0) > (GRADE_RANK[prev.evidence_grade] || 0)) { prev.evidence_grade = grade; if (str(b.mechanism)) prev.mechanism = str(b.mechanism).slice(0, 240) }
        if (substantiated) prev.substantiation_status = 'substantiated'
        for (const u of cites) if (prev.source_refs.length < 4 && !prev.source_refs.includes(u)) prev.source_refs.push(u)
      }
    }
    for (const m of asArr(a.ing.marketing_vs_reality)) {
      const reality = str(m.reality || m.finding)
      const myth = str(m.claim_in_market || m.claim)
      if (!reality || !myth) continue
      mvr.push({
        claim_text: myth,
        source_ref: driver,
        source_type: 'marketing_vs_reality',
        evidence_grade: null,
        substantiation_status: 'flagged',
        drivers: [driver],
        finding: reality.slice(0, 260),
        confidence: 'high',
      })
    }
  }
  const gradedArr = [...graded.values()].sort((x, y) =>
    ((CONF_RANK[y.confidence] || 0) - (CONF_RANK[x.confidence] || 0)) || ((GRADE_RANK[y.evidence_grade] || 0) - (GRADE_RANK[x.evidence_grade] || 0)),
  ).slice(0, 10)
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
  // Lookups are BATCHED (one query for all terms). Back-compat: a single-term
  // opts.kbLookup is wrapped into a batch shim so existing callers/tests keep
  // working; the real/default path uses the batched store getter.
  let kbLookupBatch = opts.kbLookupBatch
  if (typeof kbLookupBatch !== 'function') {
    if (typeof opts.kbLookup === 'function') {
      kbLookupBatch = async (terms, l) => {
        const m = new Map()
        for (const t of terms) {
          try { m.set(t, await opts.kbLookup(t, l)) } catch { m.set(t, null) }
        }
        return m
      }
    } else {
      kbLookupBatch = (terms, l) => defaultKbLookupBatch(terms, l)
    }
  }
  const p = asObj(product) || {}
  const actives = await collectActives(p, kbLookupBatch, lang)
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
    evidence_profile: 'grounded_verified', // string enum (existing product_intel.v1 field)
    evidence_review_state: 'observed', // EvidenceProfile.review_state — automated grounded (not human 'reviewed')
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
