# Per-User Identity Architecture for the Agent-Checkout Gateway — v2 (post Claude↔Codex review)

**Status:** design, reviewed adversarially by Codex (see `REVIEW_by_codex_of_IdentityArchitecture.md`).
v1's biggest errors are corrected here: the ChatGPT/Gemini transport was wrong, the rollout was fail-OPEN,
and the review surfaced **live vulnerabilities already present in `src/server.js`.** Not yet implemented.

---

## 0. ⚠️ LIVE vulnerabilities found during review (present in production TODAY, independent of the kernel)
These exist now and should be triaged regardless of the kernel project:

- **L1 — the gateway trusts a forgeable buyer identity.** `src/server.js:1566-1574` (`getInvokeScopedBuyerRef`)
  reads `buyer_ref` from `payload.payment/order/quote.buyer_ref` (model/caller-controlled) and
  `30845-30847` from an `X-Buyer-Ref` header, then forwards it upstream as `X-Buyer-Ref` (26449). A
  prompt-injected model or any caller can stamp a **victim's** `buyer_ref`. If upstream scopes ownership by
  it → **cross-user account access.** **Fix: delete every body/header `buyer_ref` source; the buyer is only
  ever a server-verified identity (below).**
- **L2 — money ops run with only the shared agent key.** The live `/agent/shop/v1/invoke` route
  (`requireExternalInvokeAuth` → `handleInvokeRequest`, ~45124) reaches the legacy direct-upstream branches
  for `preview_quote`/`create_order`/`submit_payment`/`request_after_sales` **with no verified `user_ref`.**
- **L3 — `get_order_status` leaks other users' fulfillment.** It's in the passthrough allowlist and the live
  branch only needs `payload.status.order_id`; any agent-key caller who guesses an order id can read another
  user's tracking/ETA. **Fix: require verified `user_ref` + ownership lookup.**
- **L4 — `X-Checkout-Token` bypass.** `src/server.js:26291` lets a non-empty checkout token authenticate the
  external invoke route with no `agent_id`, no user, no `user_ref`, then forwards upstream. **Fix: checkout
  tokens must not authenticate money/status ops; bind to verified `(user_ref, op, quote/order id, exp, aud)`
  or restrict to internal read-only.**
- **L5 — public agent-key fallback.** `NEXT_PUBLIC_AGENT_API_KEY` + introspection-unavailable fallback
  (~26075) means a client-exposed key can be the channel credential that unlocks L1/L4. **Fix: remove public
  env keys from server auth; no fallback for external money/status ops; explicit, audited break-glass only.**

## 1. Problem
The gateway authenticates the **platform** (`agent_id`, one key per ChatGPT/Gemini); millions of end-users
sit behind each. The kernel binds ownership to a per-buyer `user_ref`. There is **no verified per-user
identity** on the gateway today (introspection returns agent-level only), and what little identity exists
(L1) is forgeable.

## 2. Threat model
| # | Attack | Defense |
|---|---|---|
| T1 | Model/payload asserts identity (`buyer_ref`, `customer_email`) | `user_ref` ONLY from a server-verified credential; strip+reject all caller identity (closes L1) |
| T2 | `user_ref = agent_id` → all of a platform's users share one scope | `user_ref` is the verified per-user `sub`, never the platform key |
| T3 | Token for user A used on a request "for" user B | ownership bound to `sub`→`user_ref`; kernel `_requireOrder` blocks cross-`user_ref` |
| T4 | Token minted for another audience replayed at Pivota | verify `aud`/`azp`; `iss` allowlist; pinned JWKS |
| T5 | Token replay/leak | short lifetime + `iat`/`exp`; DPoP/mTLS for money ops; never log tokens |
| T6 | Platform (OAuth client) mints user-`sub` tokens without consent | AS controls (§5): auth-code+PKCE+consent only |
| T7 | Same user, wrong session/agent acts on an order | bind `acp_session_id`+`agent_id` on the order (§7) |

**Principle:** identity lives in a server-verified credential. The model's text is never identity.

## 3. Corrected transport topology (v1 was wrong)
Per Codex: neither platform hands Pivota's gateway a clean "agent key + user token" pair.
- **ChatGPT (Apps SDK / MCP):** ChatGPT is the OAuth **client**; it attaches the user's access token as
  `Authorization: Bearer <token>` to the **MCP server**. So the **MCP server is the OAuth resource server** —
  it verifies that token, derives `user_ref`, and is the identity edge.
- **Gemini:** function-calling means **the developer's app executes the call** — Google does **not** send
  Pivota a per-user token. (Vertex AI Extensions runtime-auth is the only managed variant, and it's
  deprecated 2026-05-26.) So **the Gemini host app/backend is the OAuth client** and the identity edge.

**Conclusion:** identity is verified at the **edge** (MCP server / host app), and conveyed to the gateway
over a **signed internal buyer-context assertion** — NOT a raw token and NOT a raw `user_ref` header.

```
End-user --OAuth consent--> [edge: MCP server / host app = OAuth resource server]
   edge verifies the platform's per-user token (sig/iss/aud/exp) -> claims {iss,sub} -> user_ref
   edge --> gateway:  SIGNED internal assertion { user_ref, acp_session_id, agent_id, aud=gateway, exp, iss=edge }
   gateway: verify the assertion's signature + aud + exp  -> trust user_ref ; REJECT any raw buyer_ref
   gateway -> kernel mount: ctx = { user_ref, acp_session_id }
```

