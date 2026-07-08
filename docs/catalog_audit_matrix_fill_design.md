# Catalog-audit driver: converting catalog-coverage supply → citation matrix

*2026-06-30. Design for the "fill the matrix" step. Scoped, not built. Decision:
don't spend audit credits to re-prove the known loop on demo data; design the real
lever instead.*

## The structural finding (why "grow coverage" didn't auto-fill the matrix)

The catalog-coverage engine grows **supply**: `external_seed` canonical anchors —
**5,480 depositable** product rows now. But `citation_observations` (the matrix) is
fed by **audit runs**, and:

- An audit run targets a `merchant_id` + `product_keys`; the deposit
  (`persist_canonical_evidence` in `services/audit_evidence_builder.py`, triggered by
  `audit_run_worker.py:678` on completion) resolves *that run's* product_keys against
  `catalog_row_trust` and deposits the depositable ones.
- `external_seed` is **not** a normal audit target, and almost no *connected* merchant
  has depositable SKUs (only ~16: the #1733 demo snowboards + the BB Lab merchant).

So coverage growth alone doesn't fill the matrix — an **audit** has to reference the
depositable products. The bridge is `content_key` (deterministic
`sha256(brand|title|gtin)`): onboarding a brand makes *any* future audit of its
products deposit, anchored to the canonical row.

## Current matrix state (measured 2026-06-30, corrects the stale snapshot)

`citation_observations`: **607 observations, 44 distinct products, 113 distinct hosts.**
Live and growing — NOT the near-empty 35/1/1 the earlier memory recorded. So ~44 of
thousands of depositable products have matrix data → large headroom, and the loop
already works; the task is **scale**, not bootstrap.

## The discovery: the audit path for non-tenant brands ALREADY exists

`audit_runs_routes` documents two subject types: *"merchant (self-audit) or **cold_start
(BD prospect)**"*. There is a built `cold_start` path:
- `routes/agent_center_bd_routes.py::cold_start_audit` (BD-employee auth) →
  `services/bd_cold_start_service.discover_products_for_audit(url, max_products=3, …)`.
- Cold-start prospects *"have no merchant_id, no Shopify OAuth, no PSP connection"*
  (verbatim) — exactly our constraint.
- It takes a **brand URL** → discovers products → creates an audit_run → the **same**
  `audit_run_worker` → `persist_canonical_evidence` → **deposits** `citation_observations`.

Billing is not a blocker: the credit **debit happens at the merchant self-audit route**,
not in `enqueue_audit_run` or the cold_start path (the worker only *refunds*). The worker
tolerates a missing merchant (`get_merchant_onboarding(merchant_id) or {}`). So auditing a
brand needs **no wallet**.

**Conclusion: the "catalog-audit path" is not a new pipeline — it's a DRIVER over the
existing cold_start path,** feeding the brands the coverage engine onboarded.

## Build plan

### P0 — spike / de-risk (~1 audit, the credit-spend deferred earlier)
Run ONE cold_start audit on `kosas.com` (a brand we onboarded) and verify:
1. it completes through `audit_run_worker`;
2. it **deposits** `citation_observations`;
3. the deposits **anchor to our canonical kosas `content_key`s** (depositable), not orphan
   external rows — i.e. confirm the engine→matrix bridge actually closes.

Gate the build on this. Likely cost: discovery + a few SKUs × Gemini (cheapest).

### P1 — the driver (mirrors the onboard queue/scheduler we just built)
- Select onboarded brands **not recently cold_start-audited**, ordered by
  `competitor_recurrence.recurrence_rank` (audit highest-demand brands first).
- Enqueue cold_start audits in **batches**, Gemini provider, Pivota-absorbed,
  **gated OFF by default**, per-tick **cost cap**.
- Idempotency (don't re-audit within a window) + a **matrix-coverage metric**
  (brands audited / brands onboarded; products in matrix / depositable products).
- Reuse the `catalog_onboard_queue` + `audit_scheduler` patterns verbatim.

### P2 — cadence / freshness
Periodic re-audit to keep the matrix fresh; coverage dashboard on the employee portal
(extends the Channel Graph).

## Why this matters beyond the matrix — the BD "Act" half falls out of it

`cold_start` is the **BD-prospecting** tool (subject_type = BD prospect). So the catalog-
audit driver simultaneously (a) **fills the matrix** and (b) **generates BD prospect
intelligence** — who cites each brand, across which channels → the exact outreach targets
the BD-channel direction wants. This is the bridge from catalog-coverage (supply) to the
unbuilt **`merchant_channel_outreach` tracker** (demand). Building the driver seeds the BD
CRM with real per-brand, per-channel citation data. One engine, two products.

## Open questions to resolve in P0
- What `merchant_id`/subject does a cold_start audit assign, and does the deposit resolve
  it against our canonical `content_key`s (or does it create its own external rows that
  must first be resolved by the now-live resolver tick)?
- `discover_products_for_audit` defaults `max_products=3` — for a full-catalog audit, raise
  it or pass our pre-enumerated anchor URLs/keys.
- Cost per cold_start audit (discovery LLM + probes) → the P1 budget model.
- Dedup: ensure cold_start's discovered products map onto our canonical anchors (shared
  deterministic `content_key`) rather than spawning duplicate external rows.

## Effort
P0 ≈ a focused spike (hours). P1 ≈ the onboard-queue build again, mostly reuse (~1–2 days).
P2 ≈ incremental.
