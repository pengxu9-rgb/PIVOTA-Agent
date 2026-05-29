# Wave64 RMS Retailer Offer Attachment Closeout - 2026-05-29

## Scope

Reviewed the current production state for the two Dermstore RMS retailer-offer rows from Wave61/Wave62 and their official RMS parent rows after the Wave63 taxonomy apply.

This wave was read-only. It did not write production data, update runtime tables, promote serving rows, deploy code, or run `railway up`.

## Reviewed Rows

| Role | Domain | External product id | Title |
| --- | --- | --- | --- |
| Retailer offer | dermstore.com | `ext_1cc14ab28dee629b0bb1d3db` | RMS Beauty Radiance Lock Setting Mist 100ml |
| Official parent | rmsbeauty.com | `ext_f16d1ed12f9f2c9966d47d78` | Radiance Lock Setting Mist |
| Retailer offer | dermstore.com | `ext_b8af61a562f4ab972197f413` | RMS Beauty Revitalize Hydra Concealer 0.17fl oz (Various Shades) |
| Official parent | rmsbeauty.com | `ext_1c6390a4583df99215617f2b` | Revitalize Hydra Concealer |

## Current State

The production probe found 4 seed rows, 4 identity rows, 4 catalog rows, and 4 index rows. All 4 seed rows are catalog-attached.

Both Dermstore rows already have `source_role=retailer_offer`, `source_listing_scope=retailer_offer`, passing commerce facts gates, and approved reviewed merge candidates:

- `ext_1cc14ab28dee629b0bb1d3db` targets `external_seed:ext_f16d1ed12f9f2c9966d47d78`.
- `ext_b8af61a562f4ab972197f413` targets `external_seed:ext_1c6390a4583df99215617f2b`.

Both Dermstore identity rows are already approved under `matched_by_rule=reviewed_multi_offer_merge`, share the official parent sellable group, and keep `live_read_enabled=false`. That is the correct shape for retailer-offer mirrors: they contribute offer/identity context without becoming standalone public PDPs.

## Verification

KB/commerce readiness over the four-row scope:

- Scanned rows: 4
- DB serving ready: 2
- Public index ready dry-run: 2
- Direct high-quality KB ready: 4
- Identity ready: 2
- Action-required rows: 2
- Main blocker for the 2 merchant rows: `identity_blocked` / `not_live_read_enabled`
- Warnings: 0

Live PDP module audit over the four-row scope:

- Scanned rows: 4
- Ready: 2
- Thin: 0
- Not conversion ready: 2
- Ready rows: the 2 official RMS parent rows
- Not conversion ready rows: the 2 Dermstore retailer-offer mirrors
- Weak/content-gap ids: `ext_b8af61a562f4ab972197f413`, `ext_1cc14ab28dee629b0bb1d3db`

## Decision

No retailer-offer attachment write is needed. The attachment and reviewed identity merge already exist in production.

Do not force `live_read_enabled=true` on the Dermstore rows. Their standalone PDP audits are intentionally not ready, and the public-ready surface is the official RMS parent row for each product.

Remaining RMS-only follow-up is limited to the Wave63 taxonomy conflict on `ext_f16d1ed12f9f2c9966d47d78` if we decide to overwrite the existing `Treatment` category. That row is already public-ready, so the next expansion move should shift to a new brand/source-gap backlog rather than continue forcing RMS.

## Artifacts

- `rms_offer_current_state.json`
- `rms_offer_attachment_review_summary.csv`
- `kb_readiness_offer_scope/`
- `live_pdp_modules_offer_scope.json`
- `wave64_rms_retailer_offer_attachment_closeout_20260529.md`
