# Full-batch recommendation quality and reviewed remediation

Approval counts and model confidence are not independent precision. Audit exact applied approvals, complete product snapshots, and independent useful/incorrect/uncertain decisions. Do not extrapolate the truncated 30-pair fixture to the full 135 approvals.

## Batch export and independent review

The routine ledger now stores exact decision IDs, actual-write markers and kinds in `summary.recommendation_review_batch`. Guard-block writes remain separate from approval writes. Missing or truncated decision artifacts fail closed. This uses the existing ledger table and requires no migration. Older ledger rows without exact identities cannot be exported by guessed date windows or counts.

Inside the approved database environment, export one explicit run in a repeatable-read, read-only transaction. ID queries are bounded to 250 rows each and never scan the whole graph. The exported snapshots are current row snapshots, not immutable approval-time snapshots. Use an original review artifact with `--review` when its exact decisions are available.

```sh
node scripts/audit-relationship-recommendation-batch.js --run-id <exact-run-id> \
  --out /tmp/batch.json --template /tmp/independent-labels.json
```

The template deliberately marks everything unreviewed. An independent reviewer supplies `assessor`, `method` (`human_review` or `independent_review`), notes, `assessment` (`useful`, `incorrect`, `uncertain`, `unreviewed`) and `expected_kind`. Preserve the full batch scope fingerprint and each snapshot fingerprint. Scope binding includes all applied approval identities, missing identities, counts and exported rows; deleting a bad pair cannot silently improve the reported precision. These hashes detect mismatches, not signed authenticity. Model approval fields and heuristic proposed relations are review hints, not ground truth.

```sh
node scripts/audit-relationship-recommendation-batch.js --batch /tmp/batch.json \
  --labels /tmp/independent-labels.json --out /tmp/quality.json
```

The report shows useful/incorrect/uncertain/unreviewed counts by stored and expected kind, both brands and cross-brand status, adjudicated coverage, observed useful precision and an adjudicated relation confusion matrix. Unknown/unreviewed/missing pairs never count as useful. Coverage uses every applied batch identity, including missing snapshots as unreviewed rows in unknown brand/kind groups. Observed precision covers only independently adjudicated exported rows. A complete export without independent labels still has unknown precision; this is not a green quality acceptance gate. Modified snapshots, stale labels and foreign/duplicate IDs are rejected.

## Reviewable legacy remediation

The audit emits a review-only queue. Variants can be planned for AI retirement through the serving guard. A wrongly typed complement requires a separately generated correct alternative and an explicit decision on the original identity. No tool silently changes relation identity or converts AI verdicts into human approval. Human-approved edges remain protected in automatic queues; approve a dupe only after reviewing evidence and under the existing explicit dupe-intent serving contract.

Quarantine is dry-run by default. Its v2 plan includes exact identity/state/revision, durable before-values and a plan fingerprint. After reviewing the plan, fill only `reviewed_by`, `reviewed_at` and a subset of `reviewed_ids`. Applying requires that reviewed manifest and the existing confirmation token; scope and before-values must remain unchanged. Default scope remains AI-only. A concurrent human promotion, changed identity or timestamp causes a skip. Timestamps retain PostgreSQL microsecond precision. Inspect `applied_count` and `skipped_changed_or_filtered_count`; a plan count is not a write count.

```sh
node scripts/quarantine-relationship-graph-serving-unsafe.js --market US \
  --reasons related_product_same_family_variant,competitive_alternative_same_family_variant \
  --out /tmp/variant-plan.json
```

No retirement or human publishing is executed by the audit. Existing human publishing still requires an explicit human decision and a fresh identity/state review; it is not the audit's automatic apply path. Retain the before-values plan for any separately reviewed rollback. Do not restore old values over later decisions.

## Release verification

Deploy the exact reviewed, green merged commit to both the gateway and relgraph job, preserving live environment/secret bindings and instance/pool limits. Verify health-reported image commit, image digest, configuration fingerprint and job image. Updating the job does not start a writer run. Then inspect the next completed run's exact ledger batch, export it and independently review recommendations by kind and brand before raising throughput or considering broader catalog recall. Cross-brand reservation only covers products already present in the bounded candidate pool.
