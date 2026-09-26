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

## Store Readiness journey

For a merchant-authorized product URL, one job checks these bounded steps:

1. load the public storefront;
2. search the storefront for the product title and confirm the same PDP link;
3. confirm the product detail page exposes a purchasable item;
4. add one item to the cart;
5. reach guest checkout and fill Pivota-owned synthetic shipping fields; and
6. confirm the checkout route is present.

The receipt contains only enumerated step names, statuses, and reason codes.
It never contains page text, URLs, cookies, or submitted form values. The job
does not enter payment data and must never click a pay, place-order, or
complete-order control.
