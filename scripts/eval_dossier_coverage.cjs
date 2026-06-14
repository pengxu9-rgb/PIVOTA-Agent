'use strict'
/*
 * Dossier-coverage eval (ADR-002 Phase 0).
 *
 * Scores each product's AGENT-FACING product_intel (via get_pdp_v2) against the
 * "decision dossier" bar, classifies its serving tier, and aggregates a catalog
 * baseline so "are we a recommendable provider?" becomes a tracked number.
 *
 * Read-only. Usage:
 *   AGENT_KEY=<key> BASE=https://pivota-agent-staging.up.railway.app \
 *     node scripts/eval_dossier_coverage.cjs
 *   (env: QUERIES csv override; MAX_PRODUCTS; OUT=/path.json)
 *
 * Dossier dimensions (per product), weighted to 100:
 *   D1 structured_why   (20) >=2 why_it_stands_out entries w/ body + evidence_strength
 *   D2 graded_claims    (25) >=3 evidence_claims w/ evidence_grade A/B/C + status
 *   D3 honesty          (15) any of marketing_vs_reality / not_fit / watchouts
 *   D4 review_synthesis (20) community_signals present (not 'unavailable') OR review_summary count>0
 *   D5 commerce_trust   (10) >=1 offer with a price (bonus signal: >1 offer)
 *   D6 specificity      (10) what_it_is body names an ingredient/mechanism (not a generic blurb)
 * DOSSIER BAR = score >= 60 AND D2 present (must carry the graded layer).
 */
const BASE = process.env.BASE || 'https://pivota-agent-staging.up.railway.app'
const KEY = process.env.AGENT_KEY || ''
const MAX_PRODUCTS = Number(process.env.MAX_PRODUCTS || 50)
const OUT = process.env.OUT || '/tmp/dossier_eval.json'
const fs = require('fs')
const H = { 'Content-Type': 'application/json', 'X-Agent-API-Key': KEY }
const QUERIES = (process.env.QUERIES || 'centella serum,niacinamide serum,snail mucin essence,propolis ampoule,ceramide cream,hyaluronic acid serum,collagen firming cream,soothing toner,rice toner,mugwort essence,vitamin c serum,retinol cream,peptide serum,sunscreen,cleansing foam').split(',').map((s) => s.trim()).filter(Boolean)

async function inv(body) {
  for (let a = 0; a < 3; a++) {
    try {
      const c = new AbortController(); const to = setTimeout(() => c.abort(), 40000)
      const r = await fetch(`${BASE}/agent/shop/v1/invoke`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: c.signal })
      clearTimeout(to); return await r.json()
    } catch (e) { if (a === 2) return null; await new Promise((x) => setTimeout(x, 1500)) }
  }
}
function collectRefs(n, out, seen, d = 0) {
  if (!n || d > 8) return
  if (Array.isArray(n)) { for (const v of n) collectRefs(v, out, seen, d + 1); return }
  if (typeof n === 'object') {
    const p = n.product_id || n.id; const m = n.merchant_id
    if (p && m) { const k = `${m}:${p}`; if (!seen.has(k)) { seen.add(k); out.push({ product_id: String(p), merchant_id: String(m) }) } }
    for (const v of Object.values(n)) collectRefs(v, out, seen, d + 1)
  }
}
function findBundle(n, d = 0) {
  if (!n || d > 12) return null
  if (Array.isArray(n)) { for (const v of n) { const r = findBundle(v, d + 1); if (r) return r } }
  else if (typeof n === 'object') { if (n.product_intel_core) return n; for (const v of Object.values(n)) { const r = findBundle(v, d + 1); if (r) return r } }
  return null
}
function findByType(n, type, d = 0) {
  if (!n || d > 10) return null
  if (Array.isArray(n)) { for (const v of n) { const r = findByType(v, type, d + 1); if (r) return r } }
  else if (typeof n === 'object') { if (n.type === type && n.data) return n.data; for (const v of Object.values(n)) { const r = findByType(v, type, d + 1); if (r) return r } }
  return null
}
const arr = (v) => (Array.isArray(v) ? v : [])
const INGRED_HINT = /niacinamide|hyaluron|centella|cica|panthenol|ceramide|adenosine|retino|bakuchiol|peptide|vitamin|salicylic|glycolic|azelaic|snail|propolis|collagen|squalane|madecass|isoflavone|ferment/i
const MECH_HINT = /mechanism|inhibit|stimulat|barrier|melano|sebum|ceramide synthesis|antioxidant|humectant|exfoliat|collagen|hydrat|brighten|soothe|TEWL/i

