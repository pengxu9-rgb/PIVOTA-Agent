# Relationship graph read diagnostics and bounded validation

## What this change establishes

The serving reader used to return the same `[]` for a successful empty eligible
query, `NO_DATABASE`, and PostgreSQL missing-relation `42P01`. The new additive
structured APIs `readApprovedRelationshipEdgesForAnchor` and
`readApprovedRelationshipEdgesForAnchorUncollapsed` return `{ edges, diagnostics }`.
The existing `listApproved...` APIs retain their array result and error behavior.

The reader still applies the same anchor, market, beauty, approved, verified,
future-expiry SQL predicates, serving guard, deduplication, cap, and optional family
collapse. This is a diagnostic change, not an eligibility expansion or data repair.
No migrations, backfills, publication, worker runs, or deployment are part of it.

The safe public projection is `relationshipGraphReadMetadata` in
`src/services/relationshipGraphRecall.js`. It emits:

| Field | Meaning |
| --- | --- |
| `relationship_graph_read_status` | `ready`, `empty`, `unavailable`, `not_attempted`, or `unknown` for legacy metadata |
| `relationship_graph_read_reason` | `null` for ready; `no_eligible_edges`, `no_database`, `schema_unavailable`, `read_failed`, `disabled`, or `no_anchor_refs` |
| `relationship_graph_edge_count_semantics` | Always `returned_eligible_edges` |

`relationship_graph_edge_count` is the returned eligible edge count after the
reader's filters/deduplication/cap/collapse. It is **not** a count of stored labels,
raw candidates, source evidence, or all possible matching edges. `empty` means the
bounded serving read completed and returned none. It does not distinguish absent
labels from unapproved, expired, suppressed, alias-missed, or capped rows.
`enabled=true` is a serving-path switch, not a database/schema availability claim.

Missing store and missing serving relation become `unavailable`, with no graph
items. Other read failures retain the legacy thrown behavior at the list/read
level and become fail-closed `unavailable/read_failed` in the recall service.
Internal `serving_rows_read` and `serving_guard_dropped_count` describe only the
bounded query; they are null on unavailable reads and are not public fields.
Raw SQL, connection details, evidence blobs, and arbitrary reason strings are not
included in the public diagnostic projection.

`ready` describes the graph read, not final visible-card count. Downstream filters
can still remove all returned items. A dynamic recommendation can also succeed
while the graph read is unavailable. A cached diagnostic describes its original
read; none of these fields attest a current database query, cache hit/miss, dataset
version, worker image, migration application, or source freshness. Old cached
metadata remains `unknown`, never silently promoted to `empty`.

Optional alias and family-resolution failure fallbacks are unchanged. A successful
empty query cannot by itself attest alias coverage or full identity resolution.
Structured family-collapse diagnostics distinguish completed collapse from the
existing uncollapsed fallback. Store-unavailable results are never relabeled empty
by the collapse path.

## Identity and evidence boundaries

A typed recommendation edge is distinct from listing identity, seller identity,
sellable group, product line, review family, and selected variant. Shared line or
review-family metadata does not supply a relation type or prove retailer equivalence.
Consumer cards retain edge ID, relation type, and the existing source references;
these fields do not grant or assert public Insights eligibility.

This patch leaves seller evidence's `graph_only=true` and
`public_insights_eligible=false` boundary unchanged. Seller evidence cannot be
promoted by a diagnostic or a fixture to independent efficacy/dupe proof. Human
precedence, exact evidence binding, consensus requirements, and freshness rules
are unchanged.

## Local positive and negative controls

`tests/fixtures/relationship_graph_corrected_anchor.cjs` replays the already supplied
2026-10-01 sample #23: Missha emulsion versus eye cream remains a typed
`related_product` complement. Sample #29 is a shade-variant negative. Synthetic
same-product sizes and duplicate retailer listings supply additional negatives.
The positive has known distinct group/listing axes despite shared line/review-family
metadata. Family collapse and the consumer adapter are covered separately.

