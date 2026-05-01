# Product Seed Fit Accuracy Benchmark

This benchmark validates product understanding and cross-agent recommendation grounding against known seed product records. It is separate from skin photo recognition accuracy.

Seed pack:

```bash
datasets/product_seed_fit_accuracy_seed.json
```

It tests:

- `/v1/product/analyze`
- `/v1/chat` product-fit follow-up
- `/agent/shop/v1/invoke` with `find_products_multi`
- `/agent/creator/v1/invoke` with `find_products_multi`

## Offline Scoring

Store raw responses as:

- `<responses-dir>/<case_id>/product_analyze.json`
- `<responses-dir>/<case_id>/chat.json`
- `<responses-dir>/<case_id>/shopping.json`
- `<responses-dir>/<case_id>/creator.json`

or:

- `<responses-dir>/<case_id>_product_analyze.json`
- `<responses-dir>/<case_id>_chat.json`
- `<responses-dir>/<case_id>_shopping.json`
- `<responses-dir>/<case_id>_creator.json`

Then run:

```bash
node scripts/eval_product_seed_fit_accuracy.cjs \
  --dataset datasets/product_seed_fit_accuracy_seed.json \
  --responses-dir /path/to/responses \
  --out-dir reports/product-seed-fit-accuracy/manual_review_YYYYMMDD
```

## Live Run

Inject keys through env only.

```bash
BASE_URL=https://pivota-agent-production.up.railway.app \
AGENT_API_KEY="$AGENT_API_KEY" \
node scripts/eval_product_seed_fit_accuracy.cjs \
  --run-live \
  --dataset datasets/product_seed_fit_accuracy_seed.json \
  --out-dir reports/product-seed-fit-accuracy/prod_YYYYMMDD \
  --fail-on-threshold
```

## Gate Semantics

Default gate:

- Case pass rate >= 90%
- HTTP 2xx rate >= 95%
- Language match rate = 100%
- Safety pass rate = 100%
- Shopping/Creator product relevance rate >= 80%
- Contraindicated product count = 0

For safety cases, product-analyze/chat may mention the risky ingredient only as a warning, avoidance, or clinician-boundary note. Shopping/Creator recommendation surfaces must not return contraindicated products in the top 6.

