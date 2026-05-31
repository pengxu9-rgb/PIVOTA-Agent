# Wave97 Identity Refresh Partial Closeout

Generated: 2026-05-31

## Scope

Wave97 continued Markato US brand expansion from the post-Wave96 production state. The fresh production-backed rollup was generated under:

- `current_rollup_after_wave96/`

Rollup summary:

- Production rows scanned: 5,770
- Catalog attached: 5,770 / 5,770
- Index serving eligible: 4,476 / 5,770
- Identity ready: 5,118 / 5,770
- Product intel high quality: 4,100 / 5,770
- Actionable next batch rows: 281
- Source gap rows: 1,098
- Risk hold rows: 2,953

## Reviewed Candidate Selection

Initial exact-ID candidate file:

- `wave97_identity_refresh_candidate_ids.txt`

This contained 11 approved/non-review-required identity-refresh candidates from the fresh rollup.

Dry run result:

- Requested: 11
- Fetched: 11
- Mirror rows: 10
- Skipped: 1
- Planned SKU rows: 10
- Planned offer rows: 10
- Planned index state rows: 10

Gate decisions:

- `ext_b8af61a562f4ab972197f413` RMS Beauty Revitalize Hydra Concealer was skipped due `duplicate_pivota_signature_conflict` with an existing RMS official brand URL product.
- Four Soko Glam channel rows remained blocked by `identity_not_live_approved` and were not applied.

## Production Apply

Applied only the six clean exact IDs in:

- `wave97_identity_refresh_apply_ids.txt`

Applied IDs:

- `ext_81d3882e68c275747ef88b3f` Anua Golden Honmoon Barrier Collagen Mask 4ea
- `ext_a406636157366f31879c4cbe` Anua Rumi Ultra-thin Spot Cover Patch (55ea)
- `ext_04f175344e976ae32c16abad` Native Atlas RESTORING Cleansing Oil
- `ext_b0e98400b870b8783629e14a` Reap & Glow Coffee Fruit Antioxidant Cleanser
- `ext_b20d88539f9351b8db39595d` Reap & Glow Ayurvedic Deep Hydrating Rejuvenation Creme
- `ext_c2aca294e6409ceced3da49b` Reap & Glow Turmeric Peptide Firming & Smoothing Serum

Apply artifact:

- `wave97_identity_refresh_apply.json`

Apply result:

- Requested: 6
- Fetched: 6
- Mirror rows: 6
- Skipped: 0
- Product upserts: 6
- SKU upserts: 6
- Offer upserts: 6
- Index state upserts: 6
- Identity live-read updates: 6
- Catalog row trust upserts: 6
- Stale SKU deletes: 8
- Stale offer deletes: 6

## Post-Apply DB Readiness

Readiness artifact:

- `readiness_after_identity_refresh/summary.json`

Result:

- Scanned rows: 6
- Terminal holds: 0
- Identity ready rows: 6
- KB direct displayable: 6
- KB direct high quality ready: 6
- Public dry-run docs built: 6
- DB serving ready: 5
- Public index ready: 5
- Action required: 1

The one remaining action-required row is:

- `ext_a406636157366f31879c4cbe` Anua Rumi Ultra-thin Spot Cover Patch (55ea)
- Blocker: `seed_content_blocked`
- Detail: `missing:category`

## Category Repair Prepared

Reviewed category patch manifest:

- `anua_rumi_reviewed_category_patch_manifest.json`

Category decision:

- Category: `Blemish Patch`
- Product type: `Blemish Patch`
- Category path: `beauty/skincare/acne-treatment`
- Evidence: official Anua PDP title/description identifies the product as an ultra-thin hydrocolloid spot patch for blemish areas and post-extraction spots.

Dry-run artifact:

- `anua_rumi_category_patch_dry_run.json`

Dry-run result:

- Scanned: 1
- Planned: 1
- Blocked: 0
- Missing: 0
- Patch keys: `category`, `product_type`, `category_path`, `catalog_category_path`

Apply artifact:

- `anua_rumi_category_patch_apply.json`

Apply result:

- Scanned: 1
- Planned: 1
- Updated: 1
- Catalog product updates: 1
- Identity updates: 1
- Blocking reasons: 0

## Post-Category Readiness

Readiness artifact:

- `readiness_after_category_patch/summary.json`

Result:

- Scanned rows: 6
- Terminal holds: 0
- Identity ready rows: 6
- KB direct displayable: 6
- KB direct high quality ready: 6
- Public dry-run docs built: 0
- DB serving ready: 0
- Public index ready: 0
- Action required: 6
- Blocker: `index_doc_shadow_only`

This is not a source/identity/K knowledge quality regression: identity and KB still pass for all six rows. It appears to require an exact-ID catalog/serving/index resync after the category payload update. An exact six-ID resync dry run was attempted next, but Railway CLI/backboard TLS and transient Postgres connection resets prevented the dry run from completing.

## Validation Blocker

After the identity-refresh production write and DB readiness audit completed, local HTTPS/TLS connections started failing for all tested external endpoints:

- Railway backboard: TLS handshake EOF
- Railway production `/version`: `SSL_ERROR_SYSCALL`
- Public gateway `agent.pivota.cc`: `SSL_ERROR_SYSCALL` / TLS connection reset
- GitHub: `SSL_ERROR_SYSCALL`

Because of this network failure, the following remain pending:

- Complete an exact six-ID catalog/serving/index resync dry run and apply if clean.
- Rerun exact-ID DB readiness after the resync.
- Run direct public gateway signature PDP/similar probes.

## Git Status

The Wave97 report/artifact commit was created locally and pushed to the work branch after retrying Git with HTTP/1.1:

- Commit: `842a04d2 Document Markato wave97 identity refresh`
- Branch: `origin/work/markato-wave25-786-serving-20260527`

The one-row category patch was later applied successfully through `railway run` after retrying transient Railway failures. The subsequent exact readiness audit completed, but showed all six rows as `index_doc_shadow_only`, so the remaining production action is an exact serving/index resync rather than another identity or source recovery patch.

Public gateway signature PDP/similar probes also remain pending. The sandbox escalation reviewer blocked the read-only probe because it would send signature IDs and product metadata to `agent.pivota.cc`; explicit user approval is required before retrying that probe from the escalated sandbox.

## Guardrails Preserved

- No `railway up` was run.
- Production write was limited to exact IDs after dry-run review.
- Review-required and duplicate-signature candidates were not forced.
- Live PDP success is not claimed yet because public gateway validation is blocked by local TLS failure.

## Next Commands When Network Recovers

Run the exact six-ID serving/index resync dry run:

```bash
railway run --service Postgres-xMr6 --environment production -- bash -lc 'cd /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527 && export DATABASE_URL="$DATABASE_PUBLIC_URL" && export NODE_PATH=/private/tmp/markato-wave-node-deps/node_modules:/Users/pengchydan/dev/PIVOTA-Agent/node_modules && node scripts/sync-external-seeds-to-catalog.cjs --external-product-ids-file reports/markato_expansion_status_20260524/wave97_next_expansion_20260531/wave97_identity_refresh_apply_ids.txt --market US --dry-run --upsert-serving-state --bootstrap-reviewed-identity-live-read --out reports/markato_expansion_status_20260524/wave97_next_expansion_20260531/wave97_serving_resync_after_category_patch_dry_run.json'
```

Then apply the same exact-ID resync if the dry run is clean, rerun exact-ID readiness, and run direct public signature probes before claiming Wave97 conversion readiness.
