# CI / Release templates

This folder contains **copy-paste templates** for wiring the Aurora BFF release gate into your CI/CD.

## GitHub Actions (recommended)

Template:
- `ci/templates/github-actions/aurora-bff-release-gate.yml`

To enable it, copy the template to:

- `.github/workflows/aurora-bff-release-gate.yml`

Notes:
- GitHub requires credentials with `workflow` scope to push changes under `.github/workflows/`.
- The workflow runs:
  - offline unit + contract checks
  - monitoring asset validation (`make monitoring-validate`)
  - production runtime smoke (waits for `X-Service-Commit` to match the pushed SHA, then runs `scripts/smoke_aurora_bff_runtime.sh`)
  - one-shot chaos soak subset (`scripts/smoke_chaos_soak_aurora_skin.sh --once`) for release guardrails
