# Pivot Agent Contract v1

## Current Problem Inventory

The current Aurora, Shopping, and Creator entry points expose different internal chains instead of one stable Pivot contract. The observed production behavior is therefore inconsistent:

- Aurora Chat mixes routing, profile/session memory, travel/weather, skin/product/routine logic, ingredient KB, upstream LLM calls, recommendation enrichment, and shared-truth Shopping calls. A travel skincare turn can be captured by beauty recommendation or ingredient routes, then return empty text, a confidence notice, or a slow response.
- Shopping `find_products_multi` can return a valid 200 while the main product recall path is slow. The latest production run showed `agent_products_beauty_external_seed_mainline` returning products, but the primary path itself took 9-29s because the SQL did not reliably use a narrow recall index.
- Creator adds creator scope, direct recall, and category tree loading. Beauty/skincare requests can diverge from Shopping because the creator route has its own recall/filter/category path.
- Aurora shared-truth enrichment called Shopping from content replies too broadly. This let Shopping latency leak into Aurora content turns.
- LLM calls are not one uniform dependency. Aurora Chat, analysis, product analyze, travel calibration, final rewrite, and ingredient research all have separate budgets and failure modes; Shopping/Creator may not invoke LLM at all for direct recall.

### Agent-Specific Failure Modes

| Surface | Failure mode | User impact | Contract requirement |
| --- | --- | --- | --- |
| Aurora Chat | Beauty/travel follow-ups can route to ingredient report, generic reco, nudge-only, or empty text. | The user loses conversation context and receives the wrong advice. | Active travel, routine, skin-analysis, and product-fit state wins before generic ingredient/recommendation routing. |
| Aurora Shared Truth | Content turns can synchronously call Shopping even when the user only needs explanation. | Aurora latency inherits product-search latency and may time out. | Product enrichment is eligible only for explicit product/recommendation tasks or product cards. |
| Shopping | Broad seed query can miss the narrow index and spend 9-29s in the mainline. | Products arrive too late or request times out. | Beauty direct recall uses indexed intent/category/tool scope with a hard latency budget. |
| Shopping | Product fallback can return 200 with empty products. | A failed recommendation looks successful to clients. | Empty fallback is `degraded` or `failed`; it is never `success`. |
| Shopping | Product class and safety gates are inconsistent. | Sunscreen can return serum; pregnancy can return retinoid; rosacea can return menthol/scrub cleanser. | Product class and contraindication gates run before ranking and before response. |
| Creator | Creator scoped recall and category tree have separate slow paths. | Creator output diverges from Shopping or category endpoint aborts. | Creator uses the same beauty recall, class gate, safety gate, and bounded category loading rules. |
| Product Analyze | Name-only or ingredient-only payloads can 500. | Product-fit workflows break before the agent can answer. | Catalog/deepscan misses produce deterministic degraded analysis, not a server error. |
| LLM Enrichment | Different surfaces call different providers/prompts with different budgets. | Stability appears random across agents. | LLM is bounded enrichment with explicit call telemetry; deterministic route/safety decisions do not depend on LLM completion. |

## Contract Goal

External callers should integrate with `pivota-agent` through a stable Pivot contract. Aurora, Shopping, and Creator are adapters behind the contract, not separate sources of truth for intent, safety, schema, or failure semantics.

The same user intent, profile, locale, market, creator scope, and conversation state must produce:

- the same route authority,
- the same response envelope shape,
- bounded latency behavior,
- consistent safety gates,
- consistent product class and contraindication filtering,
- explicit degraded or failed states when the mainline cannot satisfy the request.

Fallback is allowed only as a visible degraded state. It must not be counted as a successful mainline recommendation.

## Status Semantics

`success` means the mainline satisfied the contract:

- content tasks returned non-empty `assistant_text`;
- product tasks returned relevant products from the expected product class;
- safety gates ran and no contraindicated products were returned;
- required metadata is present.

`degraded` means the request completed but one or more optional layers were skipped or timed out:

- LLM rewrite timed out after deterministic content was already available;
- upstream enrichment failed after direct product recall succeeded;
- partial category tree was returned within the bounded load budget.

`failed` means the mainline could not satisfy the user task:

- product recall returned no relevant products;
- safety gate removed all candidates;
- required schema fields could not be produced;
- the deterministic content path could not produce a non-empty answer.

A 200 HTTP response may carry `status=degraded|failed` for client-displayable failures, but test and reporting gates must not count those as successful agent output.

## Request Contract

Every adapter request should normalize into:

