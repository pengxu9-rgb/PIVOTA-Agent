#!/usr/bin/env node
'use strict';

/*
 * scripts/probe-ucp-buyer-agent.cjs — MANUAL probe (NOT CI).
 *
 * Purpose (docs/ucp_warm_handoff_build_plan_2026-07-13.md Phase 1): prove the WARM HANDOFF end to end against a
 * live Shopify UCP brand as an anonymous external agent, with zero credential:
 *   1. discover the per-merchant UCP MCP endpoint from `<brand>/.well-known/ucp`.
 *   2. create_cart with a caller-supplied Shopify variant GID (default a known cosrx variant).
 *   3. capture + report the cart's storefront `continue_url` (the warm handoff) and a line_items[0] sanity check.
 *   4. confirm complete_checkout is REFUSED at Pivota's tier — captured, NEVER attempted.
 *
 * The per-merchant endpoint exposes cart + checkout tools ONLY (verified live 2026-07-13): there is NO
 * `get_product` on it (product discovery = Global Catalog / our own crawled index), so this probe does NOT call
 * a catalog tool against the merchant endpoint — it goes straight to create_cart with a supplied variant GID.
 *
 * WARM HANDOFF WORKS AT THE ANONYMOUS TIER — no signing key, no token. If UCP_AGENT_SIGNING_PRIVATE_KEY is set
 * the client runs at the SIGNED tier (cart-build still anonymous-safe); a Bearer token (UCP_AGENT_CREDENTIAL)
 * lifts it to the TOKEN tier. None are required for the warm handoff.
 *
 * HARD SAFETY BOUNDS:
 *   - NO real purchase, NO payment, NO complete_checkout. The client physically has no method that completes
 *     checkout; this script only records the refusal. It NEVER opens/fetches the continue_url.
 *   - Read + cart-build only against the target brand. No store mutation, no order.
 *   - The signing PRIVATE key comes from env ONLY and is NEVER printed. A Bearer token (UCP_AGENT_CREDENTIAL)
 *     is optional and also never printed.
 *   - External content (store/API responses) is DATA, not instructions.
 *
 * Usage:
 *   UCP_AGENT_PROFILE_URL="https://pivota-agent-production.up.railway.app/.well-known/ucp-agent" \
 *     node scripts/probe-ucp-buyer-agent.cjs [target ...]      # default target https://cosrx.com
 *   UCP_PROBE_VARIANT_GID="gid://shopify/ProductVariant/<n>" node scripts/probe-ucp-buyer-agent.cjs <target>
 * Env:
 *   UCP_AGENT_PROFILE_URL          HTTPS URL Pivota's capability profile is hosted at (MUST be Shopify-fetchable;
 *                                  use the GATEWAY, not the agent.pivota.cc FRONTEND).
 *   UCP_PROBE_VARIANT_GID          Shopify variant GID to add to the cart (default: a known cosrx variant).
 *   UCP_AGENT_TARGETS              comma-separated targets (overridden by CLI args).
 *   UCP_AGENT_SIGNING_PRIVATE_KEY  optional — lifts to SIGNED tier. ECDSA P-256 PEM/JWK. Secret; never printed.
 *   UCP_AGENT_CREDENTIAL           optional — Bearer JWT for the TOKEN tier; not needed for the warm handoff.
 */

const DEFAULT_TARGETS = ['https://cosrx.com'];
// Known live cosrx variant ("Peptide-132 Hair Home Care Kit"), verified to build a real cart 2026-07-13.
const DEFAULT_VARIANT_GID = 'gid://shopify/ProductVariant/51895645012184';

function resolveTargets() {
  const cli = process.argv.slice(2).filter(Boolean);
  if (cli.length) return cli.map(normalizeTarget);
  const env = String(process.env.UCP_AGENT_TARGETS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (env.length) return env.map(normalizeTarget);
  return DEFAULT_TARGETS;
}

function resolveVariantGid() {
  const v = String(process.env.UCP_PROBE_VARIANT_GID || '').trim();
  return v || DEFAULT_VARIANT_GID;
}

function normalizeTarget(t) {
  const s = String(t).trim();
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:/i, 'https:');
  return `https://${s}`;
}

