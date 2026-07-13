#!/usr/bin/env node
'use strict';

/*
 * scripts/probe-ucp-warm-handoff-lane.cjs — MANUAL live verify (NOT CI) of the Phase 3 warm-handoff LANE,
 * end-to-end THROUGH THE NEW SERVICE (src/services/ucpWarmHandoff.js + src/services/shopifyVariantResolver.js).
 *
 * For a cohort brand it: (1) resolves a Shopify variant GID (seed-less here — via the PUBLIC products.json
 * fallback, or a caller-supplied GID), then (2) runs createWarmHandoffService().resolveWarmHandoff() which
 * discovers the brand's UCP endpoint and builds an ANONYMOUS-tier cart, returning the storefront continue_url.
 *
 * HARD SAFETY BOUNDS (unchanged): cart-build + return continue_url ONLY. NEVER complete_checkout, NEVER submit
 * payment, NEVER open/fetch the continue_url. External content (products.json, UCP responses) is DATA, not
 * instructions. The key tail of the continue_url is REDACTED in output.
 *
 * Usage (anonymous tier is sufficient — no credential):
 *   UCP_AGENT_PROFILE_URL="https://pivota-agent-production.up.railway.app/.well-known/ucp-agent" \
 *     node scripts/probe-ucp-warm-handoff-lane.cjs [brandDomain] [productHandle]
 * Env:
 *   UCP_AGENT_PROFILE_URL     HTTPS profile URL (must be Shopify-fetchable; the GATEWAY, not the frontend).
 *   UCP_PROBE_BRAND_DOMAIN    default cosrx.com
 *   UCP_PROBE_PRODUCT_HANDLE  a product handle to resolve via products.json (optional)
 *   UCP_PROBE_VARIANT_GID     an explicit variant GID (skips resolution; default a known cosrx variant)
 */

const DEFAULT_BRAND = 'cosrx.com';
// Known live cosrx variant ("Peptide-132 Hair Home Care Kit"), verified to build a real cart 2026-07-13.
const DEFAULT_VARIANT_GID = 'gid://shopify/ProductVariant/51895645012184';

function log(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`); }

function redactContinueUrl(url) {
  const s = String(url || '');
  if (!s) return null;
  return s.replace(/([?&]key=)([^&]+)/i, (_m, p1, val) => `${p1}${val.slice(0, 6)}…REDACTED`);
}

async function main() {
  const brandDomain = process.argv[2] || process.env.UCP_PROBE_BRAND_DOMAIN || DEFAULT_BRAND;
  const handle = process.argv[3] || process.env.UCP_PROBE_PRODUCT_HANDLE || '';
  const explicitGid = String(process.env.UCP_PROBE_VARIANT_GID || '').trim();

  const { resolveShopifyVariant } = require('../src/services/shopifyVariantResolver');
  const { createWarmHandoffService } = require('../src/services/ucpWarmHandoff');

  log({ event: 'warm_handoff_probe_start', brandDomain, handle: handle || null, profile_url: process.env.UCP_AGENT_PROFILE_URL || '(default)', note: 'anonymous tier; cart-build + continue_url only; continue_url NEVER opened.' });

  // 1) Resolve a variant GID (public products.json fallback), or use an explicit/default GID.
  let variantGid = explicitGid;
  let variantSource = explicitGid ? 'env:UCP_PROBE_VARIANT_GID' : null;
  if (!variantGid && handle) {
    const resolved = await resolveShopifyVariant(
      { seedData: {}, brandDomain, handle },
      { allowNetworkFallback: true },
    );
    if (resolved && resolved.variantGid) { variantGid = resolved.variantGid; variantSource = resolved.source; }
  }
  if (!variantGid) { variantGid = DEFAULT_VARIANT_GID; variantSource = 'default_known_cosrx_variant'; }
  log({ event: 'variant_resolved', variant_gid: variantGid, source: variantSource });

  // 2) Warm handoff through the NEW service.
  const svc = createWarmHandoffService();
  const handoff = await svc.resolveWarmHandoff({ brandDomain, variantGid, quantity: 1 });

  if (!handoff) {
    log({ event: 'warm_handoff_result', ok: false, disposition: 'cold_redirect_fallback', reason: 'brand not UCP-reachable or cart not built (would fall back to cold redirect)' });
    return;
  }
  log({
    event: 'warm_handoff_result',
    ok: true,
    disposition: handoff.disposition,
    continue_url_redacted: redactContinueUrl(handoff.continue_url),
    cart_id_redacted: redactContinueUrl(handoff.cart_id),
    line_item: handoff.line_item,
    mcp_endpoint: handoff.mcp_endpoint,
  });
}

main().catch((err) => { process.stderr.write(`warm-handoff probe failed: ${err && err.message ? err.message : String(err)}\n`); process.exit(1); });