```json
{
  "pivot_contract_version": "pivot.agent.v1",
  "request_id": "string",
  "conversation_id": "string",
  "user_id": "string|null",
  "locale": "CN|EN",
  "market": "US",
  "creator_id": "string|null",
  "intent": {
    "domain": "beauty",
    "task": "travel|routine|skin_analysis|product_fit|product_recommendation|category_browse",
    "confidence": 0.0,
    "route_authority": "pivot_router|aurora_chat|shopping_agent|creator_agent"
  },
  "profile": {
    "skin_type": "string|null",
    "sensitivity": "string|null",
    "barrier_status": "string|null",
    "goals": [],
    "current_actives": [],
    "travel_plan": {}
  },
  "constraints": {
    "budget": "low|mid|high|null",
    "avoid": [],
    "must_have": []
  }
}
```

## Response Contract

Every adapter response should expose:

```json
{
  "pivot_contract_version": "pivot.agent.v1",
  "status": "success|degraded|failed",
  "route_authority": "aurora_chat|shopping_agent|creator_agent|pivot_router",
  "assistant_text": "string",
  "cards": [],
  "products": [],
  "follow_up_questions": [],
  "safety": {
    "risk_level": "none|info|warn|block",
    "rules_applied": [],
    "contraindications_blocked": []
  },
  "metadata": {
    "query_source": "string|null",
    "creator_id": "string|null",
    "decision_authority": "string|null",
    "mainline_latency_ms": 0,
    "llm_calls": [],
    "degraded_reason": "string|null",
    "request_id": "string"
  }
}
```

## Product Recommendation Contract

Product recommendation output must include enough structure for automated and human review:

```json
{
  "products": [
    {
      "product_id": "string",
      "merchant_id": "string",
      "title": "string",
      "url": "string|null",
      "image_url": "string|null",
      "price": {},
      "product_class": "sunscreen|cleanser|moisturizer|serum|repair|travel_kit|other",
      "relevance_reasons": [],
      "safety_flags": [],
      "local_authority": {
        "brand_origin_country": "string|null",
        "brand_home_market": "string|null",
        "available_markets": [],
        "local_purchase_markets": [],
        "retailer_region": "string|null",
        "authority_source": "pdp|merchant|seed|manual_override|null"
      },
      "fit_attributes": {
        "spf_rating": "string|null",
        "pa_rating": "string|null",
        "texture": "gel|cream|fluid|stick|cushion|lotion|null",
        "finish": "matte|dewy|natural|null",
        "fragrance_free": "boolean|null",
        "alcohol_denat": "boolean|null",
        "non_comedogenic": "boolean|null",
        "travel_size": "boolean|null"
      },
      "creator_rank": {
        "creator_inventory_match": "boolean|null",
        "creator_boost_applied": "boolean|null",
        "commercial_boost_applied": "boolean|null",
        "rank_reasons": []
      },
      "source": {
        "query_source": "string",
        "tool_scope": "creator_agents|shopping_agents|*|",
        "recall_category": "string|null"
      }
    }
  ]
}
```

Top results must be filtered before ranking:

- sunscreen/SPF queries require `product_class=sunscreen`;
- cleanser queries require `product_class=cleanser`;
- barrier/moisturizer/repair queries require `product_class=moisturizer|repair`;
- travel repair kit queries require travel-compatible size or portable/repair intent;
- creator scoped queries require `creator_id` and creator/source metadata to survive response shaping.

### Travel And Local Product Authority

Travel-local product claims must come from catalog/PDP authority fields, not from LLM inference. The LLM may explain why a product fits a trip, but it must not invent brand origin or local availability.

Required product-intel fields for strict travel/local ranking:

- `brand_origin_country`, `brand_home_market`, `merchant_market`, `retailer_region`, `retailer_country`;
- `available_markets`, `local_purchase_markets`, `ship_to_market`, `offline_availability_region`;
- `authority_source` and `authority_confidence` so PDP extraction, merchant config, external seed, and manual override can be distinguished;
- beauty fit fields such as `spf_rating`, `pa_rating`, `texture`, `finish`, `fragrance_free`, `alcohol_denat`, `non_comedogenic`, `travel_size`, and `sensitive_safe`.

For a Seattle -> Seoul sunscreen request, a product can be described as "good to buy in Seoul" only when `local_purchase_markets` or equivalent authority includes Korea/KR/Seoul, or the brand home market is Korea with a known Korea retail path. Title tokens like `Birch`, `Dokdo`, or `Mugwort` may be used as weak ranking hints, but they are not sufficient authority for a local-purchase claim.

### Strict Display Quality Gates

Strict ranking is not enough when weak candidates can still leak into the visible top results. Beauty contract display shaping must apply deterministic quality gates after recall, class filtering, safety exclusion, and dedupe:

