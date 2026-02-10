# Photo Modules Rollout Guide

Last updated: 2026-02-09

## Scope

This guide covers rollout for `photo_modules_v1` (client-render overlay only).

- Backend emits card when `DIAG_PHOTO_MODULES_CARD=true`.
- Frontend renders `photo_modules_v1` card behind its own feature flag.
- Backend does not generate overlay image files/URLs.

## Flags

Backend:

- `DIAG_PHOTO_MODULES_CARD` (default `false`)
- `DIAG_OVERLAY_MODE=client` (fixed for this rollout)
- `DIAG_INGREDIENT_REC=true` (enabled when card is enabled)
- `DIAG_PRODUCT_REC=false` (default off in initial rollout)

Frontend:

- `VITE_PHOTO_MODULES_CARD` (or equivalent UI flag)
- `VITE_DIAG_PRODUCT_REC` (optional; only if backend products are enabled)

## Recommended rollout

1. **0% (dark launch)**
   - Keep backend card flag off.
   - Deploy frontend support first; verify no regressions with missing card.

2. **1%**
   - Enable `DIAG_PHOTO_MODULES_CARD` for 1% traffic.
   - Keep `DIAG_PRODUCT_REC=false`.
   - Focus on card render success and schema-fail downgrade rates.

3. **5%**
   - Expand only if no spike on schema failures, sanitizer drops, or client errors.
   - Continue ingredient actions only for `quality_grade=degraded`.

4. **20%**
   - Validate engagement KPI trend before wider rollout.
   - Keep product recommendations disabled unless explicit readiness sign-off.

5. **100%**
   - Promote after stable KPI + error window over at least one business day.

## Version mismatch safety

- Frontend new + backend old: no card, no crash.
- Backend new + frontend old: unknown card ignored by existing card pipeline.
- Frontend schema parser failure: downgrade to text fallback, emit schema-fail telemetry.

## Rollback

Fastest rollback options:

1. **Backend rollback (primary)**
   - Set `DIAG_PHOTO_MODULES_CARD=false`.
   - Stops `photo_modules_v1` emission immediately.

2. **Frontend rollback (secondary)**
   - Disable frontend photo modules feature flag.
   - Card stays hidden even if backend still emits it.

3. **Product rec rollback**
   - Set `DIAG_PRODUCT_REC=false` (backend) and/or frontend product flag off.
   - Ingredient actions remain available.

## Degraded-mode policy

- For `quality_grade=degraded`: show module issues + ingredient actions.
- Product recommendations remain beta/off by default.
- For `quality_grade=fail` or `used_photos=false`: do not show `photo_modules_v1`; keep retake/fallback flow.

## Operational checks

- Run `make photo-modules-acceptance` before each rollout stage.
- Confirm no privacy regression in `reports/analytics_audit.md`.
- Confirm acceptance reports:
  - `reports/photo_modules_backend_acceptance.md`
  - `reports/photo_modules_frontend_acceptance.md`
