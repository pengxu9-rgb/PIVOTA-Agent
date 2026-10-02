# GPT/Gemini relationship review

The graph's single-model reviewer can approve unhelpful pairs with high confidence.
The opt-in consensus path sends the same frozen candidate facts independently to
one pinned OpenAI GPT model and one pinned Gemini model. Neither sees its peer's
answer. This follows the Pokémon concept-review precedent: preserve each review,
bind the decisions to source evidence, and record machine agreement separately
from human certification.

| Result | Action |
| --- | --- |
| Both approve the same relationship kind, each at least 0.90, and all deterministic evidence checks pass | Apply `ai_approved` with both reviews in `provenance.ai_review.cross_agent_review` |
| Both confidently reject | Move to `needs_evidence` with `cross_agent_rejected`; omit from the human queue |
| Verdict disagreement, differing approved kinds, uncertainty, confidence below the floor, invalid evidence, or a reviewer failure | Move to `needs_evidence` with `cross_agent_human_review`; retain both results for a human |
| Existing serving guard blocks a sibling/variant or malformed reference | Keep the existing deterministic rejection without calling either model |

Rejected kinds may differ when both models reject: no recommendation is admitted
and no kind is asserted for the combined decision. Agreement never silently
converts a rejected edge to a different relation type.

Human labels always win. No consensus path writes `human_approved`,
`human_rejected`, or `human_review`. Existing actual human approvals are unchanged.
The schema remains compatible with the current serving view; no migration is
required. An AI rejection stored as `needs_evidence` is a machine disposition,
not a completed human review.

## Evidence and dupe admission

Consensus uses facts in the exact candidate-label snapshots, with the same
conservative consumer-copy contract as rubric v4. It deliberately does not add
mutable catalog supplements to the model payload. Approved facts must quote the
supplied products; structural substitution/complement checks still apply.

Dupe candidates additionally need the existing formula/INCI or verified
pair evidence, cross-brand semantics, sufficient category/similarity evidence,
and a positive, strictly lower comparable price with a fresh observation that is
not dated in the future. Cheaper prices, similar names, and agreement alone
cannot establish a dupe. The serving guard lifts the blanket AI-dupe quarantine
only for a valid consensus record tied to current edge evidence and a dupe that
still passes runtime validation. Formula/performance equivalence remains
explicitly unestablished in shopper copy.

The record preserves the actual provider/model identities, both decisions and
rationales, escalation reason, evidence fingerprint and review fingerprint.
Fingerprints bind source facts and detect changes; they are not cryptographic
signatures or external proof of model correctness. The apply boundary validates
both decisions again and compares the exact PostgreSQL microsecond revision,
identity, snapshots, scores, prices, source refs and curated pair evidence. A
concurrent human decision or changed source row yields a guarded no-op.
Serving also hides a consensus edge whose evidence fingerprint no longer matches.
Freshness renewal does not extend stale dupe prices: the shared guard rejects them.

## Configuration

Default behavior remains `single`. To select consensus, pass
`--review-mode consensus` to the reviewer or either routine, or set
`RELGRAPH_AI_REVIEW_MODE=consensus` on the scheduled job. Configure explicitly:

```text
RELGRAPH_AI_REVIEW_MODE=consensus
RELGRAPH_REVIEW_OPENAI_MODEL=<available pinned GPT API model>
RELGRAPH_REVIEW_GEMINI_MODEL=<available pinned Gemini API model>
OPENAI_API_KEY=<existing approved secret binding>
```

Gemini retains the existing Vertex/ADC or Gemini API-key authentication seam.
The consensus OpenAI provider explicitly opts into Responses `text.format`
`json_schema` with `strict=true` and `store=false`. Its native schema is generated
from the unchanged local validator, with finite string bounds expressed as
bounded patterns; unsupported checks, optional fields and conversions fail
before HTTP. Other provider callers retain their existing format. Gemini remains
in JSON mode: its documented native schema subset does not support the required
string bounds or patterns. Both responses still pass the full local Zod parser
and existing semantic checks; nothing truncates or repairs invalid output.
See [OpenAI's supported schemas](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas)
and [Google's response JSON schema subset](https://docs.cloud.google.com/php/docs/reference/cloud-ai-platform/latest/V1.GenerationConfig#getresponsejsonschema).
Provider fallback is disabled for both reviewers. A Gemini model
that the runtime policy would substitute is a configuration error; a missing
model/credential fails the step rather than reverting to a single reviewer.
The two providers are explicitly selected independently of the shopping agent's
default provider/model environment. Unknown review modes fail closed.

Consensus includes dupe candidates unless `--exclude-relation-types dupe` is
explicitly supplied. The old manual single-review dupe flag still quarantines
single-model approvals at serving. Consensus forbids single-verdict replay.

Dry-run remains the default. The existing apply/write confirmation gates are
still required. Configure model access and verify a small authorized dry run
before enabling the scheduled job. This PR does not provision secrets, enable
the production mode, export production rows, or make live model requests.

Each in-flight candidate uses two independent calls; candidate concurrency
therefore creates up to twice that many concurrent model calls. Retries and the
existing transport circuit breaker remain bounded. A failed reviewer contributes
to review-error metrics; transport outages trip the existing failed-job path.

## Human queue and measurement

The reviewer output contains `human_review_queue`, holding only escalated rows,
their identities, both decisions and the reasons requiring review. With apply
enabled, escalation is also durable on the label row. Matching rejections have
their own `cross_agent_rejected` reason and are excluded from this queue. Summary
counts distinguish agreed approvals/rejections, required human reviews, actual
approval writes and other disposition writes. The run ledger retains each
decision's review fingerprint and escalation reason.

Agreement rate and model confidence do not measure recommendation precision.
Continue independent [batch utility audits](relgraph-batch-quality-audit.md)
and track quality by relation kind and brand. These code tests use synthetic
facts and mocked model responses; they prove routing and database safety, not
the live models' accuracy.

## Verification

```bash
RELGRAPH_TEST_POSTGRES=1 node_modules/.bin/jest --runInBand \
  tests/scripts/relationship_cross_agent_review.test.js \
  tests/scripts/relationship_cross_agent_review_postgres.test.js \
  tests/llm/relgraph_consensus_provider.test.js
```

The PostgreSQL suite creates and removes its own disposable local database. It
checks real serving-view visibility, bounded coverage scanning, disagreement
persistence, human promotion/rejection races, microsecond revisions and evidence
changes without a timestamp update.
