# Pivot Beauty Contract Production Index

The beauty direct recall index must be applied manually in production because
the app migration runner wraps each migration in a transaction, and
`CREATE INDEX CONCURRENTLY` cannot run inside a transaction block.

Run before deploying the Beauty Pivot Contract code:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_external_product_seeds_category_authority_tool_recency
ON external_product_seeds (
  market,
  tool,
  lower(coalesce(
    seed_data->'derived'->'recall'->>'category',
    seed_data->>'category',
    seed_data->'product'->>'category',
    seed_data->'snapshot'->>'category',
    seed_data->>'product_type',
    seed_data->'product'->>'product_type',
    seed_data->'snapshot'->>'product_type',
    ''
  )),
  updated_at DESC NULLS LAST,
  created_at DESC NULLS LAST
)
WHERE status = 'active'
  AND attached_product_key IS NULL;
```

Verify the index exists:

```sql
SELECT indexname
FROM pg_indexes
WHERE tablename = 'external_product_seeds'
  AND indexname = 'idx_external_product_seeds_category_authority_tool_recency';
```

Representative planner check:

```sql
EXPLAIN
SELECT id
FROM external_product_seeds
WHERE status = 'active'
  AND attached_product_key IS NULL
  AND market = 'US'
  AND tool = 'creator_agents'
  AND lower(coalesce(
    seed_data->'derived'->'recall'->>'category',
    seed_data->>'category',
    seed_data->'product'->>'category',
    seed_data->'snapshot'->>'category',
    seed_data->>'product_type',
    seed_data->'product'->>'product_type',
    seed_data->'snapshot'->>'product_type',
    ''
  )) = ANY(ARRAY['sunscreen'])
ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
LIMIT 24;
```

Rollback normally does not require dropping this index because it does not
change data semantics. Drop it only if it causes operational pressure:

```sql
DROP INDEX CONCURRENTLY IF EXISTS idx_external_product_seeds_category_authority_tool_recency;
```
