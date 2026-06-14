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

// Trailing INCI form-words, split by whether the physical FORM carries the
// botanical's signaling actives. Botanical INCI names ("Centella Asiatica Leaf
// Water", "Glycine Soja Seed Extract") carry these as suffixes; the curated KB is
// keyed by the active core ("centella asiatica extract"), so for an ACTIVE-BEARING
// form we strip it to a botanical core + a "<core> extract" variant as extra
// lookup candidates.
//
// ACTIVE_BEARING forms (extract, ferment, leaf/seed/root, water/juice/filtrate,
// callus/cell culture…) concentrate the water/alcohol-soluble actives, so reducing
// them to the bare genus is correct — that is how "Glycine Soja Seed Extract"
// resolves to the curated soy-isoflavone entry.
//
// INERT forms (oil, butter, wax, sterols, protein, lecithin) are the lipid / bulk
// fraction and carry NEGLIGIBLE of those actives — genistein/daidzein are not in
// soybean OIL. Reducing an inert form to the same bare genus is the FORM-BLIND bug:
// "Glycine Soja Oil" would emit the same "glycine soja" / "glycine soja extract"
// candidates as the seed extract and could borrow the isoflavone firming claim —
// an FTC substantiation / mis-attribution risk. So an inert form is NEVER reduced
// to the genus core (see addTermVariants); it keeps only its full-token candidate
// and matches a KB entry ONLY when one is deliberately keyed under that exact inert
// form (e.g. "glycine soja oil"). This is runtime defense-in-depth: the safety no
// longer lives only in KB curation discipline (the "don't key isoflavones under
// bare 'glycine soja'" alias note in pivota-backend ingredient_kb seeds).
const ACTIVE_BEARING_FORM_WORDS = new Set([
  'water', 'extract', 'leaf', 'seed', 'root', 'flower', 'fruit', 'bark', 'peel', 'stem',
  'powder', 'ferment', 'filtrate', 'juice', 'sap', 'callus', 'culture', 'cell', 'meristem',
])
const INERT_FORM_WORDS = new Set([
  'oil', 'butter', 'wax', 'sterols', 'sterol', 'protein', 'lecithin',
])
const INCI_FORM_WORDS = new Set([...ACTIVE_BEARING_FORM_WORDS, ...INERT_FORM_WORDS])

// One ingredient token (already paren-stripped + split out) -> normalized
// KB-query candidates. Adds a form-word-stripped botanical core and its
// "<core> extract" form so suffixed INCI names still resolve to curated KB keys —
// but ONLY for active-bearing forms. If ANY stripped trailing form-word is inert
// (oil/butter/wax/…), the token is the lipid/bulk fraction: we suppress the
// genus-core candidates so the inert form cannot borrow an active-bearing entry,
// and keep only its full-token candidate (form-aware mis-attribution guard).
function addTermVariants(token, out) {
  const t = normalizeTerm(token)
  if (!t || t.length < 3) return
  out.push(t)
  const words = t.split(' ').filter(Boolean)
  let end = words.length
  let sawInertForm = false
  while (end > 1 && INCI_FORM_WORDS.has(words[end - 1])) {
    if (INERT_FORM_WORDS.has(words[end - 1])) sawInertForm = true
    end--
  }
  // An inert botanical form keeps ONLY its full token — never the bare genus or a
  // synthesized "<core> extract" — so it can't conflate with the active-bearing form.
  if (sawInertForm) return
  if (end >= 1 && end < words.length) {
    const core = words.slice(0, end).join(' ')
    if (core.length >= 3) { out.push(core); out.push(`${core} extract`) }
  }
}

// --- Concentration / hygiene helpers -------------------------------------
// Parse an explicit concentration like "Sodium Hyaluronate(5,293ppm)" → 5293.
function parsePpm(raw) {
  const m = str(raw).match(/([\d][\d,]*)\s*ppm/i)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}