All fixture identifiers, approvals, and timestamps are **local test data**.
This is a known-positive regression replay, not a known-positive production anchor
or proof that an actual review/publication occurred. No missing truncated sample
text, live edge ID, or production anchor was invented.

## Read-only response validator

Run against an existing, authorized saved PDP response and a separately reviewed
expectation file:

```sh
node scripts/validate-relationship-graph-read-contract.cjs \
  --response captured-pdp.json --expectation reviewed-expectation.json
```

The script only reads regular local JSON files and prints its report. It has no
HTTP or database client, no credentials, and no writes. Each file is limited to
2 MiB; validation is bounded to 100 modules, 500 items/expectations/negative IDs,
and 16 expected source references per positive edge. Exit 0 means the recorded
contract matches, 1 means mismatch, and 2 means invalid invocation/input.

Example expectation shape (the following IDs are placeholders, not production IDs):

```json
{
  "schema_version": "relationship_graph_read_expectation.v1",
  "read_status": "ready",
  "subject": { "type": "product_group", "id": "OWNER_VERIFIED_SUBJECT" },
  "expected_edges": [{
    "edge_id": "OWNER_VERIFIED_EDGE",
    "relation_type": "related_product",
    "candidate_product_id": "OWNER_VERIFIED_CANDIDATE",
    "source_refs": [{ "type": "OWNER_VERIFIED_SOURCE_TYPE", "name": "OWNER_VERIFIED_SOURCE_NAME" }]
  }],
  "forbidden_edge_ids": ["OWNER_VERIFIED_SAME_PRODUCT_OR_VARIANT_EDGE"],
  "forbidden_product_ids": ["OWNER_VERIFIED_SAME_PRODUCT_OR_VARIANT_LISTING"]
}
```

For empty/unavailable/not-attempted controls set that expected read status and use
`expected_edges: []`. Positive controls require an exact edge ID, typed relation,
candidate ID, and matching source reference. Subject matching is optional and exact;
do not substitute the requested route signature for the resolved subject/group ID.
An unchanged pre-diagnostic production response will fail the new diagnostic
contract rather than be treated as evidence of an empty database.

`production_rollout_verified` is always false: even a matching captured response
cannot attest the other private rollout layers or actual browser settlement.

## Production evidence still required

The 2026-10-04 read-only audit established graph code through Agent #2357 and backend
#2496 on the sampled runtime and a successful UI same-origin proxy read. That read
returned zero eligible edges. It did not establish data refresh, worker rollout,
optional evidence migrations/publication, or positive recommendation quality.
The following private production evidence was inaccessible to that audit and is
not supplied by these local tests:

1. Read-only gateway, `relgraph-sync`, `relgraph-health`, and scheduler descriptions:
   immutable images/source SHAs, relevant non-secret flags, actual write mode
2. Latest claimed correction's worker execution receipt and complete aggregate
   steps, separating failed/partial/zero-op runs from completed applied changes
3. Bounded `relationship_graph_routine_runs` entries and reviewed-publication
   manifests with exact label/evidence IDs, applied/skipped/uncertain counts and
   before/after evidence fingerprints, plus independent quality results
4. Same-database read-only schema attestations for the serving view and relevant
   061/062/063 tables, constraints, indexes, and append-only triggers; table presence
   alone is not proof of correct migration, freshness, or evidence publication
5. Exact sampled anchor aliases, raw labels, eligible serving rows, suppression
   reasons, actual source/verified/expiry timestamps, and selected-listing/variant
   evidence in a bounded read snapshot
6. An owner-verified positive corrected production anchor plus same-product/variant
   controls, their proxy responses and a settled browser UI capture, tied to the
   expected edge/type/source proof and immutable runtime identity

No database changes or reindex/backfill are implied by this checklist. A gateway
rollout alone is not a worker, data, migration, or relevance attestation.
