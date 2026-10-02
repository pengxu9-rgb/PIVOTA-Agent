# Recommendation quality benchmark

The committed 36-case corpus uses fictional products with separately authored reference judgments. It covers shades, sizes, decorative variants, distinct same-brand lines, cross-brand alternatives, grounded and unsupported dupe claims, stale/future/currency-invalid prices, complements, incompatible attachment/curing/target-area requirements, tools, and insufficient facts. A cheaper alternative does not establish equivalent performance. These are synthetic reference cases, not a statistically representative production sample.

Run the command without options to inspect corpus readiness. It performs no database reads, writes or model calls, and reports null precision when no reviewer outcomes exist:

```sh
node scripts/eval-relationship-recommendation-benchmark.js
```

To evaluate captured final review outcomes, supply a `relgraph.benchmark_decisions.v1` JSON artifact with the matching `dataset_fingerprint`, `evaluated_at`, `mode: imported_review`, and one decision per case. Each decision carries `case_id`, `case_fingerprint`, `verdict` and `relationship_kind`. Duplicate, unknown or changed-case outcomes fail validation; missing outcomes remain unreviewed. Do not convert guard results or the reviewers' own labels into reference judgments.

```sh
node scripts/eval-relationship-recommendation-benchmark.js --decisions review.json --out evaluation.json --gate
```

An explicitly requested live run calls the existing independently pinned GPT/Gemini reviewers on the synthetic product facts. It has no database access or graph apply path, sends no reference judgment or stratum in the prompt, uses one retry attempt, and processes one pair at a time. Provider configuration and keys follow the existing consensus review configuration. This invokes paid model APIs; it is never started by the default command or CI.

Captured `live_consensus` artifacts must retain both pinned reviewer identities and intact, fact-bound consensus proofs consistent with each final outcome. Guard-only rejections are checked against the actual guard. Missing, malformed or changed proofs fail validation. These checks establish artifact consistency, not cryptographic proof that an external model was called; imported reviews and live artifacts must come from trusted evaluation runs.

```sh
node scripts/eval-relationship-recommendation-benchmark.js --live-consensus --decisions-out review.json --out evaluation.json --gate
```

Reports distinguish approval precision, useful-recommendation recall, unresolved-evidence approvals, abstentions, errors, coverage, a kind confusion matrix and each stratum. Substitute and alternative are equivalent benchmark lanes. Rejected false-dupe proposals do not become successful alternative approvals. The proposed synthetic release gate requires complete review, no variant or incorrect-dupe approval, no approval on unresolved evidence, no review errors, and at least 95% precision and 80% recall separately for dupe, alternative and complement. With this small corpus those thresholds require near-perfect behavior; passing does not establish production accuracy. Mock-review artifacts never qualify for release.

Production evaluation remains a separate operation: use representative exact approval batches and independently adjudicated labels through the existing recommendation batch audit. Production precision stays null in this benchmark. The previously denied detailed production export is not needed or performed by these commands. GPT/Gemini agreement reduces escalations, but cannot replace independent reference labels or repair missing evidence inputs.
