# Deploy runbook — ship the submit_payment direct-PSP fix to the gateway

Companion to `ISOLATED_PATCH_submit_payment_direct_psp.md` (the fix itself, validated e2e: Stripe + Adyen return the
merchant-PSP surface, B1 + B3 confirmed). This runbook gets it deployed **safely**. All steps are operator-run (deploy =
human, never an agent).

## ⚠️ The baseline problem (read first)
- The **deployed gateway is commit `d22fb2e251f8`**, reported by `https://pivota-agent-production.up.railway.app/version`.
- `d22fb2e` is **NOT in `origin/main`** (currently `45f95892`), not in any local clone, reflog, or branch here. It was a
  `railway up` from a **local working dir** (pushed or not) — so the running gateway is **not reproducible from git**.
- The local `~/dev/PIVOTA-Agent` tree is **122-files dirty** and HEAD `22481cf2` ≠ `origin/main` ≠ deployed `d22fb2e`.
- **DO NOT `railway up` from the current local tree** — it would ship 122 files of unrelated WIP and regress prod.

Because the running code isn't in git, you must first establish a **known, reproducible baseline** that matches what's
deployed (or consciously choose to move to `main`). Three paths below — pick A if you can, else B, else C.

---

## STEP 0 — recover/choose the baseline

### Path A (best): get `d22fb2e` from the machine that deployed it
On whatever machine ran the `railway up` that produced `d22fb2e` (check each candidate):
```bash
cd <that-machine>/PIVOTA-Agent
git cat-file -e d22fb2e251f8 && echo "FOUND here"      # the deploy machine will have it
git branch --contains d22fb2e251f8
# publish it so it's reproducible:
git push origin d22fb2e251f8:refs/heads/recover/deployed-gateway
```
Then on your work machine, in a FRESH clone:
```bash
cd /tmp && rm -rf pa-deploy && git clone https://github.com/pengxu9-rgb/PIVOTA-Agent.git pa-deploy && cd pa-deploy
git fetch origin recover/deployed-gateway
git checkout -b deploy/submit-payment-fix d22fb2e251f8
```
This gives an exact, clean copy of what's live → the safe baseline to patch.

