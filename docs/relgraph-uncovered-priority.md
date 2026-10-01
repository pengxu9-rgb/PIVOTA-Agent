# Uncovered-anchor priority rollout

`RELGRAPH_SYNC_PRIORITIZE_UNCOVERED` remains false by default. The cron wrapper forwards its
cooldown and sibling options through selection, sync, routine, and build. With it false, the five
selector/affected-loader SQL calls and parameters match main unchanged. The copied reviewer
generator also captures 142 SQL/parameter calls in each empty/populated run across every
selector, affected loader, source pool and build input path; all match main byte for byte.
No new attempt-table preflight runs with the flag off. The focused flag-off regression
compares every call without removing to_regclass and asserts zero such calls. Broader
source pools retain main's 26 unrelated table-existence probes.

When enabled, anchors attempted within `RELGRAPH_SYNC_UNCOVERED_COOLDOWN_DAYS` (default 7,
clamped 1–90) are excluded before each source LIMIT and from the builder's anchor lane. Candidate
recall stays broad. Priority is: live anchors never attempted; attempted live anchors by oldest
activity; anchors with only rejected / needs-evidence labels; then ordinary fallback rows. Activity
is the greatest label created/updated/reviewed timestamp or independent anchor attempt timestamp,
scoped to market and beauty. Approved, verified, unexpired labels count as coverage only when serving's shared suppression
guard returns no reasons. SQL excludes AI dupes and nested product refs; a pre-selection
id-keyset scan runs the shared JS guard on all fresh approvals in batches of 500 and passes hidden ids to each indexed
coverage probe before ordering and LIMIT. This includes shade, family, Fenty and same-product
rules as installed by the shared guard owner. Flag-off performs no coverage scan or attempt-table preflight.
The suppressedIdsSql input is mandatory in every flag-on coverage expression; omissions throw.
This PR is stacked on #2337. Its read-time filter makes coverage use exactly the same safety
predicate as serving, before collapse and caller limits. This counts eligible approved edges,
not a guarantee that any particular limited/collapsed response returns that anchor.

Label activity alone cannot record zero-edge attempts or writes that skip protected labels.
Migration `061_relationship_graph_anchor_attempts.sql` creates the independent attempt table. A
priority-enabled build in write mode records all selected product-anchor refs before edge writes;
this includes zero-edge builds. Failures after that point also cool down the attempted anchor.
Dry runs record nothing. This does not claim atomic selection between overlapping runs.

Claude must apply migration 061 **alone, as the job's own DATABASE_URL_NOVERIFY role**,
before arming the flag. If another role owns the migration, explicitly GRANT INSERT, SELECT
on relationship_graph_anchor_attempts to the job role and ensure schema USAGE. Production gateway has
`DB_AUTO_MIGRATE=false`. Never run `npm run db:migrate` in production: it applies every pending
file, including 060, which is outside this rollout. The job scripts do not bootstrap migrations.

Operator procedure (Codex does not execute this in production): use psql with `ON_ERROR_STOP=1`
and one transaction, from the repository root:

```sql
BEGIN;
\i src/db/migrations/061_relationship_graph_anchor_attempts.sql
INSERT INTO schema_migrations(id) VALUES ('061_relationship_graph_anchor_attempts.sql');
COMMIT;
SELECT current_user AS job_role, to_regclass('relationship_graph_anchor_attempts');
SELECT has_table_privilege(current_user, 'relationship_graph_anchor_attempts', 'INSERT,SELECT') AS any_required_privilege,
       has_table_privilege(current_user, 'relationship_graph_anchor_attempts', 'INSERT') AS can_insert,
       has_table_privilege(current_user, 'relationship_graph_anchor_attempts', 'SELECT') AS can_select;
```

Run these SELECTs through the job's DATABASE_URL_NOVERIFY connection (or replace current_user
with its explicit role when checking from another role). Confirm table presence and both
can_insert/can_select are true before setting `RELGRAPH_SYNC_PRIORITIZE_UNCOVERED=true`.
PostgreSQL's INSERT,SELECT privilege list means ANY, not both; the preflight checks them
individually. Both selector and affected-product-file build paths fail on missing schema or
missing either privilege. The direct manifest routine now checks before its first child,
including pba_sig_refresh, so no signature refresh starts first. In sync, renewal remains an
earlier independent step; this preflight guards the routine, not all preceding sync writes. With priority disabled no query
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

Rollout order: merge #2337 first; retarget #2336 from fix/relgraph-truthful-metrics-and-quality to main and merge. Build the combined image with priority off. Dry-run and quarantine the confirmed unsafe rows before gateway deployment and nightly re-imaging. Audit, deploy/re-image, then apply/verify only 061 under the job role and enable priority. No production action is performed by Codex.

Validation: combined relationship suites on local PG15: 37 suites, 728 passed, 2 optional benchmarks skipped. The exact canonical database job runs both PR suites: 28 suites, 581 passed, 2 optional benchmarks skipped. One clean local run returned HTTP 404 instead of 200 in search_name_evidence_acceptance; the unchanged rerun passed. No application code or assertion was changed for that failure. The shared-scan heap and rule/filter mutation evidence is in relgraph-round5-review-evidence.md from the base PR.
