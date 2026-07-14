#!/usr/bin/env node
'use strict';

/*
 * scripts/probe-ucp-token-tier.cjs — H3 token-tier auth verification harness (NOT CI) for
 * docs/ucp_shopify_lane_hardening_2026-07-13.md.
 *
 * Confirms the client-credentials -> JWT exchange (+ cached refresh) works and that the buyer-agent client
 * operates at TOKEN tier (Bearer auth) end-to-end. Reads the founder's real creds from env
 * (UCP_AGENT_CLIENT_ID / UCP_AGENT_CLIENT_SECRET). If those are ABSENT it prints "token creds not set" and
 * exits 0 (clean) — so it is safe to run unconfigured.
 *
 * HARD SAFETY BOUNDS (unchanged): this verifies AUTH ONLY. It NEVER calls complete_checkout, NEVER submits
 * payment, NEVER completes an order, and NEVER opens a handoff URL. The client_secret and the minted JWT are
 * NEVER printed — only booleans (token_present, minted_via_exchange, has_client_credentials) and the tier. A
 * belt-and-braces scrub redacts the secret/id from every line before it is written.
 *
 * Usage:
 *   UCP_AGENT_CLIENT_ID=... UCP_AGENT_CLIENT_SECRET=... node scripts/probe-ucp-token-tier.cjs
 * Optional (prove end-to-end Bearer against a live merchant endpoint via a READ-ONLY tools/list):
 *   UCP_PROBE_MCP_ENDPOINT=https://<brand>/api/ucp/mcp node scripts/probe-ucp-token-tier.cjs
 */

const { createUcpBuyerAgentClient } = require('../src/services/ucpBuyerAgentClient');

const CLIENT_ID = String(process.env.UCP_AGENT_CLIENT_ID || '').trim();
const CLIENT_SECRET = String(process.env.UCP_AGENT_CLIENT_SECRET || '').trim();
const STATIC_CREDENTIAL = String(process.env.UCP_AGENT_CREDENTIAL || '').trim();
const MCP_ENDPOINT = String(process.env.UCP_PROBE_MCP_ENDPOINT || '').trim();

// Redact any credential material that might otherwise appear in a serialized value (defense in depth — the
// client already returns booleans only). Never let the secret/id/token reach stdout.
function scrub(text) {
  let s = String(text == null ? '' : text);
  for (const secret of [CLIENT_SECRET, CLIENT_ID, STATIC_CREDENTIAL]) {
    if (secret && secret.length >= 4) s = s.split(secret).join('«REDACTED»');
  }
  return s;
}

function log(obj) {
  process.stdout.write(`${scrub(JSON.stringify(obj))}\n`);
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    // Clean no-op when unconfigured (also true when only a static UCP_AGENT_CREDENTIAL is set — that is a
    // different, pre-existing path this harness does not need to exercise).
    process.stdout.write('token creds not set\n');
    process.exit(0);
    return;
  }

  const client = createUcpBuyerAgentClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    // A static credential (if also set) would win and short-circuit the exchange; this harness exercises the
    // client-credentials exchange specifically, so we do NOT pass options.credential here.
  });

  const desc = client.describeTier();
  log({
    event: 'token_tier_probe_start',
    tier: desc.tier,
    has_client_credentials: desc.has_client_credentials,
    has_token_tier_credential: desc.has_token_tier_credential,
    token_endpoint: desc.token_endpoint,
    completes_checkout: desc.completes_checkout, // MUST be false.
    note: 'auth verification only; NEVER completes checkout / submits payment / opens a URL.',
  });

  // 1) First exchange — mints a JWT via client_credentials and confirms TOKEN-tier operation.
  const first = await client.verifyTokenTier();
  log({
    event: 'token_exchange_verify',
    ok: first.ok,
    tier: first.tier,
    token_present: first.token_present, // boolean — the JWT value is NEVER shown.
    minted_via_exchange: first.minted_via_exchange,
    error: first.error ? scrub(first.error) : undefined,
  });

  // 2) Second call — proves the minted JWT is CACHED/refreshed transparently (no throw, still TOKEN tier).
  const second = await client.verifyTokenTier();
  log({ event: 'token_cache_reuse', ok: second.ok, token_present: second.token_present });

  // 3) HARD BOUND assertion: completion stays hard-refused regardless of tier.
  const refusal = client.refuseCompleteCheckout();
  log({ event: 'complete_checkout_guard', refused: refusal.refused === true, reason: refusal.reason });

  // 4) OPTIONAL end-to-end Bearer proof: a READ-ONLY tools/list against a live merchant endpoint. Never a
  //    state-changing call. Skipped unless UCP_PROBE_MCP_ENDPOINT is set.
  if (MCP_ENDPOINT) {
    try {
      const listed = await client.listTools(MCP_ENDPOINT);
      log({
        event: 'token_tier_tools_list',
        ok: Boolean(listed && listed.ok),
        status: listed && listed.status,
        tier: listed && listed.tier,
        tool_count: listed && listed.response && listed.response.result && Array.isArray(listed.response.result.tools)
          ? listed.response.result.tools.length
          : null,
        error_code: listed && listed.error && listed.error.code,
      });
    } catch (err) {
      log({ event: 'token_tier_tools_list_error', message: scrub(err && err.message ? err.message : String(err)) });
    }
  }

  const ok = first.ok && first.tier === 'token' && refusal.refused === true;
  log({ event: 'token_tier_probe_result', ok, tier: first.tier });
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${scrub(`token-tier probe failed: ${err && err.message ? err.message : String(err)}`)}\n`);
  process.exit(1);
});
