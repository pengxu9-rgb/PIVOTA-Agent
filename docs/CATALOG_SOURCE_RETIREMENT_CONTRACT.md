# Catalog source retirement — the contract

Settles [#1917](https://github.com/pengxu9-rgb/PIVOTA-Agent/issues/1917): what is
supposed to happen to a merchant's `catalog_products` rows when that merchant is
deactivated. Companion to [CATALOG_ROW_TRUST_CONTRACT.md](CATALOG_ROW_TRUST_CONTRACT.md),
which governs the derived `catalog_row_trust` verdict; this one governs the raw
row state that verdict reads.

## The three fields, and what each one actually claims

They are routinely confused, so state them separately:

| Field | Grain | Claim |
|---|---|---|
| `catalog_products.sync_status` | row | **Where this row stands with its source sync.** `live` = the last sync saw it and it is current. `stale` = not seen recently. `archived` = we have stopped tracking it. |
| `catalog_products.suppression_reason` | row | **An editorial decision about this specific row** — dedupe loser, tombstone, demo retirement. Orthogonal to `sync_status`: a row can be perfectly current *and* suppressed. |
| `catalog_merchants.indexable` | merchant | **Whether this merchant's content belongs in the public index.** A hold-out bit, not a lifecycle. |

## The contract

> **C1.** `sync_status = 'live'` ⇒ the row's merchant is `active` or `observed`.
> Deactivating a merchant or store **cascades** its live rows to `archived`.
>
> **C2.** `catalog_merchants.indexable = TRUE` ⇒ the same. `indexable` may be
> `FALSE` on an active merchant (a deliberate hold-out), but never `TRUE` on a
> retired one.
>
> **C3.** Retirement is **converged, not poked.** Both invariants are restored by
> re-running a reconciler over current merchant state, never by a trigger or a
> write bolted onto one deactivation call site.

Enforced by [`scripts/reconcile-retired-merchant-catalog-rows.cjs`](../scripts/reconcile-retired-merchant-catalog-rows.cjs).

## Why cascade, and not "leave it live, exclude at query time"

The rejected alternative was to let `sync_status='live'` persist and rely on
`activeCatalogProductSourceWhere` (`src/services/activeCatalogSourceSql.js`) to
join merchant status at read time. Three reasons it loses:

1. **`live` becomes a false claim that never expires.** `merch_efbc46b4619cfbdf`
   last synced 2026-04-10 and went on asserting `live` for four months. No sync
   will ever run against a deactivated merchant, so nothing can ever correct it.
   `archived` is the state the column already has for exactly this.

2. **The query-time join is a defence, not the contract — and it is not
   universally applied.** Two readers filter on `cp.sync_status = 'live'` with no
   merchant-status join at all:
   - `src/services/RecommendationEngine.js:2866` — the seed-lane fast path, which
     documents that it "skip[s] the catalog_merchants join";
   - `src/services/discoveryFeed.js:8904` — the `first_party` lateral, gated only
     on `sync_status='live' AND suppression_reason IS NULL`.

   Requiring every future reader to remember the join is how this recurs. A row
   that tells the truth needs no reader discipline.

3. **`coalesce(cm.status, 'active')` fails OPEN.** A `catalog_products` row whose
   merchant has no `catalog_merchants` row at all is admitted by the very
   predicate that is supposed to be the safety net. Prod carries 13 such live
   rows (see *Known gaps*).

## Why `indexable` is derived rather than independent

Measured on prod 2026-08-07: `indexable` is `TRUE` on 525 of 526 merchants. It is
a default-true column with a single hand-set exception, so it carries no
information that `status` does not — except in the one direction that matters.

Its only reader, `src/server.js:6079`, already requires **both**:

```sql
AND cm_elected.indexable IS TRUE
AND cm_elected.status IN ('active', 'observed')
```

so no consumer is misled *today*. The risk is a future consumer reading one
field. Rather than drop the column — `src/services/pdpRenderability.js` documents
`merch_efbc46b4619cfbdf`'s `indexable=false` bit as the only thing holding 737
rows out of the sitemap, and the column is shared with pivota-backend — the
reconciler makes it a derived invariant in the fail-closed direction only:

- `TRUE` on a retired merchant → cleared to `FALSE` (C2).
- `FALSE` on an active merchant → **left alone**. That is a deliberate hold-out
  and a reconciler must never flip it back on.

## Why a reconciler and not a deactivation hook

There is no deactivation path in this repo to hook. Nothing here writes
`catalog_merchants.status` or `merchant_stores.status` outside one-off scripts —
deactivation is operational, and the merchant tables are also written by
pivota-backend. A sync-time poke would cover neither the manual-SQL case nor rows
that land *after* the deactivation. Per ADR-012 the shape is a convergent
reconciler: cohort recomputed from current merchant state on every run, safe to
re-run, drift reported whether or not it writes.

```bash
node scripts/reconcile-retired-merchant-catalog-rows.cjs --drift-only
```

## Guards

Every archived row must be provably retired, not merely mislabelled. Guarded rows
are reported with a `block_reason` and never written:

| `block_reason` | Meaning |
|---|---|
| `active_store_exists` | A `merchant_stores` row is still `active`. The **store** is the live fact and the merchant row is the stale one; archiving here would retire a syncing catalog on the strength of the wrong field. |
| `row_trust_public` | `catalog_row_trust` says this row serves today. Archiving would silently pull a served row. |
| `index_serving_eligible` | `index_pipeline_state` says the row's *content* is serving-eligible. Deliberately conservative — `ips` is `content_key`-grained and therefore coarser than the row. |

## Rollback

`--out` records the exact keys each write landed, so the undo is mechanical
rather than a re-derivation of the cohort (which would be wrong precisely when a
bad run has changed merchant status):

```sql
UPDATE catalog_products  SET sync_status = 'live' WHERE product_key = ANY(<archived_product_keys>);
UPDATE catalog_merchants SET indexable   = TRUE   WHERE merchant_id = ANY(<indexable_cleared_merchant_ids>);
```

## State measured on prod 2026-08-07

| | |
|---|---|
| C1 violations (live rows under a retired merchant) | **1,558** across 5 merchants |
| …blocked by a guard | 0 |
| …already carrying a `suppression_reason` | 1,540 |
| …`serving_eligible` | 0 |
| C2 violations (`indexable=TRUE` while retired) | **6** merchants |

The whole `internal_merchant` track is 1,582 rows, so 1,558 of it is retired test
rigs. That is why these rows dominate catalog-wide duplication measures:
`content_key`s carrying >1 live row drop from 812 keys / 2,974 rows to 427 keys /
1,428 rows once retired sources are excluded.

## Known gaps (tracked, not fixed here)

- **Missing merchant rows fail open.** 13 live rows under
  `merch_cf2dbaf5774a524d` (`damdamtokyo.com`) have no `catalog_merchants` row and
  no stores, so `coalesce(cm.status, 'active')` admits them. This is the *opposite*
  defect — the repair is to mint the missing merchant row, not to archive a real
  brand's catalog on the strength of an absent record. The reconciler counts them
  (`orphan_merchant_live_rows`) and never writes them.
- **`retired_test_rig` is an unhandled store status.** `deriveSourceLifecycle`
  (`src/services/catalogTrustPolicy.js:445`) handles `active`, `inactive` and
  `disconnected`; `retired_test_rig` (3 stores, all `merch_efbc46b4619cfbdf`)
  falls through to `unknown`, which is **not** a hard block. Inert today — those
  rows are tombstoned by `suppression_reason` first — but it is a fail-open hole.
  Fixing it means changing the Python twin in the same breath or the two flap.