## 4. Gateway identity contract (the hard rules)
- Accept buyer identity **only** from a verified signed internal assertion (or, if an edge calls in-process,
  verified OAuth claims). **Reject/strip every other identity source** — `X-Buyer-Ref`, `payload.*.buyer_ref`,
  `customer_email` as identity (fixes L1). Port `attachUserRef`'s strip-and-reject to the gateway.
- `secureInvoke` accepting an already-derived `user_ref` is safe **only** from a verified server session —
  at the gateway, feed it **only** verified claims or the signed assertion, never a raw `user_ref` (Codex P1).
- **Money + status ops DENY** without a verified `user_ref`. No legacy fallback (fixes L2; see §8 rollout).

## 5. If Pivota is the OAuth AS (T6 controls) — else use a managed IdP (recommended)
If Pivota issues user tokens, the AS MUST: issue end-user `sub` tokens **only** via authorization-code +
PKCE + explicit user consent; **forbid** `client_credentials`, ROPC, and token-exchange from minting
end-user subjects; bind auth codes to exact `redirect_uri` + PKCE verifier + client instance; require
scopes; audit consent per `(client, sub)`; support Dynamic Client Registration only with vetting (no
open DCR/CIMD impersonation). Otherwise use Auth0/Cognito/Clerk and only validate.

## 6. Token / assertion validation (non-negotiable)
- Pin each `iss` to an **exact JWKS URL + allowed alg set**; **never** follow `jku`/`x5u`/header-controlled
  key material; reject `alg:none`/HS-RS confusion.
- Verify `iss` ∈ exact registry, `aud`/`azp` = Pivota, `exp`/`nbf`/`iat` + max-lifetime, required `scope`.
- The **internal edge→gateway assertion**: signed (edge key), short-lived, `aud=gateway`, carries
  `user_ref`+`acp_session_id`+`agent_id`+provenance. Consider **DPoP or mTLS** for money ops (anti-replay).
- `user_ref = usr_<sha256(iss|sub)>` (`deriveUserRef`) is correct **only after** the above succeeds.

## 7. Kernel changes (close T3-residual / T7)
`createOrder` stores `user_ref` but not `acp_session_id`/`agent_id`; `_requireOrder` checks only `user_ref`
(`kernel.js:194`). **Persist `acp_session_id` + `agent_id` on the order and compare all three in
`_requireOrder`** so a reused token in the wrong session/agent can't act on an order. Bind confirmation/AP2
state to the same tuple.

## 8. Operation gating + rollout (DENY-by-default — fixes the v1 fail-open P0)
- Reads (`find_products`) → agent/channel auth only.
- `preview_quote`, `create_order`, `submit_payment`, after-sales, **and `get_order_status`** → require a
  verified `user_ref`.
- **Rollout is deny-by-default:** in production, money/status ops **require** verified identity. A platform
  not yet onboarded for user identity is **denied** those ops — it does **not** fall back to the legacy
  agent-key path. (v1 said "stay on legacy" — that preserved the exact collapse this design closes.)

## 9. Authorization ≠ identity (AP2) — needs a real verifier
The verified `user_ref` says *who*. It is **not** authorization to charge. `acpAp2.js` only maps statuses +
carries opaque state — it does **not** verify AP2 mandate signature/subject/amount/currency/order-id/nonce/
expiry. **Build an AP2 (or OAuth step-up) verifier that must pass before `mintConfirmation`**, and bind the
confirmation token to the verified mandate id + `(order_id, user_ref, amount, currency, acp_session_id)`.

## 10. user_ref ↔ account model
Maintain an **exact issuer registry** (canonical `iss` strings, pinned JWKS). Map verified `(iss, sub)` →
a **durable Pivota account id** when one human links across platforms (else issuer aliases / pairwise `sub`
fragment one human into many `user_ref`s). `deriveUserRef` is the namespacing primitive, not the account model.

## 11. Reuse vs net-new
- Reuse: `deriveUserRef`, `attachUserRef` (strip+reject), `secureInvoke`'s binding pattern, `acpAp2.js` state map.
- Net-new: the **gateway identity middleware** (verify signed assertion → `user_ref`, reject raw identity);
  the **edge token verifier** (per platform); the **AP2 mandate verifier**; the **issuer registry**; and (if
  Option A) the **OAuth AS**. Plus the kernel `_requireOrder` tuple change.

## 12. Open decisions (need product/platform input)
1. AS: managed IdP (recommended) vs Pivota-as-AS.
2. ChatGPT path: is it via your MCP server (then that's the identity edge) or direct GPT Actions?
3. Gemini path: who hosts the integration (that host is the OAuth client / edge)?
4. Edge→gateway assertion format + signing key management (JWT + JWKS, mTLS, or DPoP).
5. Durable account-id mapping for cross-platform identity.

## 13. Security checklist
- [ ] No money/status op runs without a server-verified `user_ref` (deny-by-default; L2/L4/L5 closed).
- [ ] Zero identity from payload/headers (`buyer_ref`/`X-Buyer-Ref` deleted — L1).
- [ ] `get_order_status` ownership-gated (L3).
- [ ] JWKS pinned per issuer; no `jku`/`x5u`/`alg:none`; `aud`/`azp`/`exp`/`iat`/`scope` verified.
- [ ] AS cannot mint user-`sub` tokens without auth-code+PKCE+consent (T6).
- [ ] Edge→gateway assertion is signed, short-lived, `aud`-bound; replay-resistant for money ops.
- [ ] Kernel binds `(user_ref, acp_session_id, agent_id)` on orders (T7).
- [ ] Confirmation minting requires a verified AP2/step-up authorization, bound to the charge tuple.
- [ ] Tokens/assertions never logged (extend `redact.js`).
```
