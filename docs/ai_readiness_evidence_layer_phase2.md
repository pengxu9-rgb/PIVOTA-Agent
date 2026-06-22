# AI-Readiness Evidence Layer — Phase 2 design + first buildable slice

Status: design · 2026-06-21
Builds on: Phase-1 positioning work (portal #100/#105/#102/#103/#104, backend #967/#969 — all merged) and the `merchant_commerce_readiness_state` stage model.

---

## 1. Problem & thesis

A thin catalog produces a discouraging audit (the per-SKU band is the **minimum** of its four dimensions, so weak Content-Richness drags the whole product down). But the deeper truth is: the audit measures **citability**, and AI agents cite **grounded, attributable claims** — not marketing copy. So "content" is really two layers:

- **Copy layer** (`product_enrichment`: `summary_short`, `bullet_points`, `usage_scenarios`, `audience_tags`) — readability/findability. Phase-1's concern.
- **Evidence layer** — graded, attributable **claims** (positioning, reviews/media, lab reports, certifications). This is what drives citability and is the moat.

Phase 2 makes every product carry a graded evidence corpus — sourced from the merchant (the long-tail unlock) and the web (the head accelerant) — gated by provenance, fed into the audit, and **served to agents** so it's actually citable.

**Key finding that de-risks the whole phase:** the evidence *model* already exists and is explicitly cross-vertical. This is intake + population + serving wiring on top of an existing model, not a new model.

---

## 2. What already exists (reuse, don't rebuild)

| Already exists | Where |
|---|---|
| `ProductClaim` `{claim_text, source_ref, source_type, evidence_grade, substantiation_status}` + `EvidenceProfile{claims, review_state}` | `models/catalog.py:134,155` |
| Cross-vertical claim **common-core**: status vocab (`unverified→substantiated→flagged→rejected`), `review_state` (`observed/reviewed/flagged`), `normalize_claims`, disclaimer registry (FDA/DSHEA) | `services/claim_safety.py` |
| Audit already scores it: `_has_substantiation` + the "Substantiated claims" component (`content_richness/safety_claims`) that penalizes claims-without-substantiation | `services/agent_center_bd_report_service.py:2110, 4588` |
| Evidence already stored in the agent read-model: `evidence_profile`, `required_disclaimers` columns; assembler fetches + persists them | `db/migrations/152_agent_pdp_view_evidence.sql`; `services/agent_pdp_view_assembler.py:193,615` |
| A grounded-claims **serving** path already exists: `buildEvidenceClaims` (`evidence_grade A–D`, `substantiation_status`) served via `get_pdp_v2` and `get_product include:['decision']` | PIVOTA-Agent `src/groundedProductIntel.js:418`, `safety-kernel/.../canonicalExecutor.js:73` |
| Merchant write pattern that goes live instantly (writes + refreshes `agent_pdp_view` + recomputes serving eligibility) | `services/fashion_field_authoring.py:258` |
| Web-crawl ingest pattern (narrow today: INCI) | `services/crawled_inci_ingest.py`, `external_seed_*` |

What is **beauty-only** today: the *population* (INCI → `evidence_grade=ingredient_inference`, in `beauty_product_profiles.evidence_profile`) and the storage. Phase 2 generalizes the population + intake + serving — the grammar is already shared.

---

## 3. Data model

- **`product_evidence`** (new, cross-vertical; key `product_key + geo`): `claims: ProductClaim[]` + `review_state`. Each claim adds `claim_type` (positioning / benefit / spec), `substantiated_by` (→ `evidence_artifact.id`), `observed_at`. The generalized `evidence_profile`.
- **`evidence_artifact`** (new): the *source documents* a claim points to. `{id, product_key, kind (lab_report|certification|review|press|positioning_doc), source (merchant_upload|web_crawl), url_or_blob_ref, captured_at, extracted_claim_ids[]}`. A claim's `source_ref` → an artifact = the **attribution an agent cites** and the substantiation link.
- **Extend `claim_safety` vocab** (this is the whole new surface — just constants):

| `source_type` | `evidence_grade` (citation weight) | default `substantiation_status` |
|---|---|---|
| `merchant_positioning` | `self_asserted` (lowest) | `unverified` |
| `merchant_lab_report` / `third_party_test` | `independent_lab` (highest) | `substantiated` |
| `certification` | `certified` | `substantiated` |
| `third_party_review` | `third_party` | `substantiated` |
| `editorial_press` | `editorial` (high) | `substantiated` |
| `ingredient_inference` *(today)* | `ingredient_inference` | `substantiated` |

---

## 4. Trust spine — two gates

The grade ladder drives **substantiation**: a `merchant_positioning` claim is `unverified` until **linked** to a higher-grade artifact (lab report, cert, third-party source) → flips to `substantiated`. Drug/disease claims → `flagged`/`rejected` via the existing `claim_safety` screen; required disclaimers (FDA/DSHEA) enforced.

- **Audit gate:** only `substantiated` claims lift the Substantiated-claims / citation score. Unverified claims are neutral-or-penalized (matches today's "claims present without substantiation" logic).
- **Publish/serve gate (runs at the serialize layer):** only `substantiated` + disclaimer-complete + not-`flagged` claims are emitted to **any** agent surface (PDP JSON-LD, agent PDP API, MCP, ACP/UCP). Unverified merchant positioning improves the PDP copy but is **never** served to agents as a grounded claim.

Principle: **a merchant can *say* anything; only *substantiated, attributable* claims get scored, published, or served.** Without this, we'd teach agents to cite marketing — which destroys the citability that is the entire product.

---

## 5. Serve-to-agents (the moat) — surface map + convergence

Evidence is worthless if agents can't read it. Agents consume Pivota two ways, and the **convergence point is `agent_pdp_view`** — the assembler already pulls evidence into it (beauty today); generalize that source to `product_evidence` and everything downstream inherits it.

| Agent surface | Use | Evidence today | Gap → fix |
|---|---|---|---|
| Public canonical PDP + JSON-LD (`agent.pivota.cc/products/sig_*`) | crawl & cite | ❌ `pivota_canonical_routes.py` reads `catalog_products` only | JOIN `agent_pdp_view` evidence → render schema.org JSON-LD |
| Agent PDP API (`/api/agent/pdp/{id}`) | structured read | ⚠️ stored in `agent_pdp_view` but `AGENT_PDP_VIEW_COLUMNS` SELECT **drops** it | add columns to the SELECT (**~1 line**) |
| `find_products` / `_multi` (MCP discovery) | discovery list | ❌ thin by design; evidence behind separate `get_product_intel_v1` | embed an intel pointer / top substantiated claim |
| `get_pdp_v2` / `get_product include:['decision']` | the "why" | ✅ serves graded claims, but opt-in / flag-gated | default-on; feed it merchant claims |
| ACP/UCP commerce doors (`acpRestAdapter.js` `defaultFeedItem`) | discovery + buy | ❌ commerce-only feed | add evidence to feed or default-on `decision` |

**Pipeline:** `product_evidence` → `agent_pdp_view` assembler → `agent_pdp_view` → {audit read, public PDP, agent API, MCP, ACP}. If merchant evidence lands anywhere else, agents never see it and the moat doesn't close.

---

## 6. 2b — merchant evidence intake (optional, suggestion-driven)

**Design law:** intake is **never required** — it's a suggestion to get more out of Pivota. The audit always runs without it. Optional features only get used when value is **earned** (tied to a specific audit finding, not a chore list) + **visible** (projected ROI up front) + **opportunity-framed** (states: *Ready to strengthen → Provided → Substantiated → Cited*, never "Missing") + **frictionless** (paste / drag-drop PDF / one-click-accept) + **always skippable** ("Not now" everywhere) + the **proof loop closes** (re-audit shows the lift).

**Two opt-in surfaces:**
1. **Contextual suggestion** inside audit results / win-plan (primary) — appears only where the audit found a specific gap ("AI didn't repeat your 'clinically tested' claim because nothing backs it"), with an inline add-evidence panel scoped to that product + claim and a projected-lift line.
2. **Evidence workspace** in Catalog health (secondary) — an opportunity-ranked list (sorted by projected impact, never "missing") for merchants who want to work proactively.

**Intake modes** (tiered by what merchants have; never shame absence):
- Positioning / key claims → `merchant_positioning` (`unverified`); microcopy: "back it with a source to make agents repeat it."
- Lab reports / tests / certs → PDF upload → `evidence_artifact` → LLM-extract → confirm (`substantiated`, high grade).
- Reviews / press → import/paste.

**Reuse:** `fashion_field_authoring` write path (goes live instantly), agent-chat per-field-status UX (re-skinned to opportunity framing), `previewProductQuality` for projected lift, `product-optimization` queue for the workspace.

**Long-tail note:** long-tail merchants have thin web presence → crawl yields little → **merchant input is the foundation**, not the accelerant. The intake *is* the corpus for this segment.

---

## 7. Rollout (reordered for cheap de-risking)

1. **Serve-gap P0s** (Section 10) — light up evidence that already exists (beauty INCI) end-to-end; prove "merchant evidence → agent cites it" before building more.
2. **2a — generalized store** — `product_evidence` + `evidence_artifact`; generalize the assembler's evidence fetch beyond `beauty_product_profiles`; readiness "evidence tier" (informational).
3. **2b — merchant intake** — positioning + lab upload first (the long-tail unlock).
4. **2c — crawl + substantiation engine** — generalize the crawler to reviews/press; claim↔artifact linking.
5. **2d — serve everywhere** — default-on the commerce/discovery surfaces; close any remaining publish gaps.

---

## 8. Decisions needed

1. **Storage:** new `product_evidence`/`evidence_artifact` (recommended — clean, cross-vertical) vs. extend `evidence_profile`/`product_enrichment`.
2. **Lab-report trust:** auto-`substantiated` on merchant upload (recommended, with `review_state=observed` + a later review queue) vs. require a Pivota `reviewed` pass first.
3. **First evidence type:** positioning + lab (recommended — long-tail) vs. reviews/press (head).
4. **Gate hardness:** soft tier downgrade only, never a hard audit block (recommended).

---

## 9. First buildable slice — serve-gap P0s (do this first)

These two changes light up the evidence that **already exists** (beauty INCI), proving the serve pipeline end-to-end before any new store/intake. Both are in `pivota-backend`.

### P0-a — expose evidence on the agent PDP API (~1 line + emit)

`routes/agent_pdp_v1.py` — `AGENT_PDP_VIEW_COLUMNS` (lines 25–51) feeds every SELECT via `_SELECT_COLUMNS`/`_SELECT_APV_COLUMNS`, so adding names flows automatically:

```python
AGENT_PDP_VIEW_COLUMNS: Tuple[str, ...] = (
    ...,                       # existing
    "refresh_source",
    # evidence layer (stored via migration 152; was silently dropped here)
    "evidence_profile",
    "required_disclaimers",
    # optional: fashion detail (migration 096) for richer PDPs
    # "material", "care", "size_guide",
)
```

Then in the response builder (`get_agent_pdp`, ~line 328): emit `evidence_profile.claims` **filtered to `substantiation_status == "substantiated"`** plus `required_disclaimers`. The serve gate lives here — never emit `unverified`/`flagged` claims.

### P0-b — publish evidence into the public canonical PDP + JSON-LD

`routes/pivota_canonical_routes.py` — `get_canonical_pdp_by_signature` (162–226) currently reads `catalog_products` only. Add a LEFT JOIN to `agent_pdp_view` on `content_key` (the existing join key) and select the two evidence columns:

```python
.select_from(
    catalog_products
    .join(index_pipeline_state,
          catalog_products.c.content_key == index_pipeline_state.c.content_key)
    .join(catalog_merchants,
          catalog_products.c.merchant_id == catalog_merchants.c.merchant_id)
    .outerjoin(agent_pdp_view,
               catalog_products.c.content_key == agent_pdp_view.c.content_key)
)
# add to select(): agent_pdp_view.c.evidence_profile, agent_pdp_view.c.required_disclaimers
```

Then in `_shape_product_for_pdp` (return dict at line 139) add (substantiated-only):

```python
"evidence_claims": _substantiated_claims(row.get("evidence_profile")),  # [{claim_text, source_ref, evidence_grade}]
"disclaimers": row.get("required_disclaimers") or [],
```

### P0-c — render claims in the agent-visible page + JSON-LD

The API now returns `evidence_claims` + `disclaimers`. In the `agent.pivota.cc/products/{sig}` SSR/frontend (locate the renderer — likely `pivota-agent-ui`):
- **Visible body:** a "Verified claims" section — each claim text + "source: {attribution}" + a grade badge. This is the text agents actually read and cite.
- **schema.org JSON-LD** (`Product`): mirror each substantiated claim as
  ```json
  "additionalProperty": [
    {"@type": "PropertyValue", "name": "verified_claim",
     "value": "<claim_text>",
     "valueReference": {"@type": "WebPage", "url": "<source_ref>"}}
  ]
  ```
  and surface disclaimers in `disambiguatingDescription` / a visible disclaimer block.

**Verification:** after P0-a/b, hit `/api/agent/pdp/{id}` and `/api/canonical/products/{sig}` for a beauty SKU that has an `evidence_profile` → confirm `evidence_claims` appear (substantiated only); load the public PDP → confirm the claims render in body + JSON-LD. This proves the full merchant-evidence→agent pipeline using data that already exists.

> **Open:** confirm the SSR/frontend repo + file that renders `agent.pivota.cc` product pages (the JSON-LD change lands there; the two backend edits are precise).

---

## Appendix — file:line index

- Model: `models/catalog.py:134` (ProductClaim), `:155` (EvidenceProfile)
- Common-core: `services/claim_safety.py` (vocab, normalize_claims, disclaimers)
- Beauty population: `services/beauty_evidence.py` (derive_substantiated_claims, EVIDENCE_GRADE_INGREDIENT), `services/beauty_enrichment_persist.py:114,252`
- Audit hook: `services/agent_center_bd_report_service.py:2110` (_has_substantiation), `:4588` ("Substantiated claims")
- Readiness gate: `services/merchant_audit_readiness.py:62` (blocking vs enhancement gaps)
- Read-model: `services/agent_pdp_view_assembler.py:193,615`; `db/migrations/152_agent_pdp_view_evidence.sql`, `096_*fashion*`, `085_agent_pdp_view.sql`
- Agent PDP API: `routes/agent_pdp_v1.py:25-51` (columns), `:328` (handler)
- Public PDP: `routes/pivota_canonical_routes.py:139` (shaper), `:162-226` (route)
- Serving (PIVOTA-Agent): `src/groundedProductIntel.js:418` (buildEvidenceClaims), `server.js` get_pdp_v2 (~40491), `safety-kernel/src/protocol/canonicalExecutor.js:73` (decision), `acpRestAdapter.js:338` (defaultFeedItem)
- Stage model: `db/merchant_commerce_readiness.py`; `services/merchant_commerce_readiness_service.py`
