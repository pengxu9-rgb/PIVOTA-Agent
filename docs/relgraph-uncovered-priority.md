# Uncovered-anchor priority rollout

`RELGRAPH_SYNC_PRIORITIZE_UNCOVERED` remains false by default. The cron wrapper forwards its
cooldown and sibling options through selection, sync, routine, and build. With it false, the five
selector/affected-loader SQL calls and parameters match main unchanged.

When enabled, anchors attempted within `RELGRAPH_SYNC_UNCOVERED_COOLDOWN_DAYS` (default 7,
clamped 1–90) are excluded before each source LIMIT and from the builder's anchor lane. Candidate
recall stays broad. Priority is: live anchors never attempted; attempted live anchors by oldest
activity; anchors with only rejected / needs-evidence labels; then ordinary fallback rows. Activity
is the greatest label created/updated/reviewed timestamp or independent anchor attempt timestamp,
scoped to market and beauty. Approved, verified, unexpired labels count as coverage only when serving's shared suppression
guard returns no reasons. SQL excludes AI dupes and nested product refs; a single pre-selection
scan runs the shared JS guard on all fresh approvals and passes hidden ids to each indexed
coverage probe before ordering and LIMIT. This includes shade, family, Fenty and same-product
rules as installed by the shared guard owner. Flag-off performs no scan or preflight.

Label activity alone cannot record zero-edge attempts or writes that skip protected labels.
Migration `061_relationship_graph_anchor_attempts.sql` creates the independent attempt table. A
priority-enabled build in write mode records all selected product-anchor refs before edge writes;
this includes zero-edge builds. Failures after that point also cool down the attempted anchor.
Dry runs record nothing. This does not claim atomic selection between overlapping runs.

Claude must apply migration 061 **alone** before arming the flag. Production gateway has
`DB_AUTO_MIGRATE=false`. Never run `npm run db:migrate` in production: it applies every pending
file, including 060, which is outside this rollout. The job scripts do not bootstrap migrations.

Operator procedure (Codex does not execute this in production): use psql with `ON_ERROR_STOP=1`
and one transaction, from the repository root:

```sql
BEGIN;
\i src/db/migrations/061_relationship_graph_anchor_attempts.sql
INSERT INTO schema_migrations(id) VALUES ('061_relationship_graph_anchor_attempts.sql');
COMMIT;
SELECT to_regclass('relationship_graph_anchor_attempts');
```

Confirm the SELECT returns the table before setting `RELGRAPH_SYNC_PRIORITIZE_UNCOVERED=true`.
Both selector and affected-product-file build paths now fail up front if it is absent, rather
than treating a missing source table as an empty product pool. With priority disabled no query
touches the new table. If 061 was previously applied, verify its schema and existing migration
record instead of replaying this transaction.

A priority-live anchor must pass the shared active-catalog-source predicate and suppression checks,
plus pdp_will_render IS TRUE and a probe computed within the last 7 days. Null or stale probes fail
closed for priority. This implements Claude's recommendation; Peng can overrule it in review.

`RELGRAPH_SYNC_COVERAGE_SIBLING_REFS` defaults true to match production gateway hydration. The job
must not infer it from the gateway's hydration env flag, which it does not inherit. Set it false
when gateway identity hydration is disabled. It includes active, signed members found by content
key or group membership, using serving's ordered 100-member bound and only its first canonical
pg_ id. Signature, source, attached-seed, and direct anchor identities are preserved. The gateway
canonical-anchor flag may remain unset; hydration still supplies that canonical ref for serving.

The semantic Postgres suite runs in `canonical-main-postgres` (Canonical main SQL + HTTP
(PostgreSQL)) using CANONICAL_MAINLINE_TEST_DATABASE_URL and an isolated schema. The Homebrew
Postgres 15 runner with a dynamic loopback port is the local opt-in fallback. Its ten-night test
uses the real label upsert and proves cooldown and never-attempted precedence. Optional
RELGRAPH_TEST_EXPLAIN=1 loads 29k catalog products, 30k seeds, 28k group members, and 70k labels
plus 35k historical attempt records, and records EXPLAIN (ANALYZE, BUFFERS) for catalog/seed queries in 24h and full-catalog windows.
