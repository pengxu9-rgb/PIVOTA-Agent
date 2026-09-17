# Primary brand lookup index readiness

The primary recall query requires two expression indexes to avoid scanning unrelated catalog offers and repeatedly decompressing unrelated seed JSON. Production EXPLAIN before this change measured 8,452 catalog product probes for five Stila results and 2,084–3,010 seed rows inspected for zero matching rows.

These indexes accelerate an existing exact normalized-brand predicate. MD5 is a fixed-width lookup key only. The SQL also requires the full normalized brand equality; hash collisions cannot change the product identity or admit another brand. No product, content, listing, signature or group key changes.

Generate the reviewed definitions and read-only readiness query from the same expressions used by serving:

```sh
node scripts/catalog/primary_brand_indexes.js
node scripts/catalog/primary_brand_indexes.js --sql
```

The SQL script pins `search_path` to `public`. Execute each `CREATE INDEX CONCURRENTLY` in autocommit, outside a transaction. Inspect the readiness query first. It returns the schema, table, definition, expression, predicate and `indisvalid`/`indisready`. Both names must refer to the expected public tables and exact reviewed definitions. Missing, invalid, unready or differently defined indexes block deployment readiness. The script deliberately omits `IF NOT EXISTS`, which could conceal an invalid or different existing index. Review any required repair separately; the script never drops indexes.

`inspectReadiness` distinguishes structural readiness from deployment readiness and requires explicit definition review. Do not mark definitions reviewed solely because names exist. The seed partial predicate is active plus nonempty attachment, which every selected primary seed SQL shape already requires. The canonical index is not partial.

After index creation, rerun the generated primary SQL with actual parameters using a read-only connection. Review EXPLAIN ANALYZE/BUFFERS and elapsed time for both canonical and selected seed scopes, confirming the indexes are used and that the existing statement deadlines are met. Local fixtures prove predicate equivalence and SQL eligibility; production plans establish the operational readiness of the access path. This change adds no retry, rescue query, alternate data source or timeout increase.

## Relationship graph ref-key indexes

The same script also defines five `catalog_products` indexes, `idx_catalog_products_ref_key_<column>_v1` on `left(lower(<column>), 512)` for `source_product_id`, `product_key`, `pivota_signature_id`, `canonical_url` and `pivota_canonical_url` (`accelerates: 'ref_key_equality'`). They serve `resolveRelationshipGraphRefsToCanonicalEntities`, which used to OR five `lower(column) = ref` comparisons in one join and took 7.4s in production for the 41 refs of three anchors. Each column is now its own indexed branch: the index answers the bounded prefix and the statement rechecks the full lowercased value, so matches are unchanged. The prefix bound keeps a long URL from exceeding the btree key limit and failing writes. The expressions come from `src/services/relationshipGraphRefKeySql.js`, the same module the resolver reads.

Create them with the same procedure before deploying the resolver change, then EXPLAIN ANALYZE the resolver statement with real refs and confirm an `Index Cond` on each index. A build that fails leaves an INVALID index that still costs writes; `inspectReadiness` reports it, and it must be dropped by a reviewed repair before retrying.