- sensitive brightening/serum requests should suppress high-strength actives such as `Niacinamide 10% + Zinc`, high-percentage L-AA, or fragranced/alcohol-heavy active serums when at least four gentler alternatives remain;
- pregnancy/trying-to-conceive requests should suppress vague anti-aging or firming products unless the product has explicit pregnancy-safe, retinol-free, or ingredient-level safe evidence such as SPF, azelaic acid, low-strength niacinamide, peptides, ceramides, or panthenol;
- barrier/moisturizer results should cap repeated near-identical repair cream signatures in the top display when distinct safe alternatives exist, so the top set is not dominated by duplicate ceramide/panthenol creams.

These gates do not rescue an unsafe result. They only decide whether a weak but otherwise class-matching candidate is allowed into the visible recommendation set. If enough better candidates do not exist, the system may keep the weaker candidate but must not label it with unsupported safety or local-authority claims.

### Creator Ranking Overlay

Shopping and Creator share the same recall, product class gate, and safety exclusion gate. Creator may then apply an additional bounded ranking overlay, but only after a candidate has already passed relevance and safety.

Creator overlay inputs:

- creator-carried inventory or storefront membership;
- creator preference tags, audience tags, and creator-specific exclusions;
- approved affiliate or commission fields;
- creator locale/market and historical performance signals.

Contract rules:

- commercial boost is feature-flagged and capped; it cannot promote a class-mismatch or contraindicated product;
- creator-carried and creator-pick boosts can reorder equally relevant safe products, but cannot replace the shared beauty gate;
- responses expose `creator_rank_overlay`, `creator_boost_applied`, `commercial_boost_enabled`, and rank reasons so audits can explain why Creator differs from Shopping.

## Safety Contract

Safety rules are deterministic gates, not prompt suggestions:

- pregnancy, trying-to-conceive, or possible pregnancy blocks retinol, retinoid, tretinoin, retinal, adapalene, HPR, and equivalent aliases;
- rosacea, heat-triggered redness, or sensitive cleanser requests block menthol, mint, cooling, scrub, peeling, strong cleanse, and harsh exfoliating claims;
- barrier damage, stinging, peeling, or over-exfoliation blocks recommendations to continue acids/exfoliation and prioritizes cleanser/moisturizer/repair;
- overstacking BPO, salicylic acid, vitamin C, retinoid, and exfoliating acids requires frequency reduction and stop-if-irritated guidance;
- medical boundary copy appears when symptoms suggest persistent disease, pregnancy, infection, severe reaction, or diagnosis.

The response must expose `safety.rules_applied` and `safety.contraindications_blocked` so batch tests can distinguish safe empty results from retrieval misses.

## LLM Stability Contract

LLM calls must be observable, bounded, and non-authoritative for deterministic decisions:

```json
{
  "provider": "openai|gemini|none",
  "purpose": "rewrite|analysis_summary|travel_copy|ingredient_research|product_fit_copy",
  "model": "string|null",
  "timeout_ms": 4000,
  "status": "success|timeout|skipped|failed",
  "latency_ms": 0
}
```

Rules:

- route authority, safety blocking, product class filtering, and schema shape are decided before optional LLM rewrite;
- timeout returns deterministic output plus `llm_calls[].status=timeout`;
- provider failure cannot turn deterministic content into empty text;
- Shopping and Creator direct recall should not require LLM for common beauty categories.

## Stability Rules

- `assistant_text` must be non-empty for content tasks.
- Product tasks must return either relevant products from the mainline path or `status=failed|degraded` with a reason. Empty fallback is not success.
- Travel/routine/skin/product-fit follow-ups must inherit active context before generic ingredient or recommendation routing.
- LLM calls are bounded enrichment. They cannot own route authority, block deterministic responses past budget, or rewrite a safety decision.
- Product class gates are mandatory: sunscreen queries return SPF/sunscreen, cleanser queries return cleanser, barrier/moisturizer queries return barrier/moisturizer.
- Safety exclusion gates are mandatory: pregnancy excludes retinoids; rosacea/sensitive cleanser excludes menthol/mint/cooling/scrub/strong cleanse; barrier damage excludes exfoliating-acid pushes.
- Cross-agent product metadata must include `query_source`, `decision_authority`, `route_health`, and `creator_id` when scoped.
- Cross-agent tests must evaluate semantic success from `status`, product relevance, safety, and schema, not HTTP 2xx alone.

## Latency Budgets

- Aurora deterministic content response: target < 8s, hard budget < 15s.
- Shopping direct beauty recall: target < 3s, hard budget < 8s.
- Creator direct beauty recall/category: target < 3s, hard budget < 8s.
- LLM enrichment: target < 4s and optional; timeout returns deterministic output with `llm_calls[].status=timeout`.

## Adapter Responsibilities

