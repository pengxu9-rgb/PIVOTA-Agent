# `find_products_multi` – Recommendation Signals (Gateway Policy)

This document describes the **server-side** guardrails added to `operation="find_products_multi"` to prevent cross-domain mismatches (e.g. returning Labubu doll clothes for a human outerwear request).

## Compatibility

- **RawProduct top-level fields are unchanged.**
- Additional metadata is returned at the **top level** of the `find_products_multi` response.
- Product tagging is injected under `product.attributes.pivota` (namespaced), without changing any required RawProduct fields.

## Added Response Fields (Top Level)

The gateway may attach these fields to the existing response (alongside `products` and `reply`):

- `intent`: a structured intent object (PivotaIntentV1, version `1.0`)
- `filters_applied`: explainable, UI-friendly filters inferred from intent
- `match_confidence`: `number` in `[0..1]`
- `has_good_match`: `boolean` (“better no than bad” decision bit)
- `match_tier`: one of `none | weak | good | great`
- `reason_codes`: array of strings for UI routing / logging
- `debug_stats` (optional; gated by `FIND_PRODUCTS_MULTI_DEBUG_STATS=1`)

## Intent Schema

PivotaIntentV1 is validated by a strict schema stored in:

- `pivota-agent-backend/src/schemas/intent.v1.json`

The gateway may generate intent via:

- Rule-based extraction (default)
- LLM extraction (optional; controlled by `FIND_PRODUCTS_MULTI_LLM_ENABLED`)

### LLM Provider Configuration

Runtime enablement is controlled by a single owner:

- `FIND_PRODUCTS_MULTI_LLM_ENABLED`
  - `false`: disable shopping LLM features
  - unset: auto-enable when at least one provider key is present

Provider selection is resolved centrally:

- `FIND_PRODUCTS_MULTI_LLM_PROVIDER`
- `FIND_PRODUCTS_MULTI_LLM_FALLBACK_PROVIDER`
- `FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_PROVIDER`
- `FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_FALLBACK_PROVIDER`

Default provider order:

- semantic rewrite: Gemini primary, no implicit fallback
- rerank: Gemini primary, OpenAI fallback

For Aurora beauty strict semantic-contract discovery, semantic rewrite is locked to a single backend provider so the main path does not cascade across multiple provider owners.
Semantic rewrite no longer inherits provider config from `PIVOTA_INTENT_LLM_PROVIDER` or `PIVOTA_INTENT_LLM_FALLBACK_PROVIDER`.

OpenAI:

- `OPENAI_API_KEY` (required if provider is `openai`)
- `OPENAI_BASE_URL` (optional; OpenAI-compatible endpoint)
- `FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_MODEL_OPENAI` (default: `gpt-5.1-mini`)

Gemini:

- `GEMINI_API_KEY` (required if provider is `gemini`)
- `GEMINI_BASE_URL` (optional; default: `https://generativelanguage.googleapis.com`)
- `FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_MODEL_GEMINI` (default floor: `gemini-3-flash-preview`)

Semantic rewrite no longer inherits model config from `PIVOTA_INTENT_MODEL` or `PIVOTA_INTENT_MODEL_GEMINI`.

Rerank models:

- `PIVOTA_RERANK_MODEL_OPENAI` (falls back to the legacy shared `PIVOTA_RERANK_MODEL`, then the built-in default `gpt-5.1-mini`)
- `PIVOTA_RERANK_MODEL_GEMINI` (default floor: `gemini-3-flash-preview`)
- `PIVOTA_RERANK_LLM_TIMEOUT_MS` (default 2500, max 15000): ONE deadline for the whole provider chain, not per provider

Provider availability is decided by `llmRuntime.js` from API-key env vars only. A Gemini setup that relies on
Vertex ADC with no Gemini key set does not count as available there, so the chain can resolve to OpenAI alone.

### Model-unavailable breaker

