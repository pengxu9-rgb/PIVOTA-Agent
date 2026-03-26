## Desktop To Dev Migration Audit

Date: `2026-03-22`

Working repo:
- `~/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend`

Reference-only repo:
- `~/Desktop/Pivota Infra/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend`

### Decision

Do not wholesale copy the recent `Desktop` route/bootstrap refactor back into `~/dev`.

The `~/dev` repo already contains the newer commerce and support-surface owner modules, including:

- `src/bootstrapGatewaySupportSurface.js`
- `src/createHealthRouteHandler.js`
- `src/registerGatewayBaseMiddleware.js`
- `src/registerGatewaySupportRoutes.js`
- `src/registerMerchantOpsRoutes.js`
- `src/registerAdminDiagnosticsRoutes.js`
- `src/registerProductResolveRoute.js`

In the comparison on `2026-03-22`, the `Desktop` versions of those files were either:

- older/smaller wrappers
- behaviorally different in ways that would regress `~/dev`
- or missing pieces already present in `~/dev`

### What Was Corrected

- repo-root instructions that still pointed at `~/Desktop` were updated to `~/dev`
- `~/Desktop` remains reference-only and should not be used for test/release work

### Desktop-Only Files Not Auto-Migrated

The remaining files that exist only in `Desktop` are on different feature lines and were intentionally not auto-copied into `~/dev`:

- `src/auroraBff/ingredientReferenceOverlay.js`
- `src/db/migrations/025_aurora_profile_identity_fields.sql`
- `tests/aurora_profile_identity_fields.node.test.cjs`
- `tests/aurora_returning_progress.node.test.cjs`
- `tests/creator_invoke_key_isolation.test.js`
- `tests/ingredient_reference_overlay.node.test.cjs`
- `tests/ingredient_reference_runtime_scripts.node.test.cjs`
- `tests/ingredient_reference_seed_bundle_export.node.test.cjs`
- `scripts/_ingredient_reference_workbook.py`
- `scripts/investigate_aurora_routine_chain.js`
- `tests/test_ingredient_reference_review_queue_tools.py`

These need separate triage before any migration because they are not part of the mistaken bootstrap/support-surface refactor path.

### File-Level Classification

#### Already Covered In `~/dev`

- `tests/creator_invoke_key_isolation.test.js`
  - Covered by existing invoke auth coverage in:
    - `tests/invoke_external_key_auth.test.js`
    - `tests/commerce/externalInvokeAuth.test.js`
  - Do not port as a duplicate test without a new auth contract gap.

- `src/auroraBff/ingredientReferenceOverlay.js`
- `tests/ingredient_reference_overlay.node.test.cjs`
  - `~/dev` already has ingredient-reference runtime behavior integrated directly in `src/auroraBff/routes.js`
  - Existing owner-level coverage already exists in:
    - `tests/aurora_bff_ingredient_reference_runtime.node.test.cjs`
    - `tests/aurora_bff_ingredient_signal_runtime.node.test.cjs`
  - Porting this standalone helper as-is would duplicate logic that is already embedded and tested in the real repo.

#### Separate Feature Tranche Required

- `src/db/migrations/025_aurora_profile_identity_fields.sql`
- `tests/aurora_profile_identity_fields.node.test.cjs`
  - This is a profile-identity schema/product feature, not part of the accidental `Desktop` bootstrap refactor.
  - `~/dev` currently has `extractProfilePatchFromSession(...)` / `summarizeProfileForContext(...)`, but not this exact `displayName/avatarUrl` persistence contract.
  - If desired, migrate in a dedicated Aurora profile tranche with DB migration + schema/runtime + tests together.

- `tests/aurora_returning_progress.node.test.cjs`
  - This targets a returning-user diagnosis/progress conversation path that does not exist in the current `~/dev` branch as a drop-in behavior.
  - Requires dedicated Aurora product work; do not cherry-pick as an isolated test.

- `scripts/_ingredient_reference_workbook.py`
- `tests/ingredient_reference_runtime_scripts.node.test.cjs`
- `tests/ingredient_reference_seed_bundle_export.node.test.cjs`
- `tests/test_ingredient_reference_review_queue_tools.py`
  - These belong to the ingredient-reference operator/tooling line.
  - They should be migrated only as one coherent tooling tranche, not as fallout from the mistaken repo selection.

- `scripts/investigate_aurora_routine_chain.js`
  - Operator investigation utility for Aurora routine/debug flows.
  - Useful, but independent from the bootstrap/support-surface correction. Migrate only if we explicitly want this operator script in `~/dev`.

### Direct Migration Queue

Current direct migration queue from `Desktop` to `~/dev`: empty.

Meaning:

- no bootstrap/support-route owner files should be copied from `Desktop`
- no route-shell test files should be copied from `Desktop`
- any further migration should happen only by explicit feature tranche, not by repo sync

### Rule Going Forward

- Code changes: `~/dev` only
- Tests/releases: `~/dev` only
- `~/Desktop`: diff/reference only