- Aurora owns content, context inheritance, safety-first wording, and travel/routine/analysis/product-fit explanations.
- Shopping owns product recall, class relevance, safety exclusions, and product metadata.
- Creator owns creator-scoped product recall and category surfaces, but must use the same class and safety gates as Shopping.
- Pivot owns normalized intent, route authority, response status semantics, and cross-agent reportability.

## Required Observability

Every response should expose or log, without secrets:

- `request_id`, `conversation_id`, `user_id` hash or stable UID, locale, market, and creator scope;
- normalized task, route authority, and decision authority;
- status, degraded reason, failure class, and route health;
- product query source, recall category, tool scope, candidate count before/after class gate, and candidate count after safety gate;
- LLM call purpose, provider, model, status, latency, and timeout;
- mainline latency, upstream latency, and total latency;
- schema validation result and contract version.

Reports must redact authorization headers and API keys.

## Contract Test Matrix

The shared beauty casepack must exercise the contract across all three internal agents:

| Case family | Aurora requirement | Shopping requirement | Creator requirement |
| --- | --- | --- | --- |
| Travel hot/humid acne | Bangkok maps to humid/UV advice; non-empty text; no thick occlusive push. | Lightweight sunscreen/moisturizer class relevance. | Same beauty category, no apparel drift. |
| Travel cold/dry flight sensitive | Flight/low humidity/barrier-first advice; active frequency reduction. | Gentle repair kit, cleanser/moisturizer/sunscreen. | Same repair/travel category. |
| Routine beginner dry budget | Minimal AM/PM routine and SPF. | Low-budget cleanser/moisturizer/sunscreen relevance. | Creator products stay skincare. |
| Active conflict acne | Stop overstacking and schedule actives. | Fill gaps without pushing more irritants. | Same product classes. |
| Skin analysis missing SPF | SPF gap and no invented PM products. | Non-comedogenic sunscreen direction. | Category recall supports sunscreen. |
| Barrier damage | Stop acids and repair barrier. | Gentle cleanser/repair cream, no acid push. | Same safety exclusion. |
| Product fit vitamin C sensitive | High-risk fit verdict, patch test, gentle alternatives. | Mild brightening alternatives. | No category drift. |
| Product fit pregnancy retinol | Retinoid caution and medical boundary. | Retinoid-free alternatives only. | Retinoid exclusion holds. |
| Oily sunscreen alcohol | Balanced alcohol explanation. | Sunscreen class only. | Sunscreen class only. |
| Rosacea cleanser | Reject mint/cooling/strong cleanse. | Gentle cleanser only, no menthol/mint/scrub. | Same exclusion. |

## Rollout Order

1. Apply the production recall index from `docs/runbooks/pivot_beauty_contract_prod_index.md`; it is intentionally not an app auto-migration because it must use `CREATE INDEX CONCURRENTLY`.
2. Enable `PIVOT_BEAUTY_CONTRACT_V1_ENABLED=true`, `PIVOT_BEAUTY_LEGACY_FALLBACK_ISOLATION_ENABLED=true`, `PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED=true`, and `PIVOT_BEAUTY_STRICT_RECO_QUALITY_ENABLED=true`.
3. For Creator ranking differentiation, enable `PIVOT_BEAUTY_CREATOR_CURATION_RANKING_ENABLED=true`; keep `PIVOT_BEAUTY_CREATOR_COMMERCIAL_RANKING_ENABLED=false` until affiliate/commission fields are audited.
4. Validate deterministic contract tests locally.
5. Deploy to production canary, verify the deployed commit, then run the full beauty casepack with production keys injected only through environment variables.
6. Compare request-level telemetry by contract fields, not by free-form text only.

Emergency off:

- set `PIVOT_BEAUTY_CONTRACT_V1_ENABLED=false` to disable contract stamping and fallback isolation;
- set `PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED=false` to bypass the direct indexed beauty recall path;
- set `PIVOT_BEAUTY_STRICT_RECO_QUALITY_ENABLED=false` to disable the strict product-quality rank/display overlay without changing recall;
- set `PIVOT_BEAUTY_CREATOR_CURATION_RANKING_ENABLED=false` to make Creator use the shared Shopping order after safety/class gates;
- set `PIVOT_BEAUTY_LEGACY_FALLBACK_ISOLATION_ENABLED=false` only if fallback adoption must be temporarily restored during incident response.

## Validation Gates

Production canary passes only when:

- HTTP 2xx success rate >= 95%.
- Schema violations = 0.
- High-risk safety assertions = 100%.
- Shopping/Creator top 6 contain at least 4 target-class products.
- No contraindicated products appear.
- No `agent_products_error_fallback` or timeout fallback is counted as success.
- Aurora content turns have non-empty text and correct route authority for travel/routine/skin/product-fit follow-ups.