### Path B: reconcile against `origin/main` (if `d22fb2e` is unrecoverable)
Only valid after you confirm the drift is acceptable. In a fresh clone:
```bash
cd /tmp && rm -rf pa-deploy && git clone https://github.com/pengxu9-rgb/PIVOTA-Agent.git pa-deploy && cd pa-deploy
# main is the stated deploy source; BUT it differs from what's live (d22fb2e). Before trusting it,
# diff main vs the running gateway behavior. At minimum confirm main still has the buggy v2 route
# (so the fix applies cleanly) and the rest of the money path you rely on:
grep -n "ROUTE_MAP" src/server.js | head; grep -n "submit_payment" src/server.js | head
git checkout -b deploy/submit-payment-fix origin/main
```
⚠️ Deploying `origin/main` also ships everything on `main` that `d22fb2e` lacked, and DROPS anything `d22fb2e` had
that `main` lacks (the dangerous direction — that's the unpushed local-deploy drift). Do NOT take Path B blind; only if
you've confirmed `main` is the intended, complete source.

### Path C (last resort): extract the running source from the Railway container
If neither the deploy machine nor main is trustworthy, pull the actual files off the running service to reconstruct a
baseline, then commit them to `recover/deployed-gateway`. (Heavier; do only if A and B both fail — ask Claude to help
script the extraction + a diff against main so the drift is visible before committing.)

---

## STEP 1 — apply the isolated patch
In the `deploy/submit-payment-fix` branch (from Step 0), apply the four `src/server.js` edits + the three test edits from
`ISOLATED_PATCH_submit_payment_direct_psp.md` (§1–§5). Then:
```bash
node --check src/server.js
git add src/server.js tests/integration/submit_payment_contract.test.js \
        tests/integration/checkout_rollout_canary.test.js tests/integration/checkout_timing_headers.test.js
git commit -m "fix(gateway): route agent submit_payment to direct merchant-PSP surface (was pivota_hosted_checkout 502)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## STEP 2 — test the patched baseline (must be green before deploy)
```bash
npm ci   # clean install matching package-lock
npx jest --watchman=false --runInBand \
  tests/integration/submit_payment_contract.test.js \
  tests/integration/checkout_rollout_canary.test.js \
  tests/integration/checkout_timing_headers.test.js
# Expect green (Codex's run on the validated tree: submit_payment_contract + rollout_canary = 2 suites/15 tests).
```
Optional pre-deploy e2e (same as the validated Option-A run), from this clean branch:
```bash
railway run -s PIVOTA-Agent -e production -- env PORT=8787 node src/server.js   # local patched gateway, prod env
# (with backend ALLOW_TEST_PSP_PROBE=1 scoped to merch_efbc46b4619cfbdf, then probe localhost:8787, then flag off)
```

## STEP 3 — deploy deliberately (human)
```bash
cd /tmp/pa-deploy            # the clean branch, tests green
railway link -p 885d576d-ad16-493d-90d2-8cbdbe0aedee -e production -s PIVOTA-Agent
railway status               # MUST show: Pivota Agent / production / PIVOTA-Agent
railway up -s PIVOTA-Agent -e production --detach
```
> If the gateway is supposed to deploy from `main`: first get this branch ONTO main cleanly
> (`git push origin deploy/submit-payment-fix:main` after review/PR), then `railway up` from a checkout of main —
> so git and the deployed artifact finally agree (fixing the root drift that caused this whole baseline mess).

## STEP 4 — verify the deploy
```bash
curl -s https://pivota-agent-production.up.railway.app/version    # note the new commit
curl -s -o /dev/null -w '%{http_code}\n' https://pivota-agent-production.up.railway.app/health   # 200
```
If `/health` ≠ 200 or it crashes: **rollback immediately** in the Railway dashboard → Pivota Agent → PIVOTA-Agent →
Deployments → redeploy the previous good deployment (`f72c8fcc-9e52-4fc5-ba66-b5ab4e6bd4c6` = `d22fb2e`).
(CLI `railway redeploy` only re-runs the latest; dashboard rollback re-promotes a specific prior deployment.)

## STEP 5 — confirm B4 (the last open verification) against the deployed fix
1. Operator: set backend `ALLOW_TEST_PSP_PROBE=1` + `TEST_PSP_PROBE_MERCHANTS=merch_efbc46b4619cfbdf` on Pivota-Infra/prod/web; wait for restart.
2. Probe the DEPLOYED gateway: `PROBE_BASE=https://pivota-agent-production.up.railway.app PROBE_PSP=stripe PROBE_ALLOW_TEST_PSP=1 PROBE_ALLOW_CHARGE=1 PROBE_CHARGE_CONFIRM=yes node scripts/probe_wire_format.mjs --create-order --charge`
3. Complete the returned PI with Stripe test card `4242 4242 4242 4242` → `payment_intent.succeeded` → order flips to `paid`.
   - Pre-req for first-try finalize: backend must set Stripe `metadata.order_id` = KERNEL order id (and PaymentIntent id = submit `payment_id`); Adyen `merchantReference` = kernel order id, `pspReference` = `payment_id`.
4. Operator: set `ALLOW_TEST_PSP_PROBE=0` again.

## Standing items (do regardless)
- Rotate the committed `ak_live_886c3cca…` key (PAYMENT_TESTING_COORDINATION.md, FINAL_PROJECT_DELIVERY.md, test-pivota-api.sh) + scrub git history.
- Rotate the `PROBE_KEY ak_live_73dee…` (pasted in chat this session).
- Validate the Adyen surface normalization + Adyen HMAC against a real Adyen test notification before relying on Adyen go-live.
- Fix the root cause of all this pain: make the gateway deploy from a clean, pushed `main` (never `railway up` from a local/dirty tree again).
