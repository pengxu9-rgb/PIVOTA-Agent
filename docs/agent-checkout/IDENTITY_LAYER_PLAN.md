# Identity Layer — implementation plan (decisions locked 2026-06-02)

Builds on `IDENTITY_ARCHITECTURE.md` (v2, Codex-reviewed). Turns the decisions into a concrete, owned plan.

## Decisions locked
- **IdP: managed** (Auth0 / Cognito / Clerk) — Pivota **validates** JWTs, does **not** run an OAuth AS.
- **Backend trust: unknown → assume the worst** — the gateway forwards **only a verified `user_ref`**, never
  a raw `X-Buyer-Ref` (so it's safe even if the backend trusts that header).
- **ChatGPT/Gemini edge: not built yet → design topology-independent** — the gateway validates the per-user
  JWT itself. If an MCP edge is added later, it validates + re-signs an internal assertion using the *same*
  verifier; the gateway accepts either, so we don't block on the unbuilt edge.

## The concrete model
```
end-user --login at the managed IdP--> per-user JWT { iss, sub, aud=pivota, exp }
   JWT arrives on each invoke (e.g. X-Agent-User-JWT header)
   gateway verifier: jose + PINNED JWKS per iss; check alg-allowlist (no jku/x5u/none), iss∈registry,
                     aud==pivota, exp/nbf/iat, scope  ->  user_ref = usr_<sha256(iss|sub)>  (deriveUserRef)
   gateway: req.buyer = { user_ref, claims };  DELETE raw X-Buyer-Ref;  forward ONLY user_ref upstream
   money/status ops DENY without req.buyer (deny-by-default)
   kernel ctx = { user_ref, acp_session_id }
```

## Prerequisites — YOURS (the integration can't run without these)
1. **Pick the managed IdP** (Auth0/Cognito/Clerk/…).
2. **Configure the ChatGPT & Gemini integrations** to authenticate the *end-user* against that IdP and
   send the per-user JWT on each invoke (and decide the carrier header — likely `X-Agent-User-JWT`).
3. **Give me:** the issuer(s) `iss`, the JWKS URL(s), and the expected `aud`.
4. **Confirm** what the backend does with `X-Buyer-Ref` vs `X-Agent-User-JWT` (or we keep the worst-case
   assumption and forward only the verified `user_ref`).

## Build steps — MINE (each Codex-reviewed; security-critical)
- **(a) Add `jose`** (vetted JWT/JWKS lib — no hand-rolled crypto).
- **(b) Per-user JWT verifier** (`safety-kernel/src/identity/userTokenVerifier.js`, IdP-agnostic, config =
  `[{ iss, jwksUri, aud, algs }]`): verify → `{ user_ref, claims }` or throw. Security controls from the
  review (pinned JWKS, alg allowlist, no `jku`/`x5u`/`alg:none`, `aud`/`exp`/`iat`/max-lifetime). **Unit-
  testable in isolation** with a self-generated test keypair + signed test tokens — **no real IdP needed to
  build/test this.**
- **(c) Gateway middleware** (`requirePerUserIdentity`): run after the agent-key auth; verify the JWT →
  `req.buyer`; **strip raw `X-Buyer-Ref`/payload identity**; **deny** money/status ops without `req.buyer`;
  forward only the verified `user_ref`. Closes L1 (header residual), L2, and L3 (`get_order_status` gating).
- **(d) Kernel binding:** persist + compare `(user_ref, acp_session_id, agent_id)` in `_requireOrder` (T7).
- **(e) Restrict `X-Checkout-Token` (L4)** + **remove public agent-key fallback (L5)**.
- **(f) Wire-in (#1):** the kernel mount's `ctx.user_ref` comes from `req.buyer` — now safe.

## What I can build RIGHT NOW vs what waits
- **Now, no prerequisites:** step (b) the verifier core — IdP-agnostic, tested in isolation. It's the
  foundation every path needs. (Adds the `jose` dependency.)
- **Waits on prerequisites 1–3:** wiring it live (the verifier needs the real `iss`/JWKS/`aud`, and the
  platforms must actually send the token).
- **Independent, can do anytime:** (d) the kernel session-binding, (e) L4/L5 hardening.

## Sequencing recommendation
1. I build (b) the verifier core + tests now (Codex-reviewed) — concrete foundation.
2. You do prerequisites 1–3 (pick IdP + configure platforms) in parallel.
3. I wire (c) the gateway middleware + (f) the wire-in once 1–3 land.
4. (d)/(e) hardening alongside.
