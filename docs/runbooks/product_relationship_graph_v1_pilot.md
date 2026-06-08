# Product Relationship Graph V1 Pilot Runbook

This runbook keeps V1 data production offline, reviewed, and feature-flagged. Runtime agents should only see graph candidates after approved, fresh edges have been written to `product_relationship_edges`.

## Scope

- Vertical: beauty only
- Pilot market: `US`
- Pilot size: 200 product anchors
- Runtime flag: `AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED=false` until dogfood approval
- Source of truth: `product_relationship_edges`
- Legacy compatibility: `aurora_dupe_kb` can remain a cache/source, but it is not the approval authority

## 1. Build Dry-Run Candidates

```bash
node scripts/build-product-relationship-graph.js \
  --limit 200 \
  --market US \
  --out reports/product_relationship_graph/pilot_200_dry_run.json
```

Expected output:

- `summary.anchor_count` is 200 when enough source products exist
- `edges` contains pending graph edges
- `review_packets` contains the human review queue
- No DB writes happen unless `--apply` is passed

## 2. Audit Before Review

```bash
node scripts/audit-product-relationship-graph.js \
  --report reports/product_relationship_graph/pilot_200_dry_run.json \
  --out reports/product_relationship_graph/pilot_200_audit.json \
  --markdown reports/product_relationship_graph/pilot_200_audit.md
```

Hard failures must be zero before review:

- Same-brand `dupe` or `competitive_alternative`
- On-page-related `dupe` or `competitive_alternative`
- Duplicate anchor/candidate/relation/market identity
- Dupe without candidate price or price observed within 14 days
- Missing category/use-case evidence
- Missing source refs
- Unsupported treatment, endorsement, or identical-formula claims

## 3. Human Review

Reviewers should approve only edges with enough evidence to recommend safely.

Decision records should include:

```json
{
  "edge_id": "prel_example",
  "decision": "approved",
  "reviewer": "human@example.com",
  "reviewed_at": "2026-05-25T00:00:00.000Z",
  "expires_at": "2026-06-24T00:00:00.000Z"
}
```

Use `decision: rejected` when the candidate is weak, same-brand competitive, unsupported, stale, or not category-aligned.

## 4. Publish Approved Edges

Dry-run first:

```bash
node scripts/publish-product-relationship-graph-review.js \
  --report reports/product_relationship_graph/pilot_200_dry_run.json \
  --decisions reports/product_relationship_graph/pilot_200_decisions.jsonl \
  --out reports/product_relationship_graph/pilot_200_publish_dry_run.json
```

Apply only after dry-run summary is clean:

```bash
node scripts/publish-product-relationship-graph-review.js \
  --report reports/product_relationship_graph/pilot_200_dry_run.json \
  --decisions reports/product_relationship_graph/pilot_200_decisions.jsonl \
  --apply \
  --out reports/product_relationship_graph/pilot_200_publish_apply.json
```

## 5. Pilot Acceptance

The pilot is ready for dogfood when:

- 200 anchors processed
- At least 70% of anchors have one approved alternative
- At least 100 approved niche-specialist edges
- Human top-3 accept rate is at least 85% on reviewed dupe/alternative candidates
- Unsupported-claim audit is 0
- Expired or stale edges are excluded from runtime

## 6. Runtime Enablement

Enable only for dogfood/internal traffic first:

```bash
AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED=true
```

Before widening traffic, check live serving coverage and the runtime guard:

```bash
npm run relgraph:serving-status -- \
  --all-markets \
  --fail-on-readiness \
  --json

npm run relgraph:serving-audit -- \
  --all-markets \
  --examples-per-reason 8
```

`relgraph:serving-status` is read-only and reports live active/fresh rows from
`relationship_candidate_labels`, including anchor coverage, approved alternative
anchor percentage, niche-specialist coverage, AI/human label mix, and expiry
windows. By default it uses the pilot acceptance thresholds above and only exits
nonzero when `--fail-on-readiness` is set.

Keep current Aurora router hard gates active. Graph candidates must still pass same-brand, category, source, and price rules before appearing in competitor or dupe blocks.
