# Relationship graph evidence wiring

The offline graph builder hydrates selected anchors and candidates before its
final scoring and review snapshots. Canonical product keys, minted signatures,
exact PDP URLs, globally unique external ids and merchant/platform-scoped source
ids bind evidence to a listing. Names and family identifiers do not bind formula
evidence. Recycled raw ids without scope abstain, and conflicting signature,
product key, merchant, market, brand or structured variant metadata rejects a
join. Family deduplication keeps evidence with the listing that owns the final
identity; it cannot copy a sibling's formula into that identity.

Two concrete normalization losses are fixed: a second normalization previously
dropped `ingredient_text`, and the Insights text collector skipped standard
`what_it_is`, `routine_fit`, `why_it_stands_out` and `watchouts` containers.
INCI text now survives normalization, scoring and frozen pair snapshots on both
sides. Reviewer summaries cap each formula at 700 characters and mark partial
text with `ingredient_text_truncated`; a partial summary cannot establish that
an ingredient is absent. Enrichment preserves each selected listing's identity, amount/currency,
price observation and caller metadata. It does not write labels or source data.

Ingredient records come from the reviewed public beauty authority or PCI rows
that allow ingest or have a successful parse. Explicit ingest denial, rejected,
blocked, failed and review-pending statuses cannot be admitted. Conflicting lists
remain individually attributed in `ingredient_evidence`; the combined product
has no formula comparison text. An incomplete per-listing ingredient load also
withholds formula comparison. Ingredient overlap does not establish clinical,
safety or performance equivalence, and source membership adds no ingredient
similarity or social-proof bonus.

Insights snapshots retain provenance, evidence profile, confidence, freshness,
source coverage, quality state and separate market-proof/highlight fields. A
seller-only or unknown bundle is grade C and is not automatically authoritative;
reviewed official PDP entity evidence is grade B. Explicitly rejected bundles
cannot re-enter through a plain candidate fallback. The reviewer receives typed
source confidence, sponsorship and independence metadata, plus the source's
review decision. Seller facts, reviewed external highlights and market proof
remain distinct; KB membership alone establishes none of the latter.

`enrichProductRelationshipGraphProducts({queryFn, products, limit, market})`
returns enriched products, ingredient rows, Insights rows and aggregate
diagnostics. `limit` controls batch size, capped at 200 products, rather than
silently truncating requested products. Each source admits up to four recent
matching records per selected listing; a fifth record is a sentinel that reports
incompleteness. Caps and sentinels use the strongest exact listing identity,
independently of shared canonical/group references. Deduplication compares
attributed formulas for the same exact listing and preserves contradictions.
Insights joins reject explicit identity conflicts before applying those caps;
unscoped recycled IDs cannot crowd an older exact match out of its target bucket.
The caller separately bounds its selected candidate set and
prioritizes anchors when that bound is reached. Selected older evidence is
queried by identity and is independent of global latest-record discovery limits.

With `--expand-target-recall`, the builder now admits a wider source shortlist
before exact hydration: three times `maxPerAnchor`, capped at 100 and never
below the supported final cap. `candidateShortlistLimit` is an optional
programmatic override, normalized by the exported
`normalizeCandidateHydrationShortlistLimit` helper. For example, a final cap of
two now hydrates up to six existing-pool opportunities, plus the independently
bounded catalog recall lane, before final ranking. A formula-rich third candidate
can therefore compete after its exact ingredients are loaded. All relationship
inference, scoring, review and serving requirements remain unchanged.

The expanded lane prioritizes anchors, then alternates candidates across anchors
and source/catalog lanes within the 5,000 exact-listing global hydration bound.
Final expanded ranking excludes listings omitted by that bound, cannot add
unadmitted legacy-dupe records, and applies the final cap to direct and transitive
candidates together. Admitted legacy pair evidence remains scoped to its original
anchor. Canonical aliases never substitute for omitted exact listing identities.
Flag-off admission, hydration order and historical transitive append behavior are
unchanged. These budgets bound retrieval work; they do not imply formula
similarity, review approval or production quality gains.

The source builder exposes `enforceTotalCandidateLimit` (default false) and
`includeLegacyExplicitCandidates` (default true) so bounded evaluation can use
the same post-hydration selector as production rather than a separate ranking
algorithm. The expanded builder opts into the first and disables the second only
for its final, already admitted per-anchor pool.

Targeted Insights retrieval materializes compact identity fields once, ranks
matching keys per target, then projects only selected bundles. It avoids a full
JSON scan for every target. The disposable PostgreSQL regression uses 10,000
bundles with substantial core JSON and 200 targets, checks one identity scan,
bounded scan rows, all 200 matches and the 30-second statement budget. This is a
synthetic performance check, not a production latency guarantee.

Verification:

```bash
node_modules/.bin/jest --runInBand tests/product_relationship_graph_evidence.test.js \
  tests/product_relationship_graph_sources.test.js tests/product_relationship_graph_builder.test.js
RELGRAPH_TEST_POSTGRES=1 node_modules/.bin/jest --runInBand \
  tests/scripts/relationship_graph_evidence_postgres.test.js
```

The PostgreSQL suite accepts only an explicitly selected loopback CI database
through `CANONICAL_MAINLINE_TEST_DATABASE_URL`, or creates and removes its own
local database. Fixtures and temporary renames of pre-existing schema-qualified
ingredient tables are contained in a transaction and rolled back; the suite
checks restoration of the original table identities. Ambient deployment
database URLs are ignored. These tests make no live model calls. Runtime
serving remains dependent on existing structural/variant guards, price freshness
and actual review approval; successful evidence hydration does not approve an
edge or establish recommendation precision.
