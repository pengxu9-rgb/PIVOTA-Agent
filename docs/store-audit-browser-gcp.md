# Store Audit browser job on GCP

Build this image separately from the gateway. It is the only image allowed to
run the Playwright storefront probe and is deployed only as the
`store-audit-commerce-probe` Cloud Run Job on the `pivota-crawl` subnet.

The image is not a web service and has no database or payment credentials. Its
only secret is `STORE_AUDIT_COMMERCE_PROBE_INTERNAL_KEY`, used for the
backend-only claim/receipt contract. Browser traffic uses the connection-bound
public-only CONNECT proxy implemented in the worker, and QUIC is disabled.

The job remains paused until the backend deployment, dedicated identity,
receipt contract, source policy, and reviewed dry-run are all in place.
