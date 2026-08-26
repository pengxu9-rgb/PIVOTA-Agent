'use strict';

/*
 * Store Audit UCP probe.
 *
 * A crawl-job primitive, not an interactive warm-handoff path. It is intended
 * to run only from the dedicated crawl subnet/NAT after its deployment gates
 * have passed. The probe is anonymous by construction and never calls
 * complete_checkout, submits payment, opens a handoff URL, or drives a
 * browser. It returns redacted, durable-evidence-shaped facts for the backend
 * to persist in execution_routes / evidence_items.
 */

const {
  createUcpBuyerAgentClient,
  FAILURE_REASON,
} = require('./ucpBuyerAgentClient');
const { normalizeBrandOrigin } = require('./ucpWarmHandoff');

const VERIFIER_ID = 'ucp_probe';
const EVIDENCE_LEVEL_DETECTED = 'detected';
const EVIDENCE_LEVEL_TESTED = 'tested';

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function toolNames(listResult) {
  const tools = listResult
    && listResult.response
    && listResult.response.result
    && Array.isArray(listResult.response.result.tools)
    ? listResult.response.result.tools
    : [];
  return [...new Set(tools.map((tool) => firstString(tool && tool.name)).filter(Boolean))].sort();
}

function statusForUpstream(result) {
  const status = Number(result && result.status);
  // `blocked` is the existing verifier meaning: upstream unavailable and no
  // retry on this run. WAF/rate-limit responses are a natural fit.
  return status === 403 || status === 429 || status >= 500 ? 'blocked' : 'failed';
}

// Strip URL substrings from merchant-controlled strings before they enter a
// receipt payload. The backend 422s ANY payload string containing http(s)://,
// so forwarding a URL-bearing title verbatim wedges the claim into
// lease-expiry loops it can never complete.
function scrubUrls(value) {
  if (typeof value !== 'string') return value;
  const scrubbed = value.replace(/https?:\/\/\S*/gi, '').replace(/\s+/g, ' ').trim();
  return scrubbed || null;
}

function redactedPricedFacts(priced) {
  if (!isPlainObject(priced)) return null;
  const item = isPlainObject(priced.item) ? priced.item : {};
  return {
    item_id: scrubUrls(firstString(item.id, item.variant_id, item.sku)),
    item_title: scrubUrls(firstString(item.title, item.name)),
    item_price: item.price != null ? item.price : null,
    subtotal: priced.subtotal != null ? priced.subtotal : null,
    shipping: priced.shipping != null ? priced.shipping : null,
    tax: priced.tax != null ? priced.tax : null,
    total: priced.total != null ? priced.total : null,
    currency: firstString(priced.currency),
    shipping_option_count: Array.isArray(priced.shipping_options)
      ? priced.shipping_options.length
      : 0,
    checkout_status: scrubUrls(firstString(priced.status)),
  };
}

/**
 * Create a Store Audit UCP probe service.
 *
 * @param {{client?: object, clientOptions?: object, now?: () => Date}} [deps]
 */
