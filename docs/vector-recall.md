# Multilingual Vector Recall (Route B)

This gateway supports a **hybrid retrieval** mode for creator-scoped catalog search:

- **Lexical recall** (existing `products_cache` LIKE matching)
- **Vector recall** (pgvector embeddings over `products_cache`)

Vector recall is intended to fix cross-language queries (ES/FR/JA/ZH → mostly EN product titles/descriptions).

## Setup

1) Ensure Postgres is configured:
- Set `DATABASE_URL`

2) Run migrations (creates `products_cache_embeddings` and enables `pgvector`):
- `npm run db:migrate`

Note: if the connected Postgres instance does not support `pgvector`, the migration will log a NOTICE and skip creating the vector table. The gateway will continue in lexical-only mode.

3) Backfill embeddings for a creator (recommended before enabling):
- `node scripts/backfill-products-cache-embeddings.js --creatorId creator_demo_001`

You can also target merchants directly:
- `node scripts/backfill-products-cache-embeddings.js --merchantIds merch_abc,merch_def --limit 2000`

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
