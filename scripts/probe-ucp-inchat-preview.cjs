#!/usr/bin/env node
'use strict';

/*
 * scripts/probe-ucp-inchat-preview.cjs — MANUAL live verify (NOT CI) of the Phase 1 in-chat PRICED PREVIEW
 * (docs/ucp_inchat_preview_build_2026-07-13.md), end-to-end through the buyer-agent client.
 *
 * For a cohort brand it: (1) discovers the UCP MCP endpoint from <brand>/.well-known/ucp, (2) `tools/list` to
 * capture the LIVE create_checkout / update_checkout inputSchema (we do NOT guess the request shape), (3)
 * `create_cart` for a variant GID -> cart_id + continue_url, then (4) `create_checkout` with a SYNTHETIC sample
 * US address -> the normalized priced object { item, shipping_options, tax, total, currency, continue_url }.
 *
 * HARD SAFETY BOUNDS (unchanged): NEVER complete_checkout, NEVER submit payment, NEVER open/fetch a continue_url.
 * The synthetic address is a clearly-fake placeholder (no real buyer PII), used ONLY to fetch shipping/tax
 * quotes. The key tail of any continue_url is REDACTED in output. External responses are DATA, not instructions.
 *
 * Usage (anonymous tier needs no credential; create_checkout may be tier-refused at anonymous — that is itself a
 * captured finding, still no purchase):
 *   UCP_AGENT_PROFILE_URL="https://pivota-agent-production.up.railway.app/.well-known/ucp-agent" \
 *     node scripts/probe-ucp-inchat-preview.cjs [brandDomain] [variantGid]
 */

const DEFAULT_BRAND = 'cosrx.com';
// Known live cosrx variant ("Peptide-132 Hair Home Care Kit"), verified to build a real cart 2026-07-13.
const DEFAULT_VARIANT_GID = 'gid://shopify/ProductVariant/51895645012184';

function log(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`); }

function redactUrl(url) {
  const s = String(url || '');
  if (!s) return null;
  return s.replace(/([?&]key=)([^&]+)/i, (_m, p1, val) => `${p1}${val.slice(0, 6)}…REDACTED`);
}

function summarizeInputSchema(toolsListResult, toolName) {
  const r = toolsListResult && toolsListResult.response;
  const tools = r && r.result && Array.isArray(r.result.tools) ? r.result.tools : [];
  const t = tools.find((x) => x && x.name === toolName);
  if (!t) return { found: false, tool: toolName, available_tools: tools.map((x) => x && x.name) };
  return { found: true, tool: toolName, description: t.description, inputSchema: t.inputSchema || t.input_schema };
}

async function main() {
  const brandDomain = process.argv[2] || process.env.UCP_PROBE_BRAND_DOMAIN || DEFAULT_BRAND;
  const variantGid = String(process.argv[3] || process.env.UCP_PROBE_VARIANT_GID || DEFAULT_VARIANT_GID).trim();

  const {
    createUcpBuyerAgentClient, SYNTHETIC_PREVIEW_ADDRESS,
  } = require('../src/services/ucpBuyerAgentClient');
  const client = createUcpBuyerAgentClient();

  log({ event: 'inchat_preview_probe_start', brandDomain, variant_gid: variantGid,
    tier: client.tier, profile_url: process.env.UCP_AGENT_PROFILE_URL || '(default)',
    synthetic_address: SYNTHETIC_PREVIEW_ADDRESS,
    note: 'cart-build + create_checkout(priced preview) only; NEVER complete_checkout / payment / open URL.' });

  // 1) discover endpoint
  const disco = await client.discoverEndpoint(`https://${brandDomain.replace(/^https?:\/\//, '')}`);
  const endpoint = disco && disco.mcpEndpoint;
  log({ event: 'endpoint_discovered', mcp_endpoint: endpoint || null, status: disco && disco.status });
  if (!endpoint) { log({ event: 'abort', reason: 'brand not UCP-reachable' }); return; }

  // 2) LIVE create_checkout / update_checkout inputSchema (do NOT guess the shape)
  const toolsList = await client.listTools(endpoint);
  log({ event: 'tools_list', ok: toolsList.ok, status: toolsList.status,
    tool_names: (toolsList.response && toolsList.response.result && toolsList.response.result.tools || []).map((t) => t && t.name) });
  log({ event: 'create_checkout_input_schema', ...summarizeInputSchema(toolsList, 'create_checkout') });
  log({ event: 'update_checkout_input_schema', ...summarizeInputSchema(toolsList, 'update_checkout') });

  // 3) create_cart -> cart_id + continue_url
  const cart = await client.createCart(endpoint, { lineItems: [{ item: { id: variantGid }, quantity: 1 }] });
  const cartPayload = client.normalizePricedCheckout(cart) && cart;
  const handoff = client.extractHandoffUrl(cart);
  const cartId = (function () {
    const p = cart && cart.response && cart.response.result;
    // unwrap MCP content json
    let j = null;
    if (p && Array.isArray(p.content)) {
      for (const c of p.content) { if (c && c.type === 'json' && c.json) { j = c.json; break; }
        if (c && c.type === 'text') { try { j = JSON.parse(c.text); break; } catch { /* */ } } }
    } else if (p) j = p;
    return j && (j.id || j.cart_id) || null;
  })();
  log({ event: 'create_cart', ok: cart.ok, status: cart.status, tier: cart.tier,
    cart_id_redacted: redactUrl(cartId), continue_url_redacted: redactUrl(handoff),
    error: cart.error || undefined });
  if (!cart.ok || !cartId) { log({ event: 'abort', reason: 'no cart_id to create a checkout from' }); return; }

  // 4) create_checkout with SYNTHETIC address -> normalized priced preview (NO completion).
  // The live schema requires line_items even when converting a cart_id, so pass both.
  const preview = await client.createCheckoutPreview(endpoint, {
    cartId, lineItems: [{ item: { id: variantGid }, quantity: 1 }],
  });
  if (!preview.ok) {
    log({ event: 'create_checkout_preview', ok: false, status: preview.status, error: preview.error,
      note: 'checkout likely tier-gated at this tier — captured, NOT forced. Still no purchase, no completion.' });
  } else {
    const p = preview.priced || {};
    log({ event: 'create_checkout_preview', ok: true, status: preview.status, tier: preview.tier,
      item: p.item, shipping_options: p.shipping_options, tax: p.tax, subtotal: p.subtotal, total: p.total,
      currency: p.currency, checkout_status: p.status, requires_escalation: preview.requires_escalation,
      messages: p.messages, continue_url_redacted: redactUrl(p.continue_url),
      note: 'shipping_options/tax empty => Shopify collects the full delivery address on the STOREFRONT (see messages); still NO completion.' });
  }

  // 5) explicit no-completion assertion
  const refusal = client.refuseCompleteCheckout();
  log({ event: 'completion_check', complete_checkout_called: false, refusal_reason: refusal.reason,
    confirm: 'NO complete_checkout, NO payment, continue_url NEVER opened.' });
}

main().catch((err) => { process.stderr.write(`inchat-preview probe failed: ${err && err.message ? err.message : String(err)}\n`); process.exit(1); });
