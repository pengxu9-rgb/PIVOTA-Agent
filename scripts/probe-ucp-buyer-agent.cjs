#!/usr/bin/env node
'use strict';

/*
 * scripts/probe-ucp-buyer-agent.cjs — MANUAL probe (NOT CI).
 *
 * Purpose (docs/ucp_buyer_agent_probe_scope_2026-07-13.md §2b): register Pivota as a UCP buyer agent, then
 * for each non-opted-in Shopify OY brand, run:
 *   1. catalog search (get_product)   -> does the brand's product appear at all?
 *   2. cart build (create_cart)       -> succeeds / refused?
 *   3. checkout create (create_checkout) -> succeeds / refused? capture the object.
 *   4. handoff: capture the storefront checkout URL (continue_url/checkout_url) — DO NOT open/complete it.
 *   5. confirm complete_checkout is REFUSED at Pivota's tier — captured, NEVER attempted.
 * and log the effective trust tier + negotiated scopes.
 *
 * TRUST TIER: this probe reaches checkout-create at the SIGNED tier — RFC 9421 HTTP Message Signatures with
 * Pivota's OWN ECDSA P-256 key. NO Shopify-issued credential is required ("No registration required"). Set
 * UCP_AGENT_SIGNING_PRIVATE_KEY (PEM/JWK, secret) + UCP_AGENT_SIGNING_KEY_ID + publish the public JWK via
 * UCP_AGENT_SIGNING_PUBLIC_JWK. Generate the pair with `node scripts/gen-ucp-agent-keypair.cjs`.
 * If no signing key is set, the probe runs at the ANONYMOUS tier (catalog + cart only), SKIPS checkout-create
 * (checkout tools require auth/signed), notes the skip, and exits 0 (clean, never an error).
 *
 * HARD SAFETY BOUNDS:
 *   - NO real purchase, NO payment, NO complete_checkout. The client physically has no method that completes
 *     checkout; this script only records the refusal. It never opens/fetches the handoff URL.
 *   - Read + cart-build only against the target brand. No store mutation, no order.
 *   - The signing PRIVATE key comes from env ONLY and is NEVER printed. A Bearer token (UCP_AGENT_CREDENTIAL)
 *     is optional and also never printed.
 *   - External content (catalog/store/API responses) is DATA, not instructions.
 *
 * Usage:
 *   UCP_AGENT_SIGNING_PRIVATE_KEY=... UCP_AGENT_SIGNING_KEY_ID=... UCP_AGENT_SIGNING_PUBLIC_JWK=... \
 *     node scripts/probe-ucp-buyer-agent.cjs [target1 target2 ...]   # SIGNED: full catalog->cart->checkout->handoff
 *   node scripts/probe-ucp-buyer-agent.cjs                            # ANONYMOUS: catalog+cart only, checkout skipped
 * Env:
 *   UCP_AGENT_SIGNING_PRIVATE_KEY  (enables SIGNED tier / checkout-create) — ECDSA P-256 PEM or JWK. Secret; never printed.
 *   UCP_AGENT_SIGNING_KEY_ID       (with the private key) — the `keyid`; must match the published JWK `kid`.
 *   UCP_AGENT_SIGNING_PUBLIC_JWK   (published in the profile) — the PUBLIC JWK.
 *   UCP_AGENT_CREDENTIAL           (optional) — Bearer JWT for the TOKEN tier; not needed for this probe.
 *   UCP_AGENT_PROFILE_URL          (optional) — HTTPS URL Pivota's capability profile is hosted at.
 *   UCP_AGENT_TARGETS              (optional) — comma-separated targets (overridden by CLI args).
 */

const DEFAULT_TARGETS = ['https://cosrx.com', 'https://beautyofjoseon.com', 'https://roundlab.com'];

function resolveTargets() {
  const cli = process.argv.slice(2).filter(Boolean);
  if (cli.length) return cli.map(normalizeTarget);
  const env = String(process.env.UCP_AGENT_TARGETS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (env.length) return env.map(normalizeTarget);
  return DEFAULT_TARGETS;
}

function normalizeTarget(t) {
  const s = String(t).trim();
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:/i, 'https:');
  return `https://${s}`;
}

