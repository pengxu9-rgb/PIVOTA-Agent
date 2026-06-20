# AI-Readiness Scope — Flagged-Intent → Canonical-PDP Enrichment

**Goal:** Close the loop the DeepSeek verify pass just opened. When verify flags a
citation as *"AI mentions this product but recommends competitors"*
(`supports_recommendation = false`) for a shopper intent (e.g. *halal collagen*,
*best collagen for travel*), feed that intent into the canonical-PDP enrichment so the
generated PDP copy gives AI a concrete, factual reason to **recommend** the product for
that intent — not just mention it. Then the next audit re-measures whether AI flipped.

Status: **SCOPED** (build not started). Grounded against deployed `origin/main @ 38b1558a`.

---

## 1. Why this is the natural next build

The verify pass is now (post #956/#959) a **content-gap detector**. The 9:47 PM Chydan
audit flagged 11 of 20 cited answers — **every one** `supports_recommendation = false`
(zero `misstates_facts`), with the recurring note *"lists competitors but does not
recommend the specific SKU"* for: halal collagen, marine collagen, collagen reviews, best
collagen for travel/sleep, "what helps with travel", best supplement. That is a **ranked
worklist of intents the PDP fails to win** — exactly what an enrichment brief should target.

The loop this enables (the moat — measurement → owned-PDP publish → re-measure):
```
verify flags intent X (mention, no rec)  →  enrich canonical PDP to answer X factually
   →  re-audit  →  intent X flips to "held up" / no longer flagged   (proof)
```

## 2. Reuse-don't-rebuild map (it's ~90% there)

| Piece | Exists at | Status for this build |
|---|---|---|
| Per-SKU flagged intents | `per_sku_report.verify_summary.flagged_probes[]` (`agent_center_bd_report_service.py:3574`, attached `:5457`) — each `{query, supports_recommendation, misstates_facts, note}` | **Read it** (currently unused by E1) |
| E1 executor + audit-first candidates | `executor_agents/canonical_pdp_enrichment.py` — `_audit_thin_content_keys:132`, `_resolve_candidates:201` | **Extend** (also carry intents) |
| Grounded generator (Gemini + google_search) | `_build_enrichment_prompt:235`, `_generate_enrichment:329` (E1 has its OWN Gemini call — NOT the heuristic `product_enrichment_ai.generate_enrichment_draft`) | **Inject intents into the prompt** |
| Compliance gate | `product_enrichment_pipeline._simple_compliance_check:36` (blocks medical/financial) | **No change** — framing only |
| Publish (the E2 fix) | `agent_pdp_view_assembler.assemble_row:618` overlays `enrichment.description_markdown` (`:660`); serving gate `index_pipeline_state_service.py:282` (desc ≥50 chars) | **No change — already wired** |
| Re-measure | daily re-audit cron + on-demand audit | **No change** — the proof is automatic |

**Net: the whole change is in `canonical_pdp_enrichment.py`.** No pipeline, generator-module,
schema, or portal changes.

## 3. The build (4 edits, one file)

**3a. New helper — map content_key → lost-rec intents** (near `_audit_thin_content_keys:132`)
```python
def _audit_flagged_intents_by_content_key(audit_report) -> Dict[str, List[str]]:
    """Per SKU: the shopper queries where AI MENTIONED the product but did NOT
    recommend it (verify_summary.flagged_probes, supports_recommendation is False).
    These are the intents enrichment should make the PDP win. Keyed by content_key
    so it joins to the fetched candidate rows. misstates_facts probes are EXCLUDED
    here (different problem — see §5)."""
    # for r in per_sku_reports: ck = r["content_key"];
    #   intents = [p["query"] for p in r["verify_summary"]["flagged_probes"]
    #              if p.get("supports_recommendation") is False and p.get("query")]
    #   dedupe, cap ~6 per SKU
```

**3b. `_resolve_candidates:201`** — after `_fetch_canonical_pdps_by_content_keys` returns the
audit rows, attach intents by joining on `content_key`:
```python
intents_map = _audit_flagged_intents_by_content_key(context.audit_report)
for c in candidates:
    c["_target_intents"] = intents_map.get(c.get("content_key"), [])
```
(Catalog-fallback candidates simply get `[]` — no audit signal, prompt unchanged for them.)

**3c. `_build_enrichment_prompt:235`** — when `candidate["_target_intents"]` is non-empty, add a
targeting block BEFORE the schema, kept subordinate to the existing truthfulness rules:
```
AI shopping agents currently surface this product for these shopper intents but
recommend competitors instead — make the copy a clear, factual answer for each
(only where the product genuinely fits; never invent a fit):
  - "halal collagen"
  - "best collagen for travel"
  ...
```
The existing rule *"Do NOT invent specs, ingredients, certifications… If you cannot verify a
fact, omit it"* already governs this — so if the product is NOT halal, the generator addresses
what it CAN substantiate and omits the rest (see §5).

**3d. `execute:384` evidence** — record `targeted_intents` per enriched SKU in the
`ExecutorResult.evidence` (and keep the `RESULT_TYPE` as-is). This makes the loop auditable:
"enriched SKU X to win intents [halal collagen, travel]" → next audit shows if it worked.

## 4. Per-SKU mapping is clean

`flagged_probes` live on **each `per_sku_report.verify_summary`** (verify runs per-SKU), NOT only
the brand rollup — so `content_key → intents` is exact. Use the per-SKU summary; do **not** read
the brand `_rollup_verify_summaries` (it aggregates across SKUs and would cross-contaminate).

## 5. Scope boundary: lost-rec vs misstated-fact (important)

`_verify_output_flagged` fires on `supports_recommendation is False` **OR** `misstates_facts is
True` (`agent_center_bd_report_service.py:3199`). These need different treatment:
- **`supports_recommendation = false`** ("mention, no rec") → **in scope.** Enrichment can give AI
  a reason to recommend. This is the entire Chydan flagged set today.
- **`misstates_facts = true`** ("AI said something wrong") → **out of scope for v1.** The fix is
  to assert the *correct* fact on the PDP (fact-correction), which risks the generator amplifying a
  contested claim. Park it; revisit once we see real misstates_facts cases (Chydan had none).

## 6. Truthfulness guard (non-negotiable)

Targeting an intent must NEVER make the generator fabricate a fit. The prompt keeps "only where
the product genuinely fits; never invent" and the grounded `google_search` tool + the existing
compliance gate stay in force. Acceptable outcome: for an intent the product can't honestly serve
(e.g. *halal* when uncertified), the PDP simply doesn't win it — that's correct, not a miss. We are
closing a **truthful** gap (the product fits but the copy didn't say why), not gaming the model.

## 7. Test plan (local — pivota-backend CI is billing-blocked)

- `_audit_flagged_intents_by_content_key`: extracts only `supports_recommendation is False`
  intents; excludes `misstates_facts`-only and empty-query probes; keyed by content_key; dedup+cap.
- `_resolve_candidates`: audit candidate carries its SKU's intents; catalog-fallback candidate gets
  `[]`; intents join on the correct content_key (no cross-SKU leakage).
- `_build_enrichment_prompt`: includes the targeting block + the intents when present; unchanged
  output when `_target_intents` is empty (regression guard for fallback path).
- evidence: `execute` records `targeted_intents` per enriched SKU.

## 8. Proof / verification (live)

After deploy: re-audit Chydan → for a SKU enriched against e.g. "best collagen for travel", check
the next audit's `verify_summary.flagged_probes` no longer lists that intent as
`supports_recommendation=false` (or it moves to "held up"). The "What DeepSeek flagged" list (#960/
#99) is the read-out. NOTE: the narrative is snapshot-stored, so the proof shows on the **post-deploy
audit**, and LLM nondeterminism means use the intent *theme* trend, not an exact-string match.

## 9. Risks / open questions

- **Grounding can't always win an intent** — if Gemini can't substantiate the fit, the PDP won't
  flip it. Expected, not a bug (§6). Track flip-rate, not 100%.
- **Cap interplay** — E1 enriches ≤5 SKUs/audit; per-SKU intents capped ~6. Fine for the test
  merchant; revisit caps at rollout.
- **misstates_facts** parked (§5) — confirm no merchant is relying on it before GA.
- **Re-enrichment** — E1 skips already-enriched SKUs (`description_markdown` not null). A SKU
  enriched once won't re-enrich on the next audit even if new intents flag. **Open:** allow
  re-enrichment when NEW flagged intents appear (compare targeted_intents vs current flags), or keep
  one-shot for v1. Recommend v1 = one-shot; fast-follow = intent-delta re-enrichment.

## 10. Estimate

~1 backend PR, one file (`canonical_pdp_enrichment.py`) + tests. Small. No portal, no schema, no
new executor, no new external mutation. Highest-leverage next step on the measure→publish→re-measure
loop because it turns a measured gap directly into owned-surface copy that the re-audit grades.
