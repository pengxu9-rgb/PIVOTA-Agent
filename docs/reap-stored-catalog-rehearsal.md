# Isolated stored-catalog serving rehearsal

This runs the normal gateway server and its normal `get_pdp_v2`, commerce
`get_product`, and catalog search paths against copied, unchanged stored catalog
rows. It does not replace the executor with a selected-variant projection.

Export `GATEWAY_STORED_CATALOG_REHEARSAL=1` in the process environment. The server
checks the configuration before loading application dependencies. A flag supplied
only by `.env` is checked later and does not meet this early-startup requirement.

Every name in `src/config/storedCatalogRehearsal.js:DISABLED_FLAGS` must have the
literal value `false`. Missing values are refused, including capabilities that
otherwise default on. This disables migrations, catalog sync, identity resolution,
image-cache bootstrap/runner, merchant variant sourcing, live merchant repricing,
attribution stamping, PDP prewarm and upstream hydration, catalog index shadow
reads, and the listed Aurora/LLM enrichment paths. The assertion never changes
configuration on the operator's behalf. Several existing cache switches compare
against the literal string `false`, so alternative spellings are unsafe.

Both remote catalog-serving index base URL variables must be empty. A local
read should not quietly become a remote index read. Keep source identity and
stored eligibility/proof timestamps unchanged; a missing or suppressed record
must remain missing or suppressed.

The assertion is **configuration validation**, not a network sandbox or database
authorization boundary. The isolated runtime also needs a narrowly scoped,
read-only database role and an independent transport allowlist that denies
merchant/provider/enrichment egress. Keep instrumentation for denied transport,
attempted writes, and background job activity. Prove full process startup and
actual HTTP reads against the original stored schema and payload before accepting
the rehearsal. Unit tests for this assertion alone do not prove full PDP serving.

Generate the non-secret suppression portion of a task-local environment file:

```sh
node -e 'const {DISABLED_FLAGS}=require("./src/config/storedCatalogRehearsal"); console.log("GATEWAY_STORED_CATALOG_REHEARSAL=1"); for(const name of DISABLED_FLAGS) console.log(`${name}=false`);'
```

Normal deployments with the opt-in flag absent retain their existing behavior.
Do not publish this fixture as a production merchant checkout.

The current UI demo accepts only loopback hosts and a loopback gateway base and
is disabled in production. Use an owned local IAM-authenticated proxy for a
private Cloud Run gateway, preserving the application's caller key and buyer JWT.
The platform token belongs in `X-Serverless-Authorization`; changing buyer identity
to fix a private service hop would break recovery ownership. Hosting that demo UI
on Cloud Run requires a separately reviewed deployment/guard design.

The ordinary shared Axios path also refuses remote catalog HTTP in rehearsal
mode before its adapter dispatches, including upstream search fallback and
product-detail/group/review hydration. The server's exact loopback invoke path
is allowed. Private auth may also POST to only the exact configured backend
`/agent/internal/auth/introspect` path after the private-hop contract validates
the stable audience and receiving origin. Query/hash/userinfo, other backend
paths and redirects are refused. The private-hop interceptor must run this
check before metadata/token work. This is an extra source defense;
transports outside that shared client still require the independent runtime
allowlist. Reap's explicitly configured backend transport remains governed by
that separate target/auth policy.

Lip-ink queries use their own named product-form evidence at query understanding,
canonical SQL admission and the serving hard gate. Generic root-only beauty rows
must name lip ink in their own title/name/type; descriptions and cross-sell copy
cannot admit them. This does not reinterpret lip ink as a strict lipstick claim
or change stored categories or proof clocks.
