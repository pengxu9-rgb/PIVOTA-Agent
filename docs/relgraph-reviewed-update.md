# Bounded reviewed graph update

`relationshipGraphReviewedUpdate.applyReviewedComparison` publishes a bounded
subset of a completed paired evaluation. It is disabled by default and is not a
scheduled-job flag. The calling operator must explicitly enable publication.
The module performs no model calls, catalog writes or evidence publication.

The comparison keeps exact frozen evidence and anchor facts identical between
the early candidate cap and wider shortlist, then applies the same final cap.
Publication requires a nonempty expanded approval denominator, a complete
independent audit of every approval, at least 95% observed useful approvals,
zero approved variants, increased useful approval yield and no decreased useful
anchor coverage. Empty, incomplete or failed comparisons write nothing.

Every published pair must be a sampled expanded dupe or competitive alternative,
with grounded independent GPT/Gemini consensus and two matching useful blinded
audits. The module revalidates audit schemas, provider/model identities, exact
fact fingerprints, factual quotes and dupe material evidence. Replayed audits
from another pair, duplicate packets or changed report denominators fail before
staging. Formula, price, structural and serving policies remain authoritative.

At most 12 pairs can be published. Existing global fan-in admission and protected
label states govern staging. Only rows stamped by this invocation and admitted
by that writer can be promoted. Exact stored evidence must still match the model
review; the existing revision-and-facts compare-and-swap approval path preserves
human decisions and changed rows. All approvals commit in one transaction.

The aggregate receipt distinguishes staged candidate writes, committed approval
writes, current AI-approved IDs and actual serving-view visibility. It queries
the view by label IDs, which can differ from edge IDs. The run ID persists on
mutated rows for reconciliation. Partial staging, uncertain commits and failed
reconciliation remain explicit; unknown writes must never be reported as zero.

An observed fraction from a small deterministic sample does not establish
catalog-wide precision. Report all sampled failures and uncertain/unreviewed
audits. No proposed dupes means dupe quality is unmeasured. A graph update with
zero newly visible approved edges does not demonstrate a recommendation gain.

Verification uses mocked providers and an isolated fresh local PostgreSQL server:

```bash
node_modules/.bin/jest --runInBand tests/services/relationship_graph_reviewed_update.test.js
RELGRAPH_TEST_POSTGRES=1 node_modules/.bin/jest --runInBand tests/scripts/relationship_graph_reviewed_update_postgres.test.js
```

The PostgreSQL test never reads deployment database URLs and creates a private
server and a new schema for every case. It verifies real approval/serving,
different label and edge IDs, human precedence and fan-in writer omissions.
