# CLAUDE.md

Repo-specific notes for Claude Code sessions in PIVOTA-Agent.

## A fresh worktree has no dependencies — run `npm ci` before any test

`git worktree add` does not bring `node_modules` across (it is gitignored), so a brand-new worktree
starts with **zero** dependencies installed. Suites that need real crypto, HTTP, or the safety kernel
fail on the first line that resolves a package:

```
Error: Cannot find module 'jose'
```

`jose` is an ordinary `dependencies` entry pinned in the lockfile, so this is a missing install, not a
broken test and not a CI-only requirement. Fix it in the worktree before running anything:

```bash
npm ci
```

Measured 2026-08-20 on `tests/agent_identity_issuer_registry.node.test.cjs`: **7 of 9 failing** in a
dependency-less worktree, **9 of 9 passing** in the same worktree once `node_modules` is present.

Note that these suites fail loudly rather than skipping when a dependency is absent — deliberately.
`loadJose` uses a hard `require.resolve`, because a security test that quietly skips itself when a
crypto library is missing is worse than one that fails.

### Do not call a failure "pre-existing" until you have checked `node_modules` exists

Re-running the same suite in a *second* dependency-less worktree reproduces the identical failures.
That looks like confirmation and is not — it is the same mistake twice. Verify the install before
attributing a failure to `main`, to the environment, or to someone else's change.
