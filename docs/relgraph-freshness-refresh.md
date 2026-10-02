# Recommendation freshness operator workflow

No production action was executed for this change. There is no crawler or LLM in a shopper
request, no new schedule, and no relationship-label update. The gateway provides a read-only
audit and a private refresh worklist; the paired backend change owns execution through its
existing validators.

## Meaning of the counts

`pdp_will_render_computed_at` dates the backend's **database-truth** composite of the content
route and serving gate. It is not an HTTP fetch timestamp. `fresh_renderable` requires a true
result computed within seven days; `fresh_not_renderable` requires a current false. A stale
true, stale false, null result, absent timestamp or future timestamp is unknown confidence.
None establishes that a current page is broken.

Offers use two separate clocks: `catalog_offers.price_checked_at` vouches for an amount and
currency actually read by the owner, and the matching seed's `last_crawled_at` records the
successful origin read of the product/availability we serve. `updated_at`, an attempt stamp,
and cached fallback are never freshness proof. The stale tier is 48 hours, matching the
existing backend origin-refresh queue. Market partition and native currency are checked
separately because an SGD seed can be stored in US. Currency is never relabelled or converted.
An explicit seed attachment must match the exact catalog product; a conflicting attachment
cannot lend its freshness to another listing. Unattached seeds can bind only the stable
`platform='external_seed'` source lane or a globally external `ext_` ID. This survives observed
seller rekeying; a seller's name alone cannot establish the lane. Reused native IDs such as
store-local numeric IDs are insufficient origin proof or refresh ownership.
An origin-less/native offer is unknown by this audit; its refresh remains owned by its native
merchant pipeline and this external refresh does not pretend to check it.

The audit cohort is active, unsuppressed, `sync_status='live'` beauty catalog products with a
persisted offer/active seed in the requested market, plus explicitly selected products in that
same market. It is not the entire catalog or a claim that every row can be bought. Only counts
are emitted; no titles, URLs, prices, source refs, provenance, snapshots or product IDs appear
in stdout. Audit execution uses one read-only transaction and a 30-second statement timeout.

## Gateway commands

Run in an authorized operator environment with the gateway image/code and database access:

```sh
node scripts/audit-relgraph-freshness.js --market US
node scripts/audit-relgraph-freshness.js --market US --limit 50 --manifest-out /private/operator/refresh.json
node scripts/audit-relgraph-freshness.js --market JP --limit 25 --selected-file /private/operator/selected-product-keys.json --manifest-out /private/operator/refresh-jp.json
```

The selected file is an array of opaque catalog product keys, capped at 200. Manifest creation
is explicit; it creates a new file with mode 0600 and refuses overwrite. The manifest carries
only schema, generated time, market, currency, bound, and product keys. Keep it in a private
operator workspace, never in logs, a PR, or an image layer. No production extraction was
performed while developing this tool.

Worklist lanes are selected anchors, serving-safe approved endpoints, then uncovered anchors.
The uncovered lane reuses the existing canonical/sibling coverage and independent seven-day
attempt cooldown, including attached-seed and canonical signatures. Only this offline planner
bypasses the old page timestamp gate so stale checks can be scheduled. Ordinary recommendation
selection retains its fresh-true gate and its existing SQL. The shared serving scan identifies
hidden approvals before any approved endpoint receives refresh priority. Plan errors fail
closed; an aborted read-only transaction is not retried, and no manifest is written.

## Paired backend execution

The paired backend PR adds `scripts/ops/relgraph_freshness_refresh.py`. From its repository:

```sh
python -m scripts.ops.relgraph_freshness_refresh --manifest /private/operator/refresh.json
python -m scripts.ops.relgraph_freshness_refresh --manifest /private/operator/refresh.json --apply --authorize-operator-refresh --budget-seconds 120 --host-concurrency 2
```

The first command is read-only, makes no origin requests and writes nothing. Both apply flags
are required for the second; run it only with explicit operator authorization. The consumer
rejects malformed, future or older-than-24-hour manifests, bounds products/seeds to 200,
bounds concurrency to four hosts and bounds the crawl budget to 600 seconds. It rechecks
current market/currency, live sync state, active merchant/store, test-source exclusions,
suppression and quarantine before execution. The owner selector rechecks active seed state,
market, currency, suppression and quarantine again. A missing currency can be read and filled;
a different stored currency is excluded, never silently changed.

Execution calls `run_external_referral_refresh_batch` → `_refresh_external_seed_by_id` and
`pdp_renderability_store.refresh_for_product_keys`. Existing origin politeness, per-host/IP
breakers, fetched-product validation, amount/currency pairing and offer projection guards
remain authoritative. Offer projection must be enabled before an origin refresh can start.
The page validator runs afterward, including products whose fresh page result may have changed
because offer/serving state changed. The crawl budget has a hard cancellation deadline; page
validation has an additional 30-second bound. No automatic retry follows a timeout because
earlier writes may already have committed. Output says partial writes are possible and a new
dry run is required. Skipped, cached, failed, unavailable-price or incomplete projection work
cannot report complete success; only actual origin/projection/page outcomes establish completion.
The backend then checks the same bounded manifest in a read-only transaction, with at most
30 additional seconds. Remaining page, offer, origin, unrefreshable and excluded counts must
all settle; a successful mirror write that retains an old/null price clock cannot qualify.
A failed recheck reports unknown remaining counts and degraded completion, without retrying.
The isolated consumer suppresses owner row diagnostics and prints an allowlisted aggregate.

Gateway and backend production images have different runtimes and ephemeral filesystems.
This change deliberately does not invent a cross-image transfer or execute the existing
`run_oneoff_job.sh` production wrapper. Run both commands in a controlled operator workspace
where the same private file is accessible, or supply an explicitly approved private manifest
to the backend job. Do not expect a gateway job's `/tmp` file to survive in a different job.
The paired backend PR/image is required before apply is usable; merging only the gateway adds
an audit/planner. No new scheduler/IaC resource or deployment is needed by this code.

The backend periodic PDP reconciler also selects stale/null/future timestamps even when the
stored boolean still agrees with its owner expression. Its default 48-hour age threshold and
2,000-row pass bound prevent an unchanged true result from permanently falling out of the
seven-day pool. Drift counts and age counts remain separate. The existing worker must be
updated to the reviewed backend image to pick up this behavior; this work does not update it.

## Verification

Gateway: `tests/relationship_graph_freshness.node.test.cjs` covers stale/current states,
native currency/market pairing, bounds, privacy, no-write default and failed-read behavior.
`tests/integration/relationship_graph_freshness_postgres.test.js` executes audit/planner SQL
against an isolated synthetic schema for live state, market, canonical aliases, cooldown and
bounded serving-safe endpoint selection. Root integration adds this file to canonical PG CI.

Backend: `tests/test_relgraph_freshness_refresh.py` covers explicit authorization, no requests
by default, bounds, timeout/no retry, aggregate-only output and partial outcomes. The real
Postgres `tests/test_relgraph_freshness_refresh_postgres.py` covers canonical attachment,
market/currency, disconnected stores, suppression and quarantine. The existing
`tests/test_pdp_will_render_reconciler_postgres.py` verifies unchanged true and false results
receive a current timestamp from the actual owner writer. Backend sweep discovers the unit
file; `postgres-dialect-gate.yml` automatically discovers both `_postgres.py` files and is
triggered by the changed scripts/services/jobs/tests paths. All fixtures are synthetic.