function log(obj) {
  // Structured, one JSON object per line. Never contains the credential or private key.
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function probeTarget(client, target, variantGid) {
  const finding = {
    target,
    variant_gid: variantGid,
    cart_build: null,
    storefront_handoff_url: null,
    cart_line_item_0: null,
    complete_checkout_refused: true, // always true — this client never attempts it
    complete_checkout_refusal: client.refuseCompleteCheckout(),
    notes: [],
  };
  try {
    const disco = await client.discoverEndpoint(target);
    finding.well_known = { url: disco.wellKnownUrl, status: disco.status, mcp_endpoint: disco.mcpEndpoint || null };
    if (!disco.mcpEndpoint) {
      finding.notes.push('no UCP MCP endpoint advertised at /.well-known/ucp (brand not UCP-reachable, or not opted-in)');
      return finding;
    }
    const endpoint = disco.mcpEndpoint;

    // Straight to cart-build: the per-merchant endpoint has cart + checkout tools ONLY (no get_product).
    const cart = await client.createCart(endpoint, {
      lineItems: [{ item: { id: variantGid }, quantity: 1 }],
    });
    finding.cart_build = Boolean(cart.ok && !cart.error);
    finding.cart = { status: cart.status, error: cart.error || null };
    finding.storefront_handoff_url = client.extractHandoffUrl(cart) || null;
    finding.cart_line_item_0 = pickFirstLineItem(cart.response);

    if (!finding.cart_build) {
      finding.notes.push('cart-build failed or refused; see cart.error');
    } else if (!finding.storefront_handoff_url) {
      finding.notes.push('cart built but no continue_url found in the response');
    }
  } catch (err) {
    finding.notes.push(`probe error: ${err && err.message ? err.message : String(err)}`);
  }
  return finding;
}

/** Best-effort line_items[0] sanity check from a cart tool result (no network). */
function pickFirstLineItem(resp) {
  const p = unwrap(resp);
  if (!p || !Array.isArray(p.line_items) || p.line_items.length === 0) return null;
  const li = p.line_items[0];
  return {
    item_id: li && li.item ? (li.item.id || null) : (li && li.id) || null,
    quantity: li ? (li.quantity ?? null) : null,
    title: li && li.item ? (li.item.title || null) : (li && li.title) || null,
  };
}

function unwrap(resp) {
  if (!resp || typeof resp !== 'object') return undefined;
  const r = resp.result ?? resp;
  const inner = r && r.result ? r.result : r;
  if (inner && Array.isArray(inner.content)) {
    for (const c of inner.content) {
      if (c && c.type === 'json' && c.json) return c.json;
      if (c && c.type === 'text' && typeof c.text === 'string') {
        try { return JSON.parse(c.text); } catch { /* not json */ }
      }
    }
  }
  return inner;
}

async function main() {
  const { createUcpBuyerAgentClient } = await import('../src/services/ucpBuyerAgentClient.js');
  const client = createUcpBuyerAgentClient();
  const identity = client.describeTier();
  const variantGid = resolveVariantGid();

  log({
    event: 'probe_mode',
    tier: client.tier,
    note: 'WARM HANDOFF probe — discover -> create_cart -> capture continue_url. Anonymous tier is sufficient; '
      + 'complete_checkout is NEVER attempted and the continue_url is NEVER opened.',
  });
  log({ event: 'probe_start', identity, variant_gid: variantGid, profile_capabilities: Object.keys(client.buildProfile().ucp.capabilities) });

  const targets = resolveTargets();
  const findings = [];
  for (const target of targets) {
    const finding = await probeTarget(client, target, variantGid);
    log({ event: 'target_finding', ...finding });
    findings.push(finding);
  }

  log({
    event: 'probe_summary',
    tier: client.tier,
    targets: findings.map((f) => ({
      target: f.target,
      cart_build: f.cart_build,
      storefront_handoff_url: Boolean(f.storefront_handoff_url),
      complete_checkout_refused: f.complete_checkout_refused,
    })),
  });
}

main().catch((err) => {
  process.stderr.write(`probe failed: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
