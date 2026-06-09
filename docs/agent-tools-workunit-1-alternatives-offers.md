# Work-Unit 1 — `get_alternatives` + `get_offers` (pure projection)

**Status:** Draft spec, 2026-06-09
**Parent:** `docs/agent-data-exposure-spec.md` (Signal envelope + registry)
**Why first:** `get_alternatives` is genuinely pure projection — the relationship serving view, the gated recall function, and the per-edge shape all exist; this is wiring + an adapter, no new intelligence. `get_offers` is a thin backend projection of an `offers` block that already ships in `agent_pdp_view`.

---

## A. Source shapes (verified — do not re-derive)

**Relationship recall (PIVOTA-Agent local DB):** `src/auroraBff/productRelationshipGraph.js:694`
```
listApprovedRelationshipEdgesForAnchor({ anchorType='product', anchorRefs, market='US', relationTypes, limit=120, queryFn })
```
Reads view `product_relationship_edges` (migration 046), already gated:
`label_state IN ('human_approved','ai_approved') AND last_verified_at IS NOT NULL AND expires_at > now() AND NOT (label_state='ai_approved' AND relation_type='dupe')`.
Per-edge fields returned (`mapRowToEdge`): `anchor_ref, candidate_product_ref, candidate_snapshot, relation_type('dupe'|'competitive_alternative'|'niche_specialist'|'related_product'), display_label, score_total[0–1], score_breakdown, price_evidence, source_refs, evidence_grade, why_candidate, tradeoffs, watchouts, label_state, provenance, last_verified_at, expires_at`.
Anchor refs are built from a product via `buildAnchorRefsFromProduct` (pushes `product_id`, `pivota_signature_id`, `external_product_id`, `url`, `brand:name`). **Anchor keys on `anchor_ref` (text), NOT a DB PK.**

**Offer aggregation (pivota-backend):** `services/agent_pdp_view_assembler.py:278` `aggregate_offers(...)`; ships in `agent_pdp_view.offers` (`routes/agent_pdp_v1.py:289`). Per-offer shape: `{merchant_id, merchant_name, price, currency, availability, url, is_primary}`; underlying `catalog_offers` also has `price_confidence, estimated_best_price, merchant_effective_price, list_price`. **Offers key on `product_key`/`product_group_id`.**

**ID caveat:** relationships key on `anchor_ref`; offers key on `product_group_id`/`product_key`. There is **no direct join** — each tool resolves its own key from the product the agent already holds (merchant_id+product_id). `get_alternatives` builds `anchorRefs`; `get_offers` resolves the product group.

**Read tools need no user identity:** in `canonicalContract.js`, set `requiresUserRef:false` (parity with `search_catalog`). The recall does not check identity.

---

## B. Tool 1 — `get_alternatives`

**Intent:** given a product, return its competitive alternatives / niche specialists / complements as Signals (dupes gated — see C).

**Input schema** (add to `INPUT_SCHEMAS`, `mcp-server/src/commerceToolSurface.js`, JSON-Schema style):
```jsonc
get_alternatives: {
  type: "object", additionalProperties: false,
  properties: {
    merchant_id: { type: "string" },
    product_id:  { type: "string" },
    product_ref: { type: "string" },                 // optional: sig_… / url, if the agent has it
    relation: { type: "string",
      enum: ["competitive_alternative", "niche_specialist", "related_product"] }, // NOTE: 'dupe' intentionally absent
    market: { type: "string" },
    max_price_ratio: { type: "number" },             // e.g. 1.0 → only cheaper/equal
    limit: { type: "integer", minimum: 1, maximum: 20 }
  }
}
```

**Output:** `{ subject: {kind:'product', id}, signals: Signal[] }` where each Signal:
```jsonc
{
  "signal_type": "alternative",                       // 'related' when relation_type === 'related_product'
  "subject": { "kind": "product", "id": <anchor product id> },
  "value": {
    "related": {                                      // from candidate_product_ref + candidate_snapshot
      "ref": candidate_product_ref,
      "title": candidate_snapshot.title,
      "brand": candidate_snapshot.brand,
      "price": candidate_snapshot.price,
      "image_url": candidate_snapshot.image_url
    },
    "relation": relation_type,                         // competitive_alternative | niche_specialist | related_product
    "score": score_total,
    "price": price_evidence,                           // price_ratio etc.
    "tradeoffs": tradeoffs,
    "watchouts": watchouts,
    "why": why_candidate
  },
  "label": display_label,
  "evidence": {
    "grade": evidence_grade,                           // A–D
    "confidence": score_total,
    "method": "crawled",                               // graph is crawl+measured
    "sources": source_refs                             // already citeable, carry `authoritative`
  },
  "freshness": { "observed_at": last_verified_at, "fresh_until": expires_at },
  "review_state": label_state,                         // human_approved | ai_approved
  "visibility": "buyer_safe"
}
```
This is a 1:1 field map — every Signal field comes straight off the edge.

**Handler (PIVOTA-Agent local, in `canonicalExecutor`):**
```
1. resolve anchorRefs: if product_ref given → [product_ref]; else build from {merchant_id, product_id}
   (reuse buildAnchorRefsFromProduct; fetch the product snapshot if only ids are given).
2. gate: if !agentRelationshipGraphEnabled() → return { signals: [] } with metadata.reason='disabled'.
3. relationTypes = input.relation ? [input.relation] : ['competitive_alternative','niche_specialist','related_product'].
4. edges = await listApprovedRelationshipEdgesForAnchor({ anchorRefs, market, relationTypes, limit }).
5. if max_price_ratio: drop edges whose price_evidence.price_ratio > max_price_ratio.
6. drop evidence_grade === 'D'; sort by score_total desc; map each edge → Signal (above).
7. return { subject, signals }.
```