function createUcpStoreAuditProbe(deps = {}) {
  const client = deps.client || createUcpBuyerAgentClient({
    forceAnonymous: true,
    timeoutMs: 4000,
    retryAttempts: 1,
    ...(isPlainObject(deps.clientOptions) ? deps.clientOptions : {}),
    // Must win even if a caller accidentally supplied a credential option.
    forceAnonymous: true,
  });
  if (client.tier !== 'anonymous') {
    throw new Error('ucpStoreAuditProbe requires an anonymous UCP client');
  }
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();

  async function probe({ brandDomain, variantGid, quantity = 1 } = {}) {
    const origin = normalizeBrandOrigin(brandDomain);
    if (!origin) {
      return {
        verifier_id: VERIFIER_ID,
        verification_status: 'failed',
        reason: 'invalid_input',
        route: null,
        acceptance_signal: null,
        observed_at: now().toISOString(),
      };
    }

    let discovery;
    try {
      discovery = await client.discoverEndpoint(origin);
    } catch (error) {
      return {
        verifier_id: VERIFIER_ID,
        verification_status: 'blocked',
        reason: FAILURE_REASON.PROFILE_UNREACHABLE,
        route: null,
        acceptance_signal: null,
        observed_at: now().toISOString(),
      };
    }

    const endpoint = firstString(discovery && discovery.mcpEndpoint);
    if (!endpoint) {
      // Only a CLEAN absence is a durable "no UCP here" observation: a 2xx
      // profile without an MCP endpoint, or a 404 on the well-known path. The
      // backend deactivates the route on succeeded+NOT_UCP_REACHABLE, so a
      // 403 WAF page, a 429, a 5xx, a refused 3xx, or an unknown status must
      // NOT buy a delisting — those are upstream conditions, reported blocked.
      const discoveryStatus = Number(discovery && discovery.status);
      const cleanAbsence = (discoveryStatus >= 200 && discoveryStatus < 300) || discoveryStatus === 404;
      if (cleanAbsence) {
        return {
          verifier_id: VERIFIER_ID,
          verification_status: 'succeeded',
          reason: FAILURE_REASON.NOT_UCP_REACHABLE,
          route: null,
          acceptance_signal: null,
          observed_at: now().toISOString(),
        };
      }
      return {
        verifier_id: VERIFIER_ID,
        verification_status: 'blocked',
        reason: discoveryStatus >= 300 && discoveryStatus < 400
          ? FAILURE_REASON.PROFILE_REDIRECTED
          : FAILURE_REASON.PROFILE_UNREACHABLE,
        route: null,
        acceptance_signal: null,
        observed_at: now().toISOString(),
      };
    }

    const route = {
      normalized_domain: new URL(origin).hostname.toLowerCase(),
      route_kind: 'ucp',
      endpoint_normalized: endpoint,
      profile_url: discovery.wellKnownUrl || null,
    };
    let tools;
    try {
      tools = await client.listTools(endpoint);
    } catch (error) {
      return {
        verifier_id: VERIFIER_ID,
        verification_status: 'blocked',
        reason: FAILURE_REASON.TOOL_ERROR,
        route,
        acceptance_signal: null,
        observed_at: now().toISOString(),
      };
    }

    const capabilities = toolNames(tools);
    const baseSignal = {
      evidence_type: 'acceptance_signal',
      evidence_level: EVIDENCE_LEVEL_DETECTED,
      payload: {
        protocol: 'ucp',
        anonymous: true,
        profile_status: discovery.status || null,
        tools_status: tools.status || null,
        capabilities,
      },
    };
    if (!tools.ok) {
      return {
        verifier_id: VERIFIER_ID,
        verification_status: statusForUpstream(tools),
        reason: FAILURE_REASON.TOOL_ERROR,
        route,
        // A failed/blocked run carries its diagnostics on verification_runs;
        // it must not assert an acceptance signal that the backend would
        // (correctly) treat as a successful durable route observation.
        acceptance_signal: null,
        observed_at: now().toISOString(),
      };
    }
    if (!capabilities.includes('create_checkout') || !variantGid) {
      return {
        verifier_id: VERIFIER_ID,
        verification_status: 'succeeded',
        reason: !variantGid ? 'variant_required_for_checkout_test' : 'create_checkout_unavailable',
        route,
        acceptance_signal: baseSignal,
        observed_at: now().toISOString(),
      };
    }

    // createCheckoutPreview uses a clearly synthetic address/email and invokes
    // exactly one non-retried create_checkout. It never attaches payment data
    // or calls complete_checkout.
    let checkout;
    try {
      checkout = await client.createCheckoutPreview(endpoint, {
        lineItems: [{ item: { id: variantGid }, quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1 }],
      });
    } catch (error) {
      return {
        verifier_id: VERIFIER_ID,
        verification_status: 'failed',
        reason: FAILURE_REASON.TOOL_ERROR,
        route,
        acceptance_signal: null,
        observed_at: now().toISOString(),
      };
    }
    if (!checkout.ok) {
      return {
        verifier_id: VERIFIER_ID,
        verification_status: statusForUpstream(checkout),
        reason: FAILURE_REASON.TOOL_ERROR,
        route,
        acceptance_signal: null,
        observed_at: now().toISOString(),
      };
    }

    return {
      verifier_id: VERIFIER_ID,
      verification_status: 'succeeded',
      reason: 'checkout_tested',
      route,
      acceptance_signal: {
        evidence_type: 'acceptance_signal',
        evidence_level: EVIDENCE_LEVEL_TESTED,
        payload: {
          ...baseSignal.payload,
          checkout_requires_escalation: Boolean(checkout.requires_escalation),
          priced_facts: redactedPricedFacts(checkout.priced),
        },
      },
      observed_at: now().toISOString(),
    };
  }

  return { probe };
}

module.exports = {
  createUcpStoreAuditProbe,
  VERIFIER_ID,
  EVIDENCE_LEVEL_DETECTED,
  EVIDENCE_LEVEL_TESTED,
  redactedPricedFacts,
};
