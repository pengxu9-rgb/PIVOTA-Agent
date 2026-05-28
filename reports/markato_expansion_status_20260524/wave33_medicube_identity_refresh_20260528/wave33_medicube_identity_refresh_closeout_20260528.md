# Wave33 Medicube Identity Refresh Closeout

Generated: 2026-05-28

## Scope

- Target: `medicube.us`
- Product: `ext_37711c1df803ce80b791b2c5` / `Collagen Night Wrapping Mask`
- Change type: production identity alignment only
- No deploy was run.

## Precheck

Exact readiness before the write:

- scanned rows: 1
- action required rows: 1
- blocker: `identity_blocked`
- direct high-quality product-intel KB: 1/1
- catalog rows: 1/1
- public dry-run docs: 0

The alignment dry-run without the explicit reviewed-singleton gate stayed blocked on `identity_review_required`.

The gated dry-run with `--allow-reviewed-product-line-singletons` passed:

- status: `success`
- align ready: 1
- held: 0
- evidence: brand-tier source, exact official URL/title match, `variant_axes.multi_variant=true`, review reasons limited to `multi_variant_exact_item_unresolved` and `insufficient_exact_item_evidence`

## Production Apply

Applied command class:

- `scripts/align-external-seed-identity-to-catalog-sig.cjs`
- `--allow-reviewed-product-line-singletons`
- `--write --confirm ALIGN_REVIEWED_EXTERNAL_SEED_IDENTITY_TO_CATALOG_SIG`

Apply result:

- override upserts: 1
- identity rows updated: 1
- target catalog sig: `sig_3bba045e1627f41cd1163b3f0e548c9d`

## Postcheck

Exact readiness after the write:

- action required rows: 0
- DB serving ready: 1/1
- public index ready: 1/1
- identity ready: 1/1
- public dry-run docs: 1
- docs with Pivota insight summary: 1
- warnings: 0

Live PDP module quality:

- scanned: 1
- pass: 1
- blockers: 0

## Rollup Result

Current Markato rollup after this fix and the duplicate-canonical gate:

- production rows scanned: 597
- catalog attached: 597/597
- index serving eligible: 295/597
- identity ready: 317/597
- high-quality product intel: 373/597
- ready or covered: 89
- recommended next-batch rows: 0

The prior remaining Joocyee rows are no longer classified as plain `serving_index_sync`; they are held as `duplicate_canonical_identity_review`.

## Artifacts

- `identity_align_dry_run.json`
- `identity_align_reviewed_singleton_dry_run.json`
- `identity_align_apply.json`
- `readiness_before_identity_refresh/`
- `readiness_after_identity_refresh/`
- `live_pdp_modules_audit_after_identity_refresh.json`
- `../wave33_current_rollup_after_duplicate_gate_20260528/`