---

## C. Gating for `get_alternatives`

- **New agent surface flag** (do NOT reuse the consumer flags): add `agent_alternatives: 'AURORA_BFF_RELATIONSHIP_GRAPH_AGENT_ENABLED'` to `SURFACE_FLAGS` in `src/services/relationshipGraphRecall.js`, so enabling for agents is a deliberate, independent flip from the consumer pilot.
- **Dupes stay gated:** `dupe` is absent from the `relation` enum and from the default relation set, and the recall already blocks `ai_approved` dupes. Net: agents get **no dupes** in v1. (A later, separate gate can expose `human_approved` dupes only.)
- Inherited from the recall: approved + fresh + non-expired only.
- Drop `evidence_grade === 'D'`; carry `grade`/`confidence`/`sources` on every Signal (no un-sourced claims).

---

## D. Tool 2 — `get_offers`

**Intent:** cross-merchant offers for a product (price/availability/merchant). Seller-trust signals (return_rate, shipping_rating) are **future** — `get_offers` carries `seller_trust: null` until the `agent_signal` store exists (Work-Unit later).

**Input schema:**
```jsonc
get_offers: {
  type: "object", additionalProperties: false,
  properties: {
    merchant_id: { type: "string" },
    product_id: { type: "string" },
    product_group_id: { type: "string" },             // if the agent already has it
    currency: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 10 }
  }
}
```

**Output:** `{ subject:{kind:'product', id}, best_offer: Signal|null, signals: Signal[] }`, each offer Signal:
```jsonc
{
  "signal_type": "offer",
  "subject": { "kind": "offer", "id": `${merchant_id}:${product_group_id}` },
  "value": {
    "merchant_id": merchant_id, "merchant_name": merchant_name,
    "price": price, "currency": currency, "availability": availability,
    "is_primary": is_primary, "url": url
  },
  "evidence": { "method": "merchant_reported", "confidence": price_confidence, "sources": [] },
  "freshness": { "observed_at": updated_at, "fresh_until": null },
  "seller_trust": null,                                 // FUTURE: return_rate/shipping_rating Signals
  "visibility": "buyer_safe"
}
```
`best_offer` = the offer with the lowest price in the modal currency (or `is_primary` tiebreak), mirroring `aggregate_offers` ordering.

**Wiring:** `get_offers` is a **backend projection**. `agent_pdp_view.offers` already aggregates this; expose it via a read op (extend the existing `agent_pdp_v1` offers block into an op the canonical executor can call by `product_group_id`, resolving the group from `merchant_id+product_id` via `product_group_members`). Only surface the multi-merchant set when `offer_count > 1`; with a single offer, return it as `best_offer` and an empty competition set (honest — don't imply competition that isn't there).

---

## E. Registration checklist (both tools)

1. **`safety-kernel/src/protocol/canonicalContract.js`** — append to `CANONICAL_OPERATIONS`:
   - `{ id:'get_alternatives', mcp:'get_alternatives', kernel:null, mutating:false, requiresUserRef:false, requiresPaymentAuthz:false }`
   - `{ id:'get_offers', mcp:'get_offers', kernel:'get_offers', mutating:false, requiresUserRef:false, requiresPaymentAuthz:false }`
2. **`mcp-server/src/commerceToolSurface.js`** — add both JSON Schemas to `INPUT_SCHEMAS`; add `toParams()` cases mapping args → params.
3. **`safety-kernel/src/protocol/canonicalExecutor.js`** — add execution branches: `get_alternatives` → local relationship adapter (B); `get_offers` → backend offers projection (D). Both pass through `sanitizeResult` (Signals carry no secrets).
4. **`src/services/relationshipGraphRecall.js`** — add the `agent_alternatives` surface flag (C).
5. **Adapters** — new `src/agentSignals/relationshipEdgeToSignal.js` and `offerToSignal.js` (pure mappers; unit-testable).
6. **`get_offers` backend** — expose the `agent_pdp_view.offers` projection as a callable op keyed by product group.

---

## F. Tests to add (mirror existing patterns)

- `mcp-server` tool tests: both tools appear in `tools/list` with the right schema; `dupe` is rejected by the `get_alternatives` schema; routing reaches the adapter.
- Adapter unit tests: a sample edge → exact Signal (assert `evidence.sources`/`grade`/`review_state`/`freshness` mapped); an `evidence_grade:'D'` edge is dropped; `max_price_ratio` filter works; a `dupe` edge never appears.
- Gate test: with `AURORA_BFF_RELATIONSHIP_GRAPH_AGENT_ENABLED` unset, `get_alternatives` returns empty + `metadata.reason='disabled'` (additive/off-safe).
- `get_offers`: single-offer product → `best_offer` set, empty competition set (no fabricated competition).

---

## G. Scope boundary

In: the two tools, two adapters, registration, the agent surface flag, tests. Pure projection over existing recall + offer aggregation. **Out:** seller-trust/outcome signals (future `agent_signal` store), the inline `decision` block on `search_catalog`, dupe exposure, and filling cross-merchant group coverage (data-work). `get_alternatives` is shippable behind its flag with zero backend changes; `get_offers` needs the one thin backend offers op.
