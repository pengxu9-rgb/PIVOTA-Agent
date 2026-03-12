# Aurora Routine Analysis V2 Release Verification

Date: March 12, 2026
Status: PASS

## Scope

This note covers the production rollout verification for Aurora Beauty Routine Analysis V2 only.

- Live backend entrypoint: `/v1/analysis/skin`
- Live frontend entry: `https://aurora.pivota.cc/chat`
- Non-canonical surface: `routine.audit_optimize` was not used for this rollout

## Production Versions Verified

- Backend service commit observed in production response headers: `c8e8b50a05d3`
- Frontend Git commit verified on `origin/main`: `7762a35`

## Local Regression Checks

The following backend regression suite passed before final verification:

```bash
NODE_PATH=/Users/pengchydan/dev/PIVOTA-Agent/node_modules \
  node --test tests/aurora_bff_routine_analysis_v2.node.test.cjs
```

The following frontend checks were already used to validate the routine-entry fix:

```bash
vitest run src/test/bffchat_routine_entry_stability.test.tsx src/test/agent_state_machine.test.ts
npm run typecheck
```

## Production Frontend Verification

Real-browser verification was run against `https://aurora.pivota.cc/chat`.

Expected result:

- Clicking `Build an AM/PM routine` opens the structured routine intake sheet
- The flow does not fall back to a generic text answer

Observed result:

- PASS
- The routine intake sheet opened with `Add your AM/PM products (more accurate)`

## Production Backend Verification

Real requests were sent to the live `/v1/analysis/skin` route with routine payloads.

### Case: complete_basic

Observed:

- Cards: `routine_product_audit_v1`, `routine_adjustment_plan_v1`
- `top_adjustments=[]`
- No recommendation card
- No weak eye-product or monitor-style adjustment noise

Result: PASS

### Case: missing_spf_guidance_only

Observed:

- Cards: `routine_product_audit_v1`, `routine_adjustment_plan_v1`, `routine_recommendation_v1`
- Top adjustment: `Add a clear AM sunscreen step`
- Recommendation output is guidance-only for sunscreen
- No extra PM cleanser recommendation noise

Result: PASS

### Case: active_overlap

Observed:

- Cards: `routine_product_audit_v1`, `routine_adjustment_plan_v1`
- Top adjustment: `Reduce the frequency of Glycolic Acid serum`
- Overlap signal: `Potential irritation from combining Tretinoin and Glycolic Acid`
- No extra `Ceramide NP` add-step noise

Result: PASS

### Case: am_only_pm_empty

Observed:

- No hallucinated PM products
- Duplicate unresolved recommendation notes removed

Result: PASS

### Case: over_8_products

Observed:

- `audited_product_count=8`
- Deferred products are moved into `additional_items_needing_verification`
- No false cleanser or sunscreen gap introduced from deferred items

Result: PASS

## Release Verdict

Routine Analysis V2 is live and verified in production.

The release is acceptable to keep enabled because:

- The frontend routine entry now opens the structured intake flow
- The backend response has switched to the V2 card sequence
- Weak recommendation and weak adjustment noise observed in earlier validation rounds has been removed
- Core downgrade behavior for `product_count > 8` remains intact

## Follow-up Guardrails

The following constraints should remain true in future regression checks:

- `complete_basic` should not render a recommendation card
- `missing_spf_guidance_only` should render only the sunscreen guidance group
- `active_overlap` should not add ingredient-bucket filler adjustments
- `am_only_pm_empty` must not invent PM products
- `over_8_products` must not convert deferred items into false missing-step gaps
