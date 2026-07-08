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

### P0-c — render claims in the agent-visible page + JSON-LD — ALREADY BUILT, DARK-SHIPPED

**Status: implemented on `main` in both repos and verified live for a pilot — gated off by default. The remaining action is an OPS flag flip, not code.** (The earlier "to-build" plan here was based on a stale `pivota-agent-ui` feature branch; `origin/main` already has it.)

Routing: the rendered `agent.pivota.cc/products/{sig}` page is `pivota-agent-ui`, which fetches `get_pdp_v2` via `/api/gateway` (PIVOTA-Agent) — not the canonical route / agent-PDP API that P0-a/P0-b patched (those still serve direct crawlers of `/api/canonical/products` + `/api/agent/pdp`).

What's already shipped:
- **Backend stamp** (PIVOTA-Agent `main`, #1701 gate + #1702 serve-path): `src/pdpProductIntel.js:2033` stamps a **public-safe** `public_claims` subset + `public_ready` onto the served `product_intel` bundle; the FTC/substantiation filtering is single-sourced in `src/services/pivotaInsightsQuality.js` (lane = KEEP & displayable → `public_ready`). Gated by env `PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED` (default off).
- **Frontend render** (pivota-agent-ui `main`, #250): when the same flag is on, the PDP SSR adds `product_intel` to the server include and `buildProductJsonLd` emits the backend's `core.public_claims` as schema.org `additionalProperty` (active name + claim + citation url) via `_buildGroundedClaimProperties`. The UI is a **dumb renderer** — it does NOT re-derive the gate; it trusts `public_ready` + the pre-filtered `public_claims`.

So the serve gate is single-sourced in the backend (good — matches §4). To go live beyond the pilot:
1. Set `PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED=true` on **both** the PIVOTA-Agent gateway (Railway) **and** pivota-agent-ui (Vercel). Both default off; both must be on (backend to stamp `public_claims`/`public_ready`, frontend to fetch + render).
2. Ensure `PDP_PRODUCT_INTEL_ALLOWLIST` (`src/pdpProductIntel.js:24`, empty = allow all) is broad enough to emit `product_intel` for the target products.

This is a production-exposure decision (publishing merchant grounded claims to all public PDPs + agent surfaces) — flip per the K-beauty pilot rollout, not unilaterally.

**Verify after flip:** load a pilot beauty PDP → confirm `public_claims` appear in the server-rendered `<script type="application/ld+json">` `additionalProperty` (citation urls present) + the visible insights section. (Backend was verified live serving the pilot with `public_ready` + 6 grade-A cited claims.)

---

## 2a — buildable slice: general evidence store + dual-pipeline wiring

**Architecture reality (grounded):** evidence flows through **two independent, beauty-INCI-only pipelines** — 2a wires a general store into both:
- **Serving** (PIVOTA-Agent `get_pdp_v2` → JSON-LD): `src/groundedProductIntel.js` builds the `product_intel` bundle *live* from the reviewed Ingredient KB × the product's INCI. Reads no stored evidence.
- **Audit** (pivota-backend `agent_pdp_view`): `services/agent_pdp_view_assembler.py::fetch_evidence_for_keys` reads `beauty_product_profiles.evidence_profile`.

**Topology — RESOLVED: shared Postgres.** Both repos use `DATABASE_URL`; PIVOTA-Agent runs direct SQL on `products_cache`/`agent_pdp_view` (pivota-backend-owned). → one `product_evidence` table serves both; **no cross-service API**. Schema/migrations owned by pivota-backend; PIVOTA-Agent reads directly.

### Schema (pivota-backend migration)

```sql
CREATE TABLE product_evidence (
  product_key   TEXT NOT NULL,
  geo_code      VARCHAR(16) NOT NULL DEFAULT 'default',
  merchant_id   VARCHAR(100),
  claims        JSONB NOT NULL DEFAULT '[]',  -- ProductClaim[] (claim_safety shape)
  review_state  VARCHAR(32) NOT NULL DEFAULT 'observed',
  required_disclaimers JSONB,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (product_key, geo_code)
);
CREATE INDEX idx_product_evidence_merchant ON product_evidence(merchant_id);

CREATE TABLE evidence_artifact (
  artifact_id   TEXT PRIMARY KEY,
  product_key   TEXT NOT NULL,
  merchant_id   VARCHAR(100),
  kind          VARCHAR(32) NOT NULL,   -- lab_report|certification|review|press|positioning_doc
  source        VARCHAR(32) NOT NULL,   -- merchant_upload|web_crawl
  url_or_blob_ref TEXT,
  captured_at   TIMESTAMPTZ DEFAULT now(),
  extracted_claim_keys JSONB
);
CREATE INDEX idx_evidence_artifact_product ON evidence_artifact(product_key);
```

`claims` uses the `claim_safety.ProductClaim` shape `{claim_text, source_ref, source_type, evidence_grade, substantiation_status}` + `review_state` — the same as `beauty_product_profiles.evidence_profile`, so the two UNION cleanly. A claim's `source_ref` → `evidence_artifact.artifact_id` (attribution + substantiation link).

### Wiring 1 — audit side (pivota-backend), no audit code change

`fetch_evidence_for_keys` UNIONs `product_evidence` with `beauty_product_profiles` (merge `claims`, dedupe by `claim_text`+`source_ref`; keep the existing brand-official/recency precedence) → still writes `agent_pdp_view.evidence_profile`. The audit (`_has_substantiation`) + the #975 surfaces (agent-PDP API, canonical PDP) inherit general evidence automatically.

### Wiring 2 — serving side (PIVOTA-Agent), the one piece of new logic

- In the `product_intel` assembly for `get_pdp_v2`, also fetch `product_evidence` claims (direct SQL, like the `products_cache` reads) and **merge** them into the bundle's claims alongside the KB×INCI claims, before the gate.
- Extend the `public_claims` gate (`src/services/pivotaInsightsQuality.js`) to grade/pass **non-INCI `source_type`s** (positioning/lab/review): drive `public_ready` from `evidence_grade` + `substantiation_status` rather than ingredient-mechanism only. Still: **only `substantiated` → `public_claims`** (the serve gate is unchanged in spirit).

### Readiness evidence tier (informational)

Add an evidence-coverage summary to `assess_merchant_audit_readiness` (count of SKUs with ≥1 substantiated claim) → the portal's "evidence tier" (G1). Reuses the readiness service; never blocks.

### Scope boundary

- **2a includes:** the two tables + both read-wirings + readiness tier. **Seed-tested** — insert `product_evidence` rows directly; assert they reach the audit (`/api/audits/readiness`, the audit report) and serving (`get_pdp_v2` `public_claims` → PDP JSON-LD).
- **Defers:** merchant write UI → 2b; crawl + substantiation engine → 2c.

### Decisions (narrowed)

1. ~~Store location~~ — **resolved: shared DB, one table.**
2. Merge precedence in `fetch_evidence_for_keys` — recommend **UNION + dedupe** (both INCI and merchant evidence contribute), not prefer-one.
3. The `pivotaInsightsQuality` generalization is the real new logic — grading rules for non-ingredient claim types (positioning/lab/review → grade/public_ready). This is where to focus review.

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
