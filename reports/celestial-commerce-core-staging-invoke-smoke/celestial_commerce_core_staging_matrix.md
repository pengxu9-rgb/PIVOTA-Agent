# Celestial Commerce Core Staging Acceptance Matrix

- Generated at: 2026-08-21T00:03:42.909Z
- Base URL: http://127.0.0.1:50221
- Cases file: `/Users/pengchydan/dev/_worktrees/ci-internal-key/scripts/fixtures/celestial_commerce_core_staging_invoke_smoke.json`
- Total cases: 1
- Pass: 0
- Fail: 0
- Review required: 1
- Infra blocked: 1
- Primary-path degraded: 0
- Main-path pass count: 0
- service_version.commit missing: 0
- Blocking failures: 0

## Section Summary

| Section | Pass | Fail | Review required |
| --- | ---: | ---: | ---: |
| Correctness | 0 | 0 | 1 |
| Ownership | 0 | 0 | 1 |
| Observability | 0 | 0 | 1 |

## Cases

| Case | Family | Mode | Overall | Correctness | Ownership | Observability | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| staging_invoke_auth_smoke | strict_ingredient | live | review_required | review_required | review_required | review_required | staging_auth_missing |

## Notes

### staging_invoke_auth_smoke

- Title: staging invoke auth smoke
- Family: strict_ingredient
- Overall: review_required
- URL: `http://127.0.0.1:50221/agent/shop/v1/invoke`
- Correctness notes: missing_staging_auth_profile:default
- Ownership notes: missing_staging_auth_profile:default
- Observability notes: missing_staging_auth_profile:default
- Manual review: {"expected_outcome":"Provide staging auth for profile \"default\" and rerun the live acceptance case.","notes":"Use STAGING_AUTH_TOKEN / STAGING_AGENT_API_KEY for the default profile, or STAGING_<PROFILE>_AUTH_TOKEN / STAGING_<PROFILE>_AGENT_API_KEY for named governance profiles."}

