# Multilingual Vector Recall (Route B)

This gateway supports a **hybrid retrieval** mode for creator-scoped catalog search:

- **Lexical recall** (existing `products_cache` LIKE matching)
- **Vector recall** (pgvector embeddings over `products_cache`)

Vector recall is intended to fix cross-language queries (ES/FR/JA/ZH → mostly EN product titles/descriptions).

## Setup

1) Ensure Postgres is configured:
- Set `DATABASE_URL`

2) Run migrations:
- `npm run db:migrate`

This creates:
- `products_cache_embeddings_fallback` (always; no extensions required)
- `products_cache_embeddings` (only if `pgvector` is available)

If the connected Postgres instance does not support `pgvector`, the migration will log a NOTICE and skip creating the pgvector table. Vector recall will still work via the fallback table (Node-side cosine similarity).

3) Backfill embeddings for a creator (recommended before enabling):
- `node scripts/backfill-products-cache-embeddings.js --creatorId creator_demo_001`

You can also target merchants directly:
- `node scripts/backfill-products-cache-embeddings.js --merchantIds merch_abc,merch_def --limit 2000`

## What gets embedded

Each product is embedded from a single text blob that includes:
- `title`, `product_type`, `vendor`, `description`
- `tags` (Shopify tags → `product_data.tags`)
- `recommendation_meta.tags` + `recommendation_meta.facets` (if present)

This means **Shopify tags become first-class retrieval signals** for multilingual search and downstream similarity.

## Recommended tagging conventions (optional but high impact)

Use stable, prefix-based tags so the system can derive facets:
- `Cat:Brush`, `Cat:Sponge`, `Cat:Puff`
- `Area:Face`, `Area:Eyes`, `Area:Lips`
- `Use:Foundation`, `Use:Powder`, `Use:Concealer`, `Use:Blush`
- `Material:Synthetic`, `Material:Natural`
- `Hair:Goat`, `Hair:Pony`
- `Shape:Angled`, `Shape:Flat`, `Shape:Round`

These are parsed into `recommendation_meta.facets` and heavily influence:
- creator cache lexical ranking
- vector embeddings (semantic recall)
- creator “similar products” rerank

## Enable

Set env vars:
- `FIND_PRODUCTS_MULTI_VECTOR_ENABLED=true`
- `PIVOTA_EMBEDDINGS_PROVIDER=gemini` (or `openai`)
- `GEMINI_API_KEY=...` (if using gemini)

## Observability

When creator cache search is used (`metadata.query_source=cache_creator_search`),
the response includes:
- `metadata.retrieval_sources`: `[lexical_cache, vector_cache]` with counts and provider/model (when enabled)

## Safety

Vector recall is **fail-open**:
- If embeddings lookup fails (missing table, API errors, etc.), the gateway returns lexical-only results.