The built-in OpenAI defaults are not guaranteed to exist on every OpenAI-compatible endpoint. When a provider
answers that the configured model does not exist (HTTP 404, `model_not_found`, or a 400 naming the model), the
breaker in `src/findProductsMulti/llmModelBreaker.js` skips that provider and model for the rest of the process.
It logs one WARN, `find_products_multi llm model unavailable; provider skipped for this process (logged once)`,
with `feature`, `provider`, `model` and `env_hint` (the env var to change). Rerank and semantic rewrite share
it, because a missing model is missing for both.

While it is open:

- rerank returns `{ applied: false, skipped_reason: 'model_unavailable' }` without calling the provider. The
  search keeps its deterministic order, so no product is dropped or reordered.
- semantic rewrite falls back to the rule-based intent, with `llm_error_class: 'model_unavailable'`.

Timeouts, 429 and 5xx responses never open the breaker. To turn the pass back on, set the model env var named
in the WARN to a model the endpoint serves and redeploy.

## `attributes.pivota` Product Tags

When returning product results, the gateway injects (or preserves) the following structure:

```json
{
  "attributes": {
    "pivota": {
      "version": "ann_v1",
      "domain": { "value": "human_apparel", "confidence": 0.9, "source": "rule_v1" },
      "target_object": { "value": "human", "confidence": 0.95, "source": "rule_v1" },
      "category_path": { "value": ["human_apparel", "outerwear"], "confidence": 0.75, "source": "rule_v1" }
    }
  }
}
```

MVP tagging is derived from `title + description + (stringified attributes/options/variants)` using strong keywords.

## Strong Filtering Rules (MVP)

When intent indicates **human apparel** (or `target_object.type=human`), the gateway applies strong filtering:

- Drop items whose inferred `attributes.pivota.domain.value` is not `human_apparel`
- Drop items whose inferred `attributes.pivota.target_object.value` is not `human`
- Drop items containing excluded keywords from intent (e.g. `Labubu`, `doll`, `toy`, `娃娃`, `公仔`, `娃衣`)
- Apply a coarse category signal check based on `intent.category.required`

If filtering removes all candidates, the gateway returns:

- `products: []` (or equivalent array field)
- `has_good_match=false`, `match_tier=none`
- `reason_codes` includes `NO_DOMAIN_MATCH` and `FILTERED_TO_EMPTY`

## Match Quality Metrics (MVP)

Computed over the top `M=20` (or fewer) of the final sorted list:

- `hard_match_count_top20`
- `distractor_ratio_top20` = non-hard-match / M

`has_good_match` is conservative:

- `has_good_match = (hard_match_count_top20 >= 3) AND (distractor_ratio_top20 <= 0.15)`

`match_tier`:

- `none`: hard match count = 0 or distractor ratio > 0.5 (or list empty)
- `weak`: hard match count in [1, 2] (or other borderline cases)
- `good`: hard match count >= 3 and distractor ratio <= 0.15
- `great`: hard match count >= 6 and distractor ratio <= 0.1

`match_confidence` (rule-based):

```
domain_purity = 1 - distractor_ratio_top20
hard_coverage = clamp(hard_match_count_top20 / 3)
availability = clamp(in_stock_hard_match_count_top20 / 3)

match_confidence =
  0.40*domain_purity +
  0.40*hard_coverage +
  0.20*availability
```

## `reason_codes`

Used for UI routing, diagnostics, and AB experiments.

- `NO_DOMAIN_MATCH`: candidates are mostly outside the target domain/object
- `FILTERED_TO_EMPTY`: strong filter removed all candidates
- `WEAK_RELEVANCE`: some matches exist but below threshold to recommend confidently

## Debug Stats

Enabled by setting:

- `FIND_PRODUCTS_MULTI_DEBUG_STATS=1`

Fields:

- `candidate_count_before_filter`
- `candidate_count_after_filter`
- `hard_match_count_top20`
- `distractor_ratio_top20`

## Discovery / Chitchat Routing

When intent indicates `scenario.name = "discovery"` (user hasn't expressed a shopping goal yet),
the gateway short-circuits catalog search and returns:

- `products: []`
- `has_good_match=false`, `match_tier=none`
- `reason_codes` includes `NEEDS_CLARIFICATION` and `CHITCHAT_ROUTED`
- `reply` contains a guided question to steer the user into a concrete shopping or browsing intent
