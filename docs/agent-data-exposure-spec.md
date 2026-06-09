# Agent Data Exposure Spec — Decision Substrate for the Rail

**Status:** Draft, 2026-06-09
**Companion to:** `docs/next-phase-architecture-brief.md`, `docs/go-live-readiness-checklist.md`
**Principle:** *Project + gate, don't rebuild.* Most of this substrate already exists (relationship graph, Insights KB, catalog facts, offers); it's confined to consumer/chat surfaces. This spec projects it into the agent surface through one extensible contract, and defines how future transaction/CS data plugs into the same contract without redesign.

---

## 0. The core idea: one extensible Signal envelope

Every piece of decision data — a product insight, a relationship edge, a citeable fact, an offer, **and future signals like shipping feedback, merchant reviews, return rate** — is exposed to agents as a **Signal**: a typed, provenance-bearing, confidence-scored unit attached to a subject. Adding a new data class = registering a new `signal_type` + a value schema + a source mapping. **No tool or contract change.** That is the extensibility guarantee.

```jsonc
Signal {
  "signal_type": "why_buy" | "ingredient_fact" | "alternative" | "return_rate" | "shipping_rating" | "...",
  "subject": { "kind": "product" | "offer" | "seller" | "merchant", "id": "sig_..." },
  "value": { /* typed payload, schema per signal_type */ },
  "label": "Fragrance-free, dermatologist-tested",     // optional short human-readable rendering
  "evidence": {
    "grade": "A" | "B" | "C" | "D",
    "confidence": 0.0,                                  // 0–1
    "method": "merchant_reported" | "pivota_measured" | "crawled" | "aggregated_outcomes",
    "sources": [{ "type": "lab|review|retailer|brand|pivota", "ref": "...", "authoritative": true, "url": "..." }],
    "sample_size": 0                                    // required for statistical signals (return_rate, on_time_rate)
  },
  "freshness": { "observed_at": "ISO8601", "fresh_until": "ISO8601" },
  "review_state": "human_approved" | "ai_approved" | "unreviewed",
  "visibility": "buyer_safe" | "merchant_scoped"
}
```

The envelope is the whole design. Tools return collections of Signals (plus standard catalog fields); gates operate on `evidence`/`review_state`/`visibility` uniformly; new data inherits all of it for free.

---

## 1. Subjects (what signals attach to)

| subject.kind | canonical id | example signals |
|---|---|---|
| `product` | `sellable_item_group_id` (`pdp_identity_listing`) | insights, facts, relationships, return_rate(product) |
| `offer` | `offer_id` | price, availability, payment_offer, route |
| `seller` / `merchant` | `merchant_id` | trust, return_rate(merchant), shipping_rating, review_summary, why_buy_direct |

A statistic like return rate exists at both product and merchant grain — same envelope, different `subject`.

---

## 2. Signal-type registry