function scoreProduct(resp) {
  const b = findBundle(resp) || {}
  const core = b.product_intel_core || {}
  const prov = b.provenance || {}
  const tier = String(prov.review_tier || prov.tier || '').toLowerCase()
  const why = arr(core.why_it_stands_out).filter((w) => w && (w.body || w.headline))
  const claims = arr(core.evidence_claims)
  const graded = claims.filter((c) => /^[ABC]$/i.test(String(c.evidence_grade || '')) && c.substantiation_status)
  const mvr = claims.filter((c) => c.source_type === 'marketing_vs_reality')
  const cs = b.community_signals || core.community_signals || {}
  const csReal = cs && String(cs.status || '').toLowerCase() !== 'unavailable' && (arr(cs.top_loves).length || arr(cs.top_complaints).length)
  const rs = b.review_summary || core.review_summary || {}
  const reviewN = Number(rs.count || rs.total || 0)
  const offers = findByType(resp, 'offers') || {}
  const offerList = arr(offers.offers)
  const hasPricedOffer = offerList.some((o) => o && (o.price != null || o.price_cents != null || (o.pricing && o.pricing.price != null)))
  const body = String((core.what_it_is || {}).body || '')

  const D = {
    structured_why: why.filter((w) => w.evidence_strength).length >= 2,
    graded_claims: graded.length >= 3,
    honesty: mvr.length > 0 || arr(core.not_fit).length > 0 || arr(core.watchouts).length > 0,
    review_synthesis: !!csReal || reviewN > 0,
    commerce_trust: offerList.length >= 1 && hasPricedOffer,
    specificity: INGRED_HINT.test(body) || MECH_HINT.test(body),
  }
  const W = { structured_why: 20, graded_claims: 25, honesty: 15, review_synthesis: 20, commerce_trust: 10, specificity: 10 }
  const score = Object.keys(W).reduce((s, k) => s + (D[k] ? W[k] : 0), 0)
  const isDossier = score >= 60 && D.graded_claims
  let cls = 'none'
  if (core.product_intel_core || core.what_it_is || why.length || claims.length) {
    cls = tier === 'grounded' ? 'grounded' : (isDossier ? 'dossier' : 'positioning_blurb')
  }
  return { tier: tier || 'n/a', score, isDossier, dims: D, klass: cls, why: why.length, graded: graded.length, mvr: mvr.length, reviewSynthesis: !!csReal || reviewN > 0, offers: offerList.length }
}

async function main() {
  if (!KEY) { console.error('AGENT_KEY required'); process.exit(2) }
  console.log(`BASE=${BASE}  bar: score>=60 & graded_claims`)
  const refs = []; const seen = new Set()
  for (const q of QUERIES) { const r = await inv({ operation: 'find_products_multi', payload: { query: q, limit: 6 } }); if (r) collectRefs(r, refs, seen); if (refs.length >= MAX_PRODUCTS * 1.5) break }
  const rows = []
  for (const ref of refs.slice(0, MAX_PRODUCTS)) {
    const r = await inv({ operation: 'get_pdp_v2', payload: { product_ref: ref, include: ['decision', 'product_intel', 'offers', 'reviews'] } })
    if (!r) continue
    rows.push({ ref, ...scoreProduct(r) })
  }
  // aggregate
  const n = rows.length || 1
  const dossierPct = (rows.filter((x) => x.isDossier).length / n * 100)
  const tierDist = {}; const dimCov = { structured_why: 0, graded_claims: 0, honesty: 0, review_synthesis: 0, commerce_trust: 0, specificity: 0 }
  let scoreSum = 0
  for (const x of rows) { tierDist[x.klass] = (tierDist[x.klass] || 0) + 1; scoreSum += x.score; for (const k of Object.keys(dimCov)) if (x.dims[k]) dimCov[k]++ }
  console.log(`\n=== DOSSIER BASELINE (${rows.length} products) ===`)
  console.log(`meets dossier bar: ${dossierPct.toFixed(0)}%  | mean score: ${(scoreSum / n).toFixed(0)}/100`)
  console.log(`tier distribution: ${Object.entries(tierDist).map(([k, v]) => `${k}=${v} (${(v / n * 100).toFixed(0)}%)`).join(', ')}`)
  console.log(`\nper-dimension coverage (% of products):`)
  for (const k of Object.keys(dimCov)) console.log(`  ${k.padEnd(18)} ${(dimCov[k] / n * 100).toFixed(0)}%`)
  console.log(`\nbiggest gaps: ${Object.entries(dimCov).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([k, v]) => `${k} (${(v / n * 100).toFixed(0)}%)`).join(', ')}`)
  fs.writeFileSync(OUT, JSON.stringify({ base: BASE, n: rows.length, dossierPct, tierDist, dimCov, rows }, null, 2))
  console.log(`\nper-product detail → ${OUT}`)
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