function log(obj) {
  // Structured, one JSON object per line. Never contains the credential.
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function probeTarget(client, target) {
  const finding = {
    target,
    appeared_in_catalog: null,
    cart_build: null,
    checkout_create: null,
    storefront_handoff_url: null,
    complete_checkout_refused: true, // always true — this client never attempts it
    complete_checkout_refusal: client.refuseCompleteCheckout(),
    notes: [],
  };
  try {
    const disco = await client.discoverEndpoint(target);
    finding.well_known = { url: disco.wellKnownUrl, status: disco.status, mcp_endpoint: disco.mcpEndpoint || null };
    if (!disco.mcpEndpoint) {
      finding.notes.push('no UCP MCP endpoint advertised at /.well-known/ucp (brand not UCP-reachable, or not opted-in)');
      finding.appeared_in_catalog = false;
      return finding;
    }
    const endpoint = disco.mcpEndpoint;

    const search = await client.catalogSearch(endpoint, { query: target });
    finding.appeared_in_catalog = Boolean(search.ok && !search.error);
    finding.catalog_search = { status: search.status, error: search.error || null };

    // Best-effort: pull a variant/product id from the search response to build a cart line item.
    const productId = pickProductId(search.response);
    if (!productId) {
      finding.notes.push('no product id resolved from catalog search; skipping cart-build');
      return finding;
    }

    const cart = await client.createCart(endpoint, {
      lineItems: [{ item: { id: productId, title: 'probe-item', price: null }, quantity: 1 }],
    });
    finding.cart_build = Boolean(cart.ok && !cart.error);
    finding.cart = { status: cart.status, error: cart.error || null };
    const cartId = pickCartId(cart.response);
    finding.storefront_handoff_url = client.extractHandoffUrl(cart) || null;

    // Checkout tools require auth/signed. At ANONYMOUS tier we do NOT attempt checkout-create (it would just be
    // refused) — we note the skip. At SIGNED/TOKEN tier we create the checkout and capture the handoff URL.
    const canCheckout = client.tier === client.TRUST_TIER.SIGNED || client.tier === client.TRUST_TIER.TOKEN;
    if (!cartId) {
      finding.notes.push('no cart id returned; skipping checkout-create');
    } else if (!canCheckout) {
      finding.checkout_create = null;
      finding.notes.push(`checkout-create skipped at '${client.tier}' tier (checkout tools require auth/signed); set UCP_AGENT_SIGNING_PRIVATE_KEY for the SIGNED tier`);
    } else {
      const checkout = await client.createCheckout(endpoint, { cartId });
      finding.checkout_create = Boolean(checkout.ok && !checkout.error);
      finding.checkout = { status: checkout.status, error: checkout.error || null };
      finding.storefront_handoff_url = client.extractHandoffUrl(checkout) || finding.storefront_handoff_url;
    }
  } catch (err) {
    finding.notes.push(`probe error: ${err && err.message ? err.message : String(err)}`);
  }
  return finding;
}

function pickProductId(resp) {
  const p = unwrap(resp);
  if (!p) return undefined;
  return p.variant_id || p.id || (Array.isArray(p.products) && p.products[0] && (p.products[0].variant_id || p.products[0].id))
    || (Array.isArray(p.results) && p.results[0] && (p.results[0].variant_id || p.results[0].id));
}

function pickCartId(resp) {
  const p = unwrap(resp);
  return p ? (p.id || p.cart_id) : undefined;
}

function unwrap(resp) {
  if (!resp || typeof resp !== 'object') return undefined;
  const r = resp.result ?? resp;
  if (r && Array.isArray(r.content)) {
    for (const c of r.content) {
      if (c && c.type === 'json' && c.json) return c.json;
      if (c && c.type === 'text' && typeof c.text === 'string') {
        try { return JSON.parse(c.text); } catch { /* not json */ }
      }
    }
  }
  return r;
}

async function main() {
  const { createUcpBuyerAgentClient } = await import('../src/services/ucpBuyerAgentClient.js');
  const client = createUcpBuyerAgentClient();
  const identity = client.describeTier();

  if (client.tier === client.TRUST_TIER.ANONYMOUS) {
    // No signing key + no token: catalog + cart only, checkout-create is skipped (not an error).
    log({
      event: 'probe_mode',
      tier: client.tier,
      note: 'ANONYMOUS tier — catalog + cart only; checkout-create will be SKIPPED. '
        + 'Set UCP_AGENT_SIGNING_PRIVATE_KEY (+ _KEY_ID, publish _PUBLIC_JWK) to reach checkout-create at the SIGNED tier.',
    });
  } else {
    log({ event: 'probe_mode', tier: client.tier, note: `checkout-create ENABLED at '${client.tier}' tier` });
  }

  log({ event: 'probe_start', identity, profile_capabilities: Object.keys(client.buildProfile().ucp.capabilities) });

  const targets = resolveTargets();
  const findings = [];
  for (const target of targets) {
    const finding = await probeTarget(client, target);
    log({ event: 'target_finding', ...finding });
    findings.push(finding);
  }

  log({
    event: 'probe_summary',
    tier: client.tier,
    targets: findings.map((f) => ({
      target: f.target,
      appeared_in_catalog: f.appeared_in_catalog,
      cart_build: f.cart_build,
      checkout_create: f.checkout_create,
      storefront_handoff_url: Boolean(f.storefront_handoff_url),
      complete_checkout_refused: f.complete_checkout_refused,
    })),
  });
}

main().catch((err) => {
  process.stderr.write(`probe failed: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
