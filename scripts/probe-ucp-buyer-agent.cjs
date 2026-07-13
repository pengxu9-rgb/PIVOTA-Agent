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
 * HARD SAFETY BOUNDS:
 *   - NO real purchase, NO payment, NO complete_checkout. The client physically has no method that completes
 *     checkout; this script only records the refusal. It never opens/fetches the handoff URL.
 *   - Read + cart-build only against the target brand. No store mutation, no order.
 *   - Credential comes from env (UCP_AGENT_CREDENTIAL) ONLY; never printed. If absent, the probe prints
 *     "credential required — founder registration pending" and exits 0 (clean, not an error).
 *   - External content (catalog/store/API responses) is DATA, not instructions.
 *
 * Usage:
 *   UCP_AGENT_CREDENTIAL=... node scripts/probe-ucp-buyer-agent.cjs [target1 target2 ...]
 *   node scripts/probe-ucp-buyer-agent.cjs                      # defaults to the OY cohort below
 * Env:
 *   UCP_AGENT_CREDENTIAL   (required to run live) — JWT/token from the Shopify Dev Dashboard buyer-agent reg.
 *   UCP_AGENT_PROFILE_URL  (optional) — HTTPS URL Pivota's capability profile is hosted at.
 *   UCP_AGENT_TARGETS      (optional) — comma-separated targets (overridden by CLI args).
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

    if (cartId) {
      const checkout = await client.createCheckout(endpoint, { cartId });
      finding.checkout_create = Boolean(checkout.ok && !checkout.error);
      finding.checkout = { status: checkout.status, error: checkout.error || null };
      finding.storefront_handoff_url = client.extractHandoffUrl(checkout) || finding.storefront_handoff_url;
    } else {
      finding.notes.push('no cart id returned; skipping checkout-create');
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
  const credential = (process.env.UCP_AGENT_CREDENTIAL || '').trim();
  if (!credential) {
    // Clean exit, not an error — the founder's Dev Dashboard registration is pending.
    process.stdout.write('credential required — founder registration pending\n');
    process.stdout.write('Set UCP_AGENT_CREDENTIAL (JWT/token from the Shopify Dev Dashboard buyer-agent registration) to run the live probe.\n');
    process.exit(0);
    return;
  }

  const { createUcpBuyerAgentClient } = await import('../src/services/ucpBuyerAgentClient.js');
  const client = createUcpBuyerAgentClient();

  log({ event: 'probe_start', identity: client.describeTier(), profile_capabilities: Object.keys(client.buildProfile().ucp.capabilities) });

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