Current (project from existing tables) and future (the data you're about to build). Adding a row here is how the surface grows.

| signal_type | subject | value shape (abbrev) | source (table) | method | status |
|---|---|---|---|---|---|
| `alternative` | product | `{related_id, relation:'competitive'|'dupe'|'niche', score, price_ratio, tradeoffs[], watchouts[]}` | `relationship_candidate_labels` / `product_relationship_edges` | crawled+measured | **exists, gated off** |
| `related` | product | `{related_id, relation:'complement'|'routine', label}` | `relationship_candidate_labels` (`related_product`) | crawled | **exists, gated off** |
| `why_buy` | product | `{statement, best_for[]}` | `aurora_product_intel_kb` (`why_it_stands_out`,`best_for`) | crawled+measured | **exists, chat-only** |
| `fact` | product | `{field_key, value, unit?}` | `catalog_field_facts` | merchant_reported/crawled | **exists, not on agent PDP** |
| `offer` | offer | `{price, currency, availability, route, payment_offer}` | `catalog_offers`×`product_group_members` | merchant_reported | **partial** |
| `why_buy_direct` | offer/seller | `{statement, vs_channel}` | `readiness_findings` (buyer-safe projection) | measured | exists, internal |
| `return_rate` | product/seller | `{rate, window, sample_size}` | **NEW** — from `decision_outcome` + after-sales | **aggregated_outcomes** | future |
| `shipping_rating` | seller | `{on_time_rate, avg_days, rating, sample_size}` | **NEW** — fulfillment/CS feed | **aggregated_outcomes** | future |
| `merchant_review_summary` | merchant | `{avg_rating, count, themes[], sentiment}` | **NEW** — user reviews on merchant | aggregated_outcomes/crawled | future |
| `dispute_rate` / `cs_responsiveness` / … | seller | `{…, sample_size}` | **NEW** — future | aggregated_outcomes | future |

**The `aggregated_outcomes` class is the proprietary one.** `return_rate`, `shipping_rating`, `merchant_review_summary`, `dispute_rate` are computed from Pivota's *own* transaction + customer-service ground truth (the `decision_outcome` loop + after-sales events). No catalog competitor has them. They are the highest-trust, least-copyable signals you can hand an agent — and they power the decision an agent most needs help with: *which seller, and can I trust this purchase.*

---

## 3. The decision block (inline result enrichment)

So a single `search_catalog`/`get_product` call yields substrate without extra round-trips, each product result gains:

```jsonc
"decision": {
  "fit_for": ["sensitive skin", "fragrance-free"],
  "why": [ /* Signal[] of type why_buy/fact, evidence-graded */ ],
  "best_offer": { /* Signal type offer, + seller trust signals inline */ },
  "seller_trust": { /* return_rate, shipping_rating, review_summary — when available + sample_size met */ },
  "has_alternatives": true,                 // hint; agent calls get_alternatives for the set
  "evidence_summary": { "grade": "B", "weakest": "why_buy:C" }
}
```

Depth is controlled by an `include`/`depth` param (token-budget aware): `standard` returns catalog + `decision.fit_for`/`best_offer`; `deep` inlines `why`/`seller_trust`; relationships always come from the dedicated tools.

---

## 4. Tool surface (additive MCP tools)

| Tool | Input | Returns |
|---|---|---|
| `search_catalog` *(enrich existing)* | query, filters, `depth` | products[] each with `decision` block |
| `get_product` *(enrich existing)* | merchant_id, product_id, `include[]` | product + `decision` + facts[] (Signals) |
| `get_alternatives` | product, `relation?`, `max_price_ratio?` | Signal[] type `alternative` (dupes gated separately) |
| `get_related` | product | Signal[] type `related` (complements/routine) |
| `compare_products` | `[product_ids]`, `dimensions?` | per-product facts + why + best_offer + seller_trust, aligned |
| `get_offers` | product | offer Signals across sellers + **per-offer seller_trust** (price + trust together) |
| `get_seller_trust` | merchant_id | buyer-safe Signal[]: return_rate, shipping_rating, review_summary |
| `explain_recommendation` | product, context | why-this Signals scoped to the stated need, with sources |
| `get_merchant_metrics` *(merchant-scoped)* | merchant_id (authenticated) | appearance/win-loss from `agent_decision_events` — **merchant_scoped only** |

Everything returns Signals, so the agent reasons over typed, cited data (inform mode) or reads the composed `decision` block (decide mode).

---

## 5. Gating rules (uniform — new signals inherit them)

1. **Provenance required.** No Signal reaches an agent without `evidence.sources` (or an explicit `method: pivota_measured` + `sample_size`). No un-sourced claims, ever — this is what keeps Pivota citeable and neutral.
2. **Review-state floor.** Default serve `human_approved` ∪ high-confidence `ai_approved`. **Dupes (`alternative.relation='dupe'`) stay gated** until human-reviewed (highest intent, highest legal/credibility risk).
3. **Statistical minimums.** Any `aggregated_outcomes` signal (`return_rate`, `shipping_rating`, …) must meet a per-type `min_sample_size` before it surfaces; below it, omit (do not show a return rate computed from 5 orders). Always carry `sample_size` + `confidence`.
4. **Freshness.** Past `fresh_until` → omit or downgrade; never present stale stats as current.
5. **Visibility.** `buyer_safe` signals go to shopping agents; `merchant_scoped` (decision metrics, raw audit findings) go only to an authenticated merchant agent. Enforced at the tool boundary, not by convention.
6. **Confidence travels.** Low-confidence is labeled, never laundered into fact. The agent (and the human) must be able to weight it.

These are the same evidence-discipline that fixes the vacuous-audit problem; the agent surface inherits it by construction.

---

## 6. Wiring map (project-not-build)

| Agent field / tool | Source of truth | Work |
|---|---|---|
| `get_alternatives`/`get_related` | `relationship_candidate_labels` → `product_relationship_edges` (serving view) | adapter → Signal; reuse approved+fresh filter; keep `AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED` gate, add agent-surface flag |
| `decision.why`, `fit_for` | `aurora_product_intel_kb` (`pivota.product_intel.v1`: `why_it_stands_out`,`best_for`,`evidence_profile`) | projection into agent API; reuse `requireReviewed` |
| `fact[]` | `catalog_field_facts` | direct map (already source-stamped) → Signal |
| `get_offers`, `best_offer` | `catalog_offers` × `product_group_members` (`aggregate_offers`) | promote existing `offers` block to a tool; fill group coverage (data-work) |
| `why_buy_direct` | `readiness_findings` (buyer-safe subset) | buyer-safe projection of the operational-edge findings |
| `get_seller_trust`, `return_rate`, `shipping_rating`, `merchant_review_summary` | **NEW: a materialized `agent_signal` store** computed by batch jobs over `decision_outcome` + after-sales + reviews | build the aggregation pipeline (§7) |
| `get_merchant_metrics` | `agent_decision_events`/`agent_exposure_events` | merchant-scoped projection |

Two delivery mechanisms: **read-time adapters** for data that already lives in source tables (relationships, insights, facts, offers); a **materialized `agent_signal` store** for the `aggregated_outcomes` class, which must be batch-computed over transaction history.

---

## 7. The outcome→signal pipeline (how the future data lands)

The transaction/CS data closes the loop already in the architecture brief:

```
rail transactions + after-sales/CS events
        → decision_outcome (ground truth)
        → aggregation jobs (per product / per seller, windowed, with sample_size)
        → agent_signal store  (return_rate, shipping_rating, merchant_review_summary, dispute_rate, …)
        → get_seller_trust / get_offers / decision.seller_trust   (gated by min_sample_size)
```

This is the flywheel made literal: **transactions → outcome data → trust/fulfillment signals → better agent decisions → more transactions.** Each new CS/transaction data class is a new aggregation job + a registry row — the agent contract never changes.

---

## 8. Adding a new signal type (the extensibility procedure)

1. Add a row to the §2 registry: `signal_type`, subject, `value` schema, source, `method`.
2. Implement a producer: a read-time adapter (existing table) **or** an aggregation job writing to `agent_signal` (outcome-derived).
3. Set its gate params: `min_sample_size` (if statistical), default `review_state` floor, `visibility`.
4. Done — it flows through the existing tools (`get_seller_trust`, `decision` block, `compare_products`) automatically. No tool schema change.

---

## 9. Sequencing

1. **Project the relationship graph** (`competitive_alternative`, `related_product`) → `get_alternatives`/`get_related`, gated. Highest decision value, mostly wiring. Dupes stay gated.
2. **Project Insights KB + `catalog_field_facts`** → `decision.why`/`fit_for`/`fact[]`, citeable.
3. **Promote offers** → `get_offers`/`compare_products`; begin filling cross-merchant group coverage.
4. **Stand up the `agent_signal` store + first outcome aggregations** (`return_rate`, `shipping_rating`) once the `decision_outcome` loop has volume — this is gated on rail transaction volume, same cold-start as the moat.
5. **Merchant-scoped** `get_merchant_metrics` from the decision layer.
6. Future CS/transaction signals (`dispute_rate`, `cs_responsiveness`, …) drop in via §8.

**Bottom line:** one Signal envelope, a registry, uniform gates. Existing intelligence is projected now; the transaction/CS data you're building becomes the proprietary `aggregated_outcomes` class — and because every data class shares the contract, "add more in the future" is a registry entry, not a redesign.
