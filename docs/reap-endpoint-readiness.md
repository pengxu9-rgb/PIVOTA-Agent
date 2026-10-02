# Reap endpoint readiness

## Reviewed state, 2 October 2026

Read-only Cloud Run/profile checks at 07:17 Asia/Shanghai found:

| Environment | Gateway image | Explicit UCP base | Advertised UCP MCP endpoint |
| --- | --- | --- | --- |
| Staging | `873b607274b5a45f1714818f733172f6ffcce89c` | absent | `https://commerce.mcp.pivota.cc/ucp/mcp` |
| Production | `0b5a17c18c386e797a67cac00450e0f672d55268` | absent | `https://commerce.mcp.pivota.cc/ucp/mcp` |

Both revisions set `MCP_OAUTH_RESOURCE=https://commerce.mcp.pivota.cc/mcp`.
The profile builder uses `UCP_BASE_URL`, then `AGENT_CHECKOUT_UCP_BASE_URL`,
then the OAuth resource origin. It never takes the origin from a request header.
Production's commerce host is an intentional documented MCP topology (see
`adr_mcp_oauth_authorization_server.md`), so this review does not replace it.
The private partner guide's production example currently uses
`https://gateway.pivota.cc/ucp/mcp`; its canonical hostname still needs resolution.

## Staging change to review before execution

Set only the authoritative discovery origin on the staging gateway:

```bash
gcloud run services update gateway --project=pivota-staging --region=us-west1 \
  --update-env-vars=UCP_BASE_URL=https://gateway-42ogcsuwxq-uw.a.run.app
```

This is a proposed infrastructure mutation, not a command executed by the tests
or this review. Preserve OAuth resource/audience and issuer settings: the
discovery URL and a registered JWT audience are separate configuration contracts.
Do not infer an audience change from the new discovery host. Do not change
production endpoints or enable discount flags as part of this correction.

Acceptance:

1. Record serving revision, traffic, `PIVOTA_API_BASE` and profile response. The
   staging profile must advertise the staging `/ucp/mcp` origin and live features.
2. With a registered sandbox agent and its short-lived buyer JWT, read
   `tools/list` and an already-owned `get_checkout` using the advertised endpoint.
   Verify the same agent/buyer context and staging backend; wrong agent/audience
   must fail. A 200 discovery response or unauthenticated 401 is insufficient.
3. Test first-time and returning enrollment, idempotent create/replay, variant,
   quantity and advertised discount behavior in the gated staging rehearsal.
4. Check hostile `Host`/`X-Forwarded-Host` cannot alter discovery. The automated
   route tests pin explicit origin precedence and this invariant.

For production, first prove which hostname routes to the intended gateway with
the same authenticated context. Use a read-only tool/owned checkout probe,
not a purchase create. Check the profile, TLS, OAuth challenge/resource metadata,
registered audience and backend routing on both commerce and gateway hosts.
Then make the private guide consistent with the approved canonical route; do not
publish until the rail, terms/support and feature gates are ready. Production
currently does not advertise discounts, matching its disabled Reap offer lane.

## Pilot rollback and issuer removal gates

The current master flags are not create-only switches. Disabling
`REAP_AGENTIC_LANE_ENABLED` skips both gateway create and get interception;
the backend's `REAP_AGENTIC_ENABLED` gates GET routes and worker progression.
The proposed `REAP_AGENTIC_CREATE_ENABLED=0` gate stops Reap creates with a
named `reap_create_paused` refusal, withholds new Reap seller/discount advertising,
and leaves owner-authenticated GET available while the master lane stays on.
Unset preserves current behavior; invalid explicit values fail closed. Native
rows retain their existing checkout path. This is a code change to review and
stage, not a live flag change made by this review. Before a payment, also provide
and test a pilot agent/merchant/market restriction and the backend create-only
pause; a gateway-only gate cannot protect direct backend creates. Do not use a master shutdown as the routine rollback for exposed checkouts.

Federated issuer bindings refresh after 60 seconds by default. During registry
outage they may remain trusted for up to 15 minutes before failing closed; a
five-minute pilot token also expires naturally. Removing a binding is not
immediate cache invalidation. Remove temporary access only after purchase
reconciliation, test old-token refusal on every serving revision after refresh,
and preserve an authenticated support/reconciliation path. Never log token/key
material while verifying removal.


## Create uncertainty contract

After dispatching a Reap create POST, transport loss, timeout, 5xx, malformed
accepted response and idempotency conflict produce `CHECKOUT_OUTCOME_UNKNOWN`,
`retriable=true`, with `detail.reason=ucp_reap_create_outcome_unknown`. The tool
response tells the client to retry only the identical payload and original
idempotency key; it carries no alternate checkout URL and no buyer/key values.
Both the variant request and the optional cart-link retry obey this rule.
Deterministic pre-create merchant/catalog refusals retain the existing fallback.
A paused backend returns a refusal rather than a new spending alternative.

An unknown create without a recovered checkout ID must remain unresolved during
rollout rollback. The Pivota vendor UCP tool `recover_checkout` accepts the same
original create arguments and idempotency key, with a verified buyer/session and
the same agent credentials. It is advertised while the master lane is enabled,
including when new creates are paused. Native MCP tool names are unchanged.
Older gateways reject this distinct tool name; recovery is never an optional
create flag that an older deployment could ignore.

Recovery reconstructs the normalized create body through a dedicated,
parameterized `catalog_products` SELECT of stored key/host identity. It does
not use `get_product`, PDP enrichment, storefront variants, provider calls,
current prices, catalog serving gates or purchase proofs. Missing, changed or
ambiguous identity stays unknown; unsupported catalog aliases or missing stored
host payloads require an authenticated support lookup. Before staging, verify the
gateway SQL service points at the same intended catalog and the current schema
contains all selected identity columns. It probes only the original derived variant and/or
cart-link key namespaces with backend `POST /agent/v2/commerce/reap/purchases/recover`.
That endpoint must perform owner-scoped SELECT and the existing request-hash
comparison only, including beyond the old 24-hour key lifetime. No lookup result
permits a fresh create, key rollover or alternate checkout. Missing records,
tombstones, conflicts, outages and malformed views all remain unresolved.

A unique exact match becomes an owner checkout using stored totals and the
existing status/deadline mapping. An expired hosted URL never becomes a new
checkout or a fresh payment link. The buyer attempt unlocks only when the UI's
explicit recovered-state contract allows it; a pause or 404 is insufficient.

Stage backend lifetime-key/recovery support first, then the gateway tool, then
the UI's explicit recovery routing. Keep the master lane enabled for existing
checkout GET/status while new creation is paused. Rehearse an uncertain create,
paused recovery with its original key/body, changed-payload conflict, missing
record, old-key recovery and expired hosted action with the same real caller
context. The local transport/parity tests are code evidence; they do not prove
this authenticated deployed route. Do not briefly reopen creates to recover an
unknown attempt. Do not unlock it or manufacture a new key because of a pause.
