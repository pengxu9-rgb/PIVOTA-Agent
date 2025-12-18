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
- LLM extraction (optional; enable with `PIVOTA_INTENT_LLM_ENABLED=true`)

### LLM Provider Configuration (OpenAI primary, Gemini fallback)

The intent extractor supports a primary + fallback provider:

- `PIVOTA_INTENT_LLM_PROVIDER` (default: `openai`)
- `PIVOTA_INTENT_LLM_FALLBACK_PROVIDER` (default: `gemini`)

OpenAI:

- `OPENAI_API_KEY` (required if provider is `openai`)
- `OPENAI_BASE_URL` (optional; OpenAI-compatible endpoint)
- `PIVOTA_INTENT_MODEL` (default: `gpt-5.1-mini`)

Gemini:

- `GEMINI_API_KEY` (required if provider is `gemini`)
- `GEMINI_BASE_URL` (optional; default: `https://generativelanguage.googleapis.com`)
- `PIVOTA_INTENT_MODEL_GEMINI` (default: `gemini-1.5-flash`)

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