// Truncate at a word boundary so bodies never end mid-word.
function clip(text, n) {
  const s = str(text).trim()
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-]+$/, '')}…`
}
// Reject scraped page text masquerading as an ingredient ("Arginine How to use
// After cleansing", URLs, over-long phrases) so the ordered INCI stays clean.
const INCI_NOISE_RE = /\b(how to use|after cleansing|directions?|step\s*\d|remove the film|matching up|massage|rinse|warning|caution|apply\b|patch test|net wt|made in)\b/i
function isCleanIngredientToken(name) {
  const t = str(name).trim()
  if (t.length < 2 || t.length > 60) return false
  if (/^https?:\/\//i.test(t)) return false
  if (INCI_NOISE_RE.test(t)) return false
  if (t.split(/\s+/).length > 7) return false // INCI names are short
  return true
}

// Read the product's ordered INCI (descending concentration) as raw tokens,
// from the best available full-list source. Arrays keep ppm intact per element;
// strings are split on commas OUTSIDE parens (so "(5,293ppm)" stays whole).
function readOrderedInci(product) {
  const ii = asObj(product.ingredient_intel) || asObj(product.ingredientIntel) || {}
  const inciObj = asObj(product.ingredients_inci) || asObj(product.ingredientsInci) || {}
  const toList = (src) => {
    if (Array.isArray(src)) {
      return src.map((x) => (typeof x === 'string' ? x : str(x && (x.name || x.inci || x.display_name || x.label)))).filter(Boolean)
    }
    if (typeof src === 'string' && src.trim()) return src.split(/,(?![^()]*\))|[;\n]/).map((s) => s.trim()).filter(Boolean)
    return null
  }
  for (const src of [ii.items, inciObj.items, product.inci, product.ingredients_inci, product.ingredientsInci,
    product.ingredient_list, product.ingredients, ii.raw_text, ii.rawText, inciObj.raw_text]) {
    const list = toList(src)
    if (list && list.length >= 2) return list
  }
  return []
}

// Names the BRAND explicitly markets as key ingredients (key_ingredients /
// hero_ingredients). These are looked up and floored at supportive, but are NOT
// auto-promoted to hero — HERO still requires concentration evidence (the brand
// asserting "key ingredient" on a trace dusting must not bypass the gate). Used
// both to seed candidates and to keep otherwise-too-short records (the brand
// vouches the record is a real formula). ingredient_intel.active_items is
// handled the same way (supportive-tier candidates).
function declaredHeroNames(product) {
  const out = new Set()
  const push = (v) => {
    if (v == null) return
    if (Array.isArray(v)) { v.forEach(push); return }
    if (typeof v === 'object') { push(v.name || v.inci || v.display_name || v.label); return }
    const t = normalizeTerm(v); if (t) out.add(t)
  }
  push(product.key_ingredients); push(product.keyIngredients)
  push(product.hero_ingredients); push(product.heroIngredients)
  return out
}

// Generic concentration bars. A normal active needs real concentration evidence
// to hero: top-third INCI position OR >= 0.1% (1000ppm) disclosed.
const HERO_PPM = 1000 // 0.1%
const SUPPORTIVE_PPM = 100 // 0.01%
const HERO_FRAC = 1 / 3 // top third (inclusive) — e.g. #3 of 6 sits above glycerin/preservatives
const SUPPORTIVE_FRAC = 2 / 3

// --- Low-dose-active efficacy floor (ADR-002) ---------------------------------
// Some actives are efficacious FAR below the generic hero bar — retinoids
// (0.01–0.3%), adenosine (~0.04%), peptides, soy isoflavones — so INCI position
// and the 0.1% ppm bar systematically UNDER-feature them (the Aruen "Tofu
// Collagen" soy-isoflavone case: Glycine Soja Seed Extract is the real firming
// driver, yet the generic gate calls it trace). The curated KB flags these
// per-active via ingredient_profile_json.efficacy; for a FLAGGED active only,
// presenceTier lowers the hero bar. This is a curated, per-ingredient decision —
// NOT a blanket loosening — so non-flagged trace dustings still never carry a
// product-level claim (FTC substantiation risk; PRs #1680–#1683).
//
// The two efficacy levers are DECOUPLED (one curated semantic each):
//   • efficacy.low_dose_active: true  → relax the INCI-POSITION bar (the active
//     is efficacious where it naturally sits, low in the list).
//   • efficacy.min_efficacious_ppm: n → relax the DISCLOSED-ppm hero bar to n.
// An entry may set either or both (adenosine sets both; soy sets position only).
const LOW_DOSE_DEFAULT_HERO_PPM = 100 // 0.01% — disclosed-ppm hero bar for a low_dose_active with no curated ppm
// A low_dose_active is EXPECTED to sit low in the INCI, so position is a weak
// signal — but not no signal: we still require it above the bottom quartile so a
// genuine deep-tail dusting (formulation noise) is not featured. Curation is the
// primary gate; this is the backstop.
const LOW_DOSE_HERO_FRAC = 0.75
// Reject an implausibly small curated min_efficacious_ppm (a unit slip / typo,
// e.g. 1 → "anything disclosed is hero"). Below this we ignore the curated value
// and fall back to the default bar — never weaker than the conservative gate.
const MIN_SANE_EFFICACIOUS_PPM = 10 // 0.001%

// Per-active efficacy metadata from the matched KB entry
// (ingredient_profile_json.efficacy). Returns null when the entry carries no
// usable efficacy floor (→ the conservative default applies).
function readEfficacy(profile) {
  const e = asObj(profile && profile.efficacy)
  if (!e) return null
  const lowDoseActive = e.low_dose_active === true || e.lowDoseActive === true
  const rawPpm = e.min_efficacious_ppm != null ? e.min_efficacious_ppm : e.minEfficaciousPpm
  const n = Number(rawPpm)
  // Sanity-floored: a finite, plausible ppm only. A non-number / 0 / negative /
  // implausibly-small value is ignored (→ null), keeping the conservative bar.
  const minEfficaciousPpm = Number.isFinite(n) && n >= MIN_SANE_EFFICACIOUS_PPM ? n : null
  if (!lowDoseActive && minEfficaciousPpm == null) return null
  return { lowDoseActive, minEfficaciousPpm }
}

// Concentration tier for a single signal. ppm (when disclosed) wins; otherwise
// position in the descending-concentration INCI. A brand-declared "key
// ingredient" only FLOORS at supportive — HERO status still requires real
// concentration evidence. Brands routinely market a trace dusting (e.g. Ceramide
// NP at #34/34) as a key ingredient, so declared alone must NOT bypass the gate.
//
// `efficacy` (optional, from the matched KB entry) independently relaxes the ppm
// bar (min_efficacious_ppm) and/or the position bar (low_dose_active); absent it,
// the conservative default applies.
function presenceTier(sig, efficacy) {
  if (!sig) return 'supportive'
  const minPpm = efficacy && efficacy.minEfficaciousPpm != null ? efficacy.minEfficaciousPpm : null
  const lowDosePos = !!(efficacy && efficacy.lowDoseActive)
  if (sig.ppm != null) {
    // Disclosed concentration wins. A curated min_efficacious_ppm lowers the hero
    // bar to that ppm (adenosine 400ppm = 0.04%); a low_dose_active with no curated
    // ppm uses the generic low-dose floor. Below the supportive band → trace.
    const heroPpm = minPpm != null ? minPpm : (lowDosePos ? LOW_DOSE_DEFAULT_HERO_PPM : HERO_PPM)
    const relaxed = minPpm != null || lowDosePos
    const supPpm = relaxed ? Math.max(1, Math.round(heroPpm / 2)) : SUPPORTIVE_PPM
    if (sig.ppm >= heroPpm) return 'hero'
    if (sig.ppm >= supPpm) return 'supportive'
    return 'trace'
  }
  if (sig.index == null || !sig.total) return 'supportive'
  const frac = sig.index / sig.total
  // A low_dose_active earns hero where it naturally sits (low in the INCI, above
  // the bottom quartile); everything else keeps the conservative top-third bar.
  if (frac <= (lowDosePos ? LOW_DOSE_HERO_FRAC : HERO_FRAC)) return 'hero'
  if (frac <= SUPPORTIVE_FRAC) return 'supportive'
  return 'trace'
}
const TIER_RANK = { hero: 3, supportive: 2, trace: 1 }

// Strongest tier across ALL signals observed for one candidate term, under the
// (optional) efficacy floor. buildCandidatePresence keeps EVERY signal (declared,
// positional, ppm) per term precisely because the efficacy-aware ranking can
// differ from the raw one — e.g. a low-dose active's late INCI position outranks a
// bare brand declaration, but only once we know (post-lookup) that it's flagged.
function bestPresenceTier(sigs, efficacy) {
  const list = asArr(sigs)
  if (!list.length) return presenceTier(null, efficacy) // neutral 'supportive'
  let best = 'trace'
  for (const sig of list) {
    const t = presenceTier(sig, efficacy)
    if (TIER_RANK[t] > TIER_RANK[best]) best = t
  }
  return best
}

// Map every KB-lookup CANDIDATE term -> ALL concentration signals from the source
// ingredients it came from (declared, ordered-INCI position + ppm, auto-detected).
// Keeping every signal (not just the raw-strongest) lets collectActives pick the
// max tier UNDER the matched active's efficacy floor — a bare declaration must not
// hide a hero-worthy INCI position once we know the active is low_dose flagged.
function buildCandidatePresence(product) {
  const byCandidate = new Map() // candidate term -> sig[]  ({ declared } | { index, total, ppm } | {})
  const add = (name, sig) => {
    const cands = []
    addTermVariants(name, cands)
    for (const c of cands) {
      const arr = byCandidate.get(c)
      if (arr) arr.push(sig)
      else byCandidate.set(c, [sig])
    }
  }
  for (const name of declaredHeroNames(product)) add(name, { declared: true })
  const ordered = readOrderedInci(product).filter((tok) => isCleanIngredientToken(tok.replace(/\([^)]*\)/g, '').trim()))
  const total = ordered.length
  ordered.forEach((tok, index) => add(tok.replace(/\([^)]*\)/g, ' '), { index, total, ppm: parsePpm(tok) }))
  // Auto-detected actives (ingredient_intel.active_items) as no-position
  // candidates: they get looked up, but don't bypass the concentration gate — a
  // bare {} signal maxes out at supportive, so it never heroes on its own.
  const ii = asObj(product.ingredient_intel) || asObj(product.ingredientIntel) || {}
  const autos = new Set()
  const collectNames = (v) => {
    if (v == null) return
    if (Array.isArray(v)) { v.forEach(collectNames); return }
    if (typeof v === 'object') { collectNames(v.name || v.inci || v.display_name || v.label); return }
    const t = str(v); if (t) autos.add(t)
  }
  collectNames(ii.active_items)
  for (const name of autos) add(name, {}) // {} -> supportive tier (no position signal)
  return byCandidate
}

// Back-compat: flat list of KB-lookup candidate terms (used by tests + the
// load-check harness). Now derived from the concentration-aware candidate map.
function extractActiveTerms(product) {
  return [...buildCandidatePresence(product).keys()]
}

// Bound the term list so the batched IN-list stays sane for pathological INCI.
const MAX_LOOKUP_TERMS = 64
// A real cosmetic formula lists >= this many ingredients; fewer = a truncated /
// partial extraction we won't build a graded dossier from.
const MIN_INCI_TO_SERVE = 5

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

// Collect grounded KB actives WITH a concentration tier (hero/supportive/trace).
// The tier gates featuring + claims downstream so a trace dusting never carries
// a product-level efficacy claim (the adversarial-review finding).
async function collectActives(product, kbLookupBatch, lang) {
  const presence = buildCandidatePresence(product)
  const terms = [...presence.keys()].slice(0, MAX_LOOKUP_TERMS)
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
    // Strongest tier across ALL signals for this term, under the matched active's
    // efficacy floor (lowers the bar for curated low-dose actives; conservative
    // default otherwise). Considering every signal — not a pre-collapsed one —
    // keeps a brand declaration from hiding a hero-worthy INCI position.
    const tier = bestPresenceTier(presence.get(term), readEfficacy(profile))
    const existing = bySlug.get(key)
    if (existing) { // keep the strongest presence across this active's candidate terms
      if (TIER_RANK[tier] > TIER_RANK[existing.presence]) existing.presence = tier
      continue
    }
    bySlug.set(key, { term, profile, ing, slug: key, presence: tier })
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
  const subject = str(product.title || product.name || product.product_name) || roleLabel
  const hero = ranked[0]
  const heroMvr = hero && asArr(hero.ing.marketing_vs_reality)[0]
  // Neutral framing: name the GRADED actives that are genuinely present (heroes),
  // never an unverifiable "[X] forward" superiority claim (which mis-fired when a
  // trace KB active outranked the formula's true lead).
  let body = names.length
    ? `Grounded analysis of the verified formula. Graded actives present: ${names.slice(0, 4).join(', ')}.`
    : 'Grounded analysis of the verified formula.'
  if (heroMvr && claimSafe(heroMvr.reality)) body += ` ${clip(heroMvr.reality, 180)}`
  // Short active names in the headline (strip parenthetical aliases like
  // "(Galactomyces, Bifida, …)") so it never clips mid-name.
  const shortNames = names.map((n) => n.replace(/\s*\([^)]*\)/g, '').trim()).filter(Boolean)
  const headline = shortNames.length ? `${subject} — key actives: ${shortNames.slice(0, 3).join(', ')}` : subject
  return { headline: clip(headline, 140), body: clip(body, 320) }
}

function buildWhy(ranked) {
  const out = []
  for (const a of ranked.slice(0, 4)) {
    const top = topBenefit(a)
    if (!top) continue
    const headline = str(a.ing.display_name || a.term)
    const body = [str(top.what_it_means), str(top.mechanism)].filter(Boolean).join(' ')
    if (!body || !claimSafe(`${headline} ${body}`)) continue
    out.push({ headline, body: clip(body, 300), evidence_strength: evidenceOf(a) })
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
  // One claim per (active, concern). NO cross-active merge — each claim is bound
  // to the SINGLE active that drives it, so an active's trial/mechanism is never
  // spliced onto another active's source_ref (the fabricated-provenance finding).
  const graded = []
  const seen = new Set()
  const mvr = []
  for (const a of ranked) {
    const grade = gradeOf(a)
    const cites = asArr(a.profile.evidence && a.profile.evidence.citations).map((c) => str(c.url)).filter(Boolean)
    const driver = str(a.ing.display_name || a.term)
    for (const b of asArr(a.profile.benefits)) {
      const concern = str(b.concern)
      const claimText = str(b.what_it_means) || concern
      if (!concern || !claimSafe(`${b.what_it_means} ${b.mechanism}`)) continue
      const key = `${a.slug}::${slug(concern)}`
      if (seen.has(key)) continue
      seen.add(key)
      let conf = CONF_BY_STRENGTH[b.strength == null ? 1 : b.strength] || 'low'
      if (grade === 'C' && conf === 'high') conf = 'moderate'
      const substantiated = cites.length > 0 || grade === 'A' || grade === 'B'
      graded.push({
        claim_text: clip(claimText, 200),
        source_ref: driver, // single driving active
        source_type: 'ingredient_mechanism',
        evidence_grade: grade,
        substantiation_status: substantiated ? 'substantiated' : 'unverified',
        concern,
        drivers: [driver],
        mechanism: clip(b.mechanism, 240) || undefined,
        confidence: conf,
        source_refs: cites.slice(0, 3),
      })
    }
    for (const m of asArr(a.ing.marketing_vs_reality)) {
      const reality = str(m.reality || m.finding)
      const myth = str(m.claim_in_market || m.claim)
      if (!reality || !myth) continue
      mvr.push({
        claim_text: clip(myth, 200),
        source_ref: driver,
        source_type: 'marketing_vs_reality',
        evidence_grade: null,
        substantiation_status: 'flagged',
        drivers: [driver],
        finding: clip(reality, 260),
        confidence: 'high',
      })
    }
  }
  graded.sort((x, y) =>
    ((CONF_RANK[y.confidence] || 0) - (CONF_RANK[x.confidence] || 0)) || ((GRADE_RANK[y.evidence_grade] || 0) - (GRADE_RANK[x.evidence_grade] || 0)),
  )
  return [...graded.slice(0, 10), ...mvr.slice(0, 5)]
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
  // Hygiene gate: a real formula has >= MIN_INCI_TO_SERVE clean ingredients. A
  // shorter list is a truncated/partial extraction that can't establish the
  // concentration context a product-level efficacy claim needs — so we DON'T
  // serve it, even if the brand "declared" an active (declared can't bypass the
  // gate; that loophole let a 3-token record carry a clinical claim).
  const orderedClean = readOrderedInci(p).filter((t) => isCleanIngredientToken(t.replace(/\([^)]*\)/g, '').trim()))
  if (orderedClean.length < MIN_INCI_TO_SERVE) return null

  const actives = await collectActives(p, kbLookupBatch, lang)
  // Only HERO actives drive featured intel and claims — a trace/supportive match
  // never earns a product-level claim, and a product whose ONLY grounded matches
  // are trace is not served (no false "[active] forward" off a dusting). HERO =
  // top-third / >=0.1% ppm for a normal active, OR — for a curated low_dose_active
  // — present above the trailing tail / >= its min_efficacious_ppm. A trace
  // dusting of a NON-flagged active stays excluded (the core adversarial-review fix).
  const heroes = actives.filter((a) => a.presence === 'hero')
  if (!heroes.length) return null
  const ranked = rankActives(heroes)
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
  _internal: { collectActives, buildEvidenceClaims, normalizeTerm, claimSafe, rankActives, presenceTier, bestPresenceTier, readEfficacy },
}
