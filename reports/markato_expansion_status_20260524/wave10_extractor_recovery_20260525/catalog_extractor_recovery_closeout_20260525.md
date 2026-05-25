# Markato Wave10 Catalog Extractor Recovery Closeout - 2026-05-25

## Scope

Follow-up to wave9 source recovery holds. The blocking issue was in `Pivota-catalog-intelligence`, not in the PIVOTA-Agent seed wrapper:

- KHUS KHUS direct PDP was blocked by bot-challenge fallback quality because the JSON-LD offer had no price and the DOM price was not used in the single-offer branch.
- Apiceuticals direct PDP was losing a usable prefetched WooCommerce product when the live browser context was destroyed.
- LIME was already commerce-extractable, but official PDP text remains empty/image-only, so it remains a content quality hold.

## Catalog-Intelligence Changes

Repository: `pengxu9-rgb/Pivota-catalog-intelligence`

Pushed to `main` via `git push` only:

- `0f83f1b421f731a1fc50ef3565cf746992071afb` - `Recover Markato WooCommerce PDP extraction`
- `1262847d383591d765c34295099f00be01b7d974` - `Relax prefetched PDP gallery gate`

Implemented:

- Preserve a usable prefetched direct PDP when browser render fails with a non-bot error.
- Add DOM price fallback for single JSON-LD offers without an offer price.
- Recognize WooCommerce `/shop/{product-slug}/` direct PDPs inside the strict prefetched-product gate.
- Extract WooCommerce short descriptions and Visual Composer accordion content.
- Filter WooCommerce review-form noise such as `Leave feedback about this Cancel reply`.
- Keep the prefetched fallback gate source-backed: title, product URL shape, clean image assets, positive offer price, and product context are still required.

## Verification

Local tests:

- `test/puppeteer.shopify-seed.test.ts`: 57 passed
- `test/shared.extractor-hardening.test.ts`: 62 passed

Production deploy verification:

- Railway service `Pivota-catalog-intelligence` production latest deployment reports commit `1262847d383591d765c34295099f00be01b7d974`.
- No `railway up` was used.

Production read-only extractor probes after deploy:

| Brand | Seed | Products | Variants | Result | Remaining quality hold |
|---|---:|---:|---:|---|---|
| Apiceuticals | `https://www.apiceuticals.com/shop/propowax-antioxidant-shampoo/` | 1 | 1 | recovered official PDP content, how-to, FAQ, images, size, price | missing full INCI |
| KHUS KHUS | `https://khus-khus.com/products/c-drops-serum/` | 1 | 1 | recovered official PDP content, image, SKU, price after bot-challenge fallback | missing how-to and full INCI |
| LIME | `https://en.limecosmetic.com/product/lime-oil-gel-eye-patch/72` | 1 | 3 | unchanged commerce extraction | missing overview, how-to, full INCI |

## Quality Decision

No production DB apply in this wave.

Recovered products are now source-visible to the catalog extractor, but they are not ready for public PDP catalog promotion under the current quality bar:

- Apiceuticals has strong official overview/how-to/FAQ, but no source-backed full INCI. Treat as `thin` until the INCI modal/source is recovered or manually reviewed.
- KHUS KHUS has official product context and price, but no source-backed how-to or full INCI. Treat as `thin`.
- LIME remains a thin/image-only content hold.

Next recommended step: target official full-INCI recovery for Apiceuticals first, because it is closest to ready after this extractor fix.
