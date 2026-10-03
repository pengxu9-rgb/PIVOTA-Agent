# Reap primary checkout policy

Effective 2026-10-03. This policy replaces the earlier variant-refusal-to-cart retry and storefront/kernel fallback behavior described in historical Reap lane notes.

A UCP request containing `checkout.reap` selects Reap as its primary route. A row, configuration, caller, variant, pricing, seller or purchasability exclusion stops that selected route before another checkout can be opened or offered. Generic native UCP requests without a Reap selection retain their existing native behavior.

`checkout.reap.item_source` may explicitly name `reap_variant` or `cart_link`. The source is selected before any backend create. Shopify rows may select cart links directly; the cart-link dial and the row's resolvable variant checks must pass, and the backend remains authoritative for current stored eligibility, proof and pilot scope. An external-seed row may also be classified as an initial cart-link route. None of these selections may be changed after a refusal. In particular, `merchant_not_eligible` no longer retries a different body/key namespace.

Each Reap dispatch has one of three outcomes:

* Accepted: return the Reap purchase's view and poll that purchase.
* Authoritative refusal: stop with `OPERATION_NOT_ALLOWED`, reason `ucp_reap_create_refused`; no alternative checkout or storefront link.
* Unknown: preserve the exact attempt and return `CHECKOUT_OUTCOME_UNKNOWN`. Conflicts, gates, authentication/rate/platform responses, malformed bodies, transport failures and timeouts cannot authorize another create.

The backend client's conservative refusal parser is shared by ordinary and private transport. It accepts only recognized 400/409 reasons with matching statuses and coherent flat, nested or full-main error envelopes. A full-main envelope must agree on status, error class, message and detail reason. Transport configuration never relaxes this parser.

`recover_checkout` is read-only. An explicit original source queries only that original namespace, using the original body, buyer and derived key. Historical attempts without a source may probe both legacy namespaces using SQL identity reads; this never creates a purchase or fetches a merchant/proof. Changing current source/eligibility switches does not reinterpret the original request. An unresolved or ambiguous read remains unknown.

Owned `reap_` IDs never enter the kernel when their primary reader is unavailable. An authoritative owner miss is answered directly with `QUOTE_NOT_FOUND`; other unavailable reads preserve uncertainty. Generic non-Reap IDs keep their own route.

Release acceptance must demonstrate one selected source, one create request/key, owner polling, exact read-only recovery, and zero alternate create requests or storefront redirects. A provider simulation proves sandbox checkout behavior only; it does not establish merchant fulfillment.
