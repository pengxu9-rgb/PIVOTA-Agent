#!/usr/bin/env node
'use strict';

/*
 * scripts/probe-cafe24-store-ucp.cjs — MANUAL, READ-ONLY probe of ONE Cafe24 store's own UCP door (NOT CI).
 *
 * WHY. Cafe24 stores can publish a per-store UCP profile at `https://<store>.cafe24.com/.well-known/ucp`, with the
 * services on `https://<store>.cafe24api.com/api/ucp[/mcp]` (UCP 2026-08-25, per a public third-party checker). That
 * is the same per-store model the gateway already drives on Shopify stores with ucpBuyerAgentClient. Nothing from a
 * Pivota runtime has called such a door yet. This probe answers, for one store:
 *   1. What the profile declares: version, transports, capabilities, payment handlers.
 *   2. Whether the MCP endpoint answers `tools/list` to our agent profile at the ANONYMOUS tier, or refuses
 *      (profile refused, session required, 4xx, ...), and which tools it lists.
 *   3. Whether `search_catalog` and `lookup_catalog` answer, with counts, currencies and id shapes only.
 *
 * HARD BOUNDS (each one tested):
 *   - Read only. The only JSON-RPC calls are `tools/list` and `tools/call` of `search_catalog` / `lookup_catalog`.
 *     The transport refuses any other method or tool before a byte leaves, whatever the code above it does. No cart,
 *     no checkout, no order. The shared client also hard-refuses complete_checkout.
 *   - One store per run. Only two hosts can be contacted: `<store>.cafe24.com` (the profile) and
 *     `<store>.cafe24api.com` (the services). The MCP endpoint must be exactly `https://<store>.cafe24api.com/api/ucp/mcp`.
 *   - At most 4 requests: profile, tools/list, one search, one lookup. No retries.
 *   - ANONYMOUS tier: no credential, no signature, no Authorization header. The client is built forceAnonymous and
 *     the probe refuses to run if it reports anything else.
 *   - The report holds labels, statuses, counts, safe codes and capability/tool NAMES only: never a product title,
 *     URL, description, price amount, or a response body. External content is data, never instructions.
 *   - Runs where the caller runs it. It is meant to run as a staging Cloud Run job on the gateway image (staging
 *     egress), never from a laptop.
 *
 * Usage:
 *   UCP_AGENT_PROFILE_URL=https://<agent profile host>/.well-known/ucp-agent \
 *     node scripts/probe-cafe24-store-ucp.cjs --store <store> [--query "<words>"] [--country KR]
 * `--store` is the store's subdomain (or its full `<store>.cafe24.com` host). `--query` is optional, letters, digits
 * and spaces only, at most 60 characters; without it the probe stops after tools/list.
 * Output: one `CAFE24_STORE_UCP_PROBE {json}` line, then `CAFE24_STORE_UCP_PROBE_DONE`.
 * Exit: 0 = the probe ran (whatever the store answered), 2 = input refused, 1 = the probe itself failed.
 */

const {
  createUcpBuyerAgentClient,
  createPublicNetworkFetch,
  TRUST_TIER,
  profileAdvertisesCapability,
} = require('../src/services/ucpBuyerAgentClient');
const { classifyCallOutcome, parseSseRaw, REASON } = require('../src/services/cafe24GlobalCatalog');
const { UCP_SPEC_VERSION } = require('../safety-kernel/src/protocol/ucpSpecVersion.cjs');

const PREFIX = 'CAFE24_STORE_UCP_PROBE';
const MAX_REQUESTS = 4;
const CALL_TIMEOUT_MS = 10000;
const READ_TOOLS = Object.freeze(new Set(['search_catalog', 'lookup_catalog']));
const READ_METHODS = Object.freeze(new Set(['tools/list', 'tools/call']));
const STORE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,99}$/;
const QUERY_RE = /^[A-Za-z0-9 ]{1,60}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_NAMES = 60;

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return v == null ? '' : String(v).trim();
}

/** A name from the store (capability, tool, handler, transport) for the report: itself if it is name-shaped, else 'other'. */
function safeName(v) {
  const s = str(v);
  return NAME_RE.test(s) ? s : 'other';
}

function safeNames(list) {
  const out = [];
  for (const v of list) {
    if (out.length >= MAX_NAMES) break;
    out.push(safeName(v));
  }
  return out;
}

/** `--store` → the store's subdomain, or null. Accepts `<store>` or `<store>.cafe24.com`, nothing else. */
function parseStore(raw) {
  let s = str(raw).toLowerCase();
  if (s.endsWith('.cafe24.com')) s = s.slice(0, -'.cafe24.com'.length);
  return STORE_RE.test(s) ? s : null;
}

function parseArgs(argv) {
  const out = { store: null, query: null, country: 'KR', errors: [] };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!['--store', '--query', '--country'].includes(flag)) {
      out.errors.push(`unknown argument: ${safeName(flag)}`);
      continue;
    }
    if (seen.has(flag)) {
      out.errors.push(`repeated ${flag}`);
      i += 1;
      continue;
    }
    seen.add(flag);
    const value = argv[i + 1];
    i += 1;
    if (value === undefined) {
      out.errors.push(`${flag} needs a value`);
    } else if (flag === '--store') {
      out.store = parseStore(value);
      if (!out.store) out.errors.push('--store must be a Cafe24 store subdomain or <store>.cafe24.com');
    } else if (flag === '--query') {
      if (QUERY_RE.test(value) && value.trim()) out.query = value.trim();
      else out.errors.push('--query must be 1-60 letters, digits or spaces');
    } else {
      const c = str(value).toUpperCase();
      if (COUNTRY_RE.test(c)) out.country = c;
      else out.errors.push('--country must be a two-letter country code');
    }
  }
  if (!seen.has('--store')) out.errors.push('--store is required');
  return out;
}

function hostsFor(store) {
  return {
    profileOrigin: `https://${store}.cafe24.com`,
    profileHost: `${store}.cafe24.com`,
    apiHost: `${store}.cafe24api.com`,
    pinnedEndpoint: `https://${store}.cafe24api.com/api/ucp/mcp`,
  };
}

/**
 * The transport every request goes through. It refuses, before sending: a host other than the store's two, a 5th
 * request, a non-GET to the profile host, a GET to the API host, and any JSON-RPC body that is not `tools/list` or a
 * `tools/call` of a read tool. `trace` records one safe line per request attempted.
 */
function guardedFetch({ baseFetch, store, trace }) {
  const { profileHost, apiHost } = hostsFor(store);
  return async (url, init = {}) => {
    const u = new URL(String(url));
    const host = u.hostname.toLowerCase();
    const method = str(init.method || 'GET').toUpperCase();
    const entry = { method, host: host === profileHost || host === apiHost ? host : 'other', path: safeName(u.pathname) };
    trace.push(entry);
    const refuse = (why) => {
      entry.refused = why;
      throw Object.assign(new Error(`probe transport refused: ${why}`), { code: 'PROBE_REFUSED' });
    };
    if (trace.length > MAX_REQUESTS) refuse('request_cap');
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) refuse('not_plain_https');
    if (host === profileHost) {
      if (method !== 'GET' || u.pathname !== '/.well-known/ucp' || u.search) refuse('profile_host_path');
    } else if (host === apiHost) {
      if (method !== 'POST') refuse('api_host_method');
      let body;
      try { body = JSON.parse(String(init.body || '')); } catch { refuse('body_not_json'); }
      const rpc = isPlainObject(body) ? str(body.method) : '';
      if (!READ_METHODS.has(rpc)) refuse('rpc_method');
      entry.rpc = rpc;
      if (rpc === 'tools/call') {
        const tool = isPlainObject(body.params) ? str(body.params.name) : '';
        if (!READ_TOOLS.has(tool)) refuse('tool_not_read_only');
        entry.tool = tool;
      }
    } else {
      refuse('host_not_store');
    }
    const res = await baseFetch(url, init);
    entry.status = Number(res && res.status) || 0;
    return res;
  };
}

/** Capability names from a profile: `capabilities` as an object keyed by name, or an array of { name }. */
function capabilitiesOf(ucp) {
  const caps = ucp && ucp.capabilities;
  const out = [];
  if (Array.isArray(caps)) {
    for (const c of caps) {
      if (isPlainObject(c)) out.push({ name: safeName(c.name), version: safeName(c.version) });
    }
  } else if (isPlainObject(caps)) {
    for (const [name, entries] of Object.entries(caps)) {
      const list = Array.isArray(entries) ? entries : [entries];
      const versions = list.filter(isPlainObject).map((e) => safeName(e.version));
      out.push({ name: safeName(name), versions: versions.length ? versions : ['other'] });
    }
  }
  return out.slice(0, MAX_NAMES);
}

/** Payment handler names: `payment_handlers` keyed by name (2026-08-25), or `payment.handlers` as [{ id|name }]. */
function paymentHandlersOf(bp, ucp) {
  const keyed = isPlainObject(ucp && ucp.payment_handlers) ? ucp.payment_handlers
    : (isPlainObject(bp && bp.payment_handlers) ? bp.payment_handlers : null);
  if (keyed) return safeNames(Object.keys(keyed));
  const listed = bp && isPlainObject(bp.payment) && Array.isArray(bp.payment.handlers) ? bp.payment.handlers : null;
  if (listed) return safeNames(listed.filter(isPlainObject).map((h) => h.id || h.name));
  return [];
}

/** Service bindings: name, transport, and whether its endpoint is on the store's API host. Never the URL itself. */
function servicesOf(ucp, apiHost) {
  const services = ucp && ucp.services;
  const out = [];
  const push = (name, b) => {
    if (!isPlainObject(b)) return;
    let onApiHost = null;
    const ep = str(b.endpoint || b.url);
    if (ep) {
      try { onApiHost = new URL(ep).hostname.toLowerCase() === apiHost; } catch { onApiHost = false; }
    }
    out.push({ service: safeName(name), transport: safeName(b.transport), version: safeName(b.version), endpoint_on_api_host: onApiHost });
  };
  if (Array.isArray(services)) services.forEach((b) => push(b && b.name, b));
  else if (isPlainObject(services)) {
    for (const [name, v] of Object.entries(services)) (Array.isArray(v) ? v : [v]).forEach((b) => push(name, b));
  }
  return out.slice(0, MAX_NAMES);
}

function summarizeProfile(bp, apiHost) {
  const ucp = isPlainObject(bp.ucp) ? bp.ucp : bp;
  const versions = [ucp.version, ...(Array.isArray(ucp.supported_versions) ? ucp.supported_versions : [])]
    .map(safeName).filter((v) => v !== 'other');
  const handlers = paymentHandlersOf(bp, ucp);
  const keys = Array.isArray(bp.signing_keys) ? bp.signing_keys : (Array.isArray(ucp.signing_keys) ? ucp.signing_keys : []);
  return {
    versions,
    our_version: UCP_SPEC_VERSION,
    version_overlap: versions.length ? versions.includes(UCP_SPEC_VERSION) : null,
    services: servicesOf(ucp, apiHost),
    capabilities: capabilitiesOf(ucp),
    advertises: {
      checkout: profileAdvertisesCapability(bp, 'dev.ucp.shopping.checkout'),
      cart: profileAdvertisesCapability(bp, 'dev.ucp.shopping.cart'),
      order: profileAdvertisesCapability(bp, 'dev.ucp.shopping.order'),
      catalog_search: profileAdvertisesCapability(bp, 'dev.ucp.shopping.catalog.search'),
      catalog_lookup: profileAdvertisesCapability(bp, 'dev.ucp.shopping.catalog.lookup'),
    },
    payment_handler_count: handlers.length,
    payment_handlers: handlers,
    signing_key_count: keys.length,
  };
}

function rpcMessageOf(callResult) {
  const r = callResult && callResult.response;
  if (isPlainObject(r) && typeof r.raw === 'string') return parseSseRaw(r.raw);
  return isPlainObject(r) ? r : null;
}

/** tools/list → { reason, tools? }. An answer with a tools array is ok; anything else is classified as a call is. */
function classifyToolsList(listed) {
  const msg = rpcMessageOf(listed);
  const status = Number(listed && listed.status) || 0;
  if (status === 200 && msg && isPlainObject(msg.result) && Array.isArray(msg.result.tools)) {
    const names = msg.result.tools.filter(isPlainObject).map((t) => t.name);
    return { reason: REASON.OK, http_status: status, tool_count: names.length, tools: safeNames(names) };
  }
  const c = classifyCallOutcome({ callResult: listed });
  return { reason: c.reason, http_status: c.http_status, mcp_error_code: c.mcp_error_code };
}

function idShape(id) {
  const s = str(id);
  if (!s) return 'none';
  if (/^gid:\/\/[a-z0-9]+\/[A-Za-z]+\/[A-Za-z0-9_-]+$/i.test(s)) return 'gid';
  if (/^\d+$/.test(s)) return 'numeric';
  return 'other';
}

function currenciesIn(node, out = new Set(), depth = 0) {
  if (depth > 6 || out.size >= 5 || node == null) return out;
  if (Array.isArray(node)) { node.slice(0, 50).forEach((n) => currenciesIn(n, out, depth + 1)); return out; }
  if (!isPlainObject(node)) return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'currency' && typeof v === 'string' && CURRENCY_RE.test(v)) out.add(v);
    else if (v && typeof v === 'object') currenciesIn(v, out, depth + 1);
  }
  return out;
}

function hasNumericAmount(node, depth = 0) {
  if (depth > 6 || node == null) return false;
  if (Array.isArray(node)) return node.slice(0, 50).some((n) => hasNumericAmount(n, depth + 1));
  if (!isPlainObject(node)) return false;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'amount' && (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)))) return true;
    if (v && typeof v === 'object' && hasNumericAmount(v, depth + 1)) return true;
  }
  return false;
}

/** A search/lookup answer → counts and shapes. The first product's id is returned separately, never reported. */
function summarizeProducts(outcome) {
  const products = outcome.payload && Array.isArray(outcome.payload.products) ? outcome.payload.products : [];
  const first = products.find(isPlainObject) || null;
  const variants = first && Array.isArray(first.variants) ? first.variants : [];
  return {
    summary: {
      products: products.length,
      first_product_id_shape: first ? idShape(first.id) : 'none',
      first_product_variants: variants.length,
      first_variant_id_shape: variants[0] && isPlainObject(variants[0]) ? idShape(variants[0].id) : 'none',
      currencies: [...currenciesIn(products)].sort(),
      priced: hasNumericAmount(products),
    },
    firstId: first && typeof first.id === 'string' && first.id.length <= 512 ? first.id : null,
  };
}

function classifyThrown(e) {
  if (e && e.code === 'PROBE_REFUSED') return { reason: 'probe_refused' };
  return classifyCallOutcome({ thrown: e });
}

async function runProbe({ store, query, country, profileUrl, baseFetch, createClient = createUcpBuyerAgentClient }) {
  const hosts = hostsFor(store);
  const trace = [];
  const report = { store_host: hosts.profileHost, country, query_given: Boolean(query), steps: {} };
  const client = createClient({
    forceAnonymous: true,
    allowTokenTier: false,
    retryAttempts: 0,
    timeoutMs: CALL_TIMEOUT_MS,
    profileUrl,
    merchantFetchImpl: guardedFetch({ baseFetch, store, trace }),
  });
  const tier = client.describeTier();
  report.tier = { tier: tier.tier, signs_requests: Boolean(tier.signs_requests), has_credential: Boolean(tier.has_credential),
    profile_url_set: Boolean(tier.profile_url) };
  report.trace = trace;
  if (tier.tier !== TRUST_TIER.ANONYMOUS || tier.signs_requests || tier.has_credential || tier.has_client_credentials) {
    report.stopped_at = 'tier';
    report.steps.tier = { reason: REASON.CREDENTIAL_TIER_REFUSED };
    return report;
  }
  if (!tier.profile_url) {
    report.stopped_at = 'tier';
    report.steps.tier = { reason: REASON.NO_PROFILE_URL };
    return report;
  }

  // 1. Profile.
  let found;
  try {
    found = await client.discoverEndpoint(hosts.profileOrigin);
  } catch (e) {
    report.steps.profile = classifyThrown(e);
    report.stopped_at = 'profile';
    return report;
  }
  if (!found || !isPlainObject(found.businessProfile)) {
    report.steps.profile = { reason: REASON.DISCOVERY_FAILED, http_status: found && found.status };
    report.stopped_at = 'profile';
    return report;
  }
  report.steps.profile = { reason: REASON.OK, http_status: found.status, ...summarizeProfile(found.businessProfile, hosts.apiHost) };
  if (str(found.mcpEndpoint) !== hosts.pinnedEndpoint) {
    report.steps.profile.mcp_endpoint = found.mcpEndpoint ? 'not_pinned' : 'absent';
    report.stopped_at = 'profile';
    return report;
  }
  report.steps.profile.mcp_endpoint = 'pinned';

  // 2. tools/list.
  let listOutcome;
  try {
    listOutcome = classifyToolsList(await client.listTools(hosts.pinnedEndpoint));
  } catch (e) {
    listOutcome = classifyThrown(e);
  }
  report.steps.tools_list = listOutcome;
  if (listOutcome.reason !== REASON.OK) { report.stopped_at = 'tools_list'; return report; }
  if (!query) { report.stopped_at = 'no_query'; return report; }

  // 3. search_catalog, then 4. lookup_catalog on the first id.
  const listedTools = new Set(listOutcome.tools);
  if (!listedTools.has('search_catalog')) { report.steps.search = { reason: REASON.TOOL_NOT_LISTED }; report.stopped_at = 'search'; return report; }
  let firstId = null;
  try {
    const res = await client.callTool(hosts.pinnedEndpoint, 'search_catalog', {
      catalog: { query, context: { address_country: country }, pagination: { limit: 1 } },
    });
    const c = classifyCallOutcome({ callResult: res });
    const step = { reason: c.reason, http_status: c.http_status, mcp_error_code: c.mcp_error_code, ucp_error_code: c.ucp_error_code };
    if (c.reason === REASON.OK) {
      const s = summarizeProducts(c);
      Object.assign(step, s.summary);
      firstId = s.firstId;
    }
    report.steps.search = step;
  } catch (e) {
    report.steps.search = classifyThrown(e);
  }
  if (!firstId) { report.stopped_at = 'search'; return report; }
  if (!listedTools.has('lookup_catalog')) { report.steps.lookup = { reason: REASON.TOOL_NOT_LISTED }; report.stopped_at = 'lookup'; return report; }
  try {
    const res = await client.lookupCatalog(hosts.pinnedEndpoint, { ids: [firstId], context: { address_country: country } });
    const c = classifyCallOutcome({ callResult: res });
    const step = { reason: c.reason, http_status: c.http_status, mcp_error_code: c.mcp_error_code, ucp_error_code: c.ucp_error_code };
    if (c.reason === REASON.OK) Object.assign(step, summarizeProducts(c).summary);
    report.steps.lookup = step;
  } catch (e) {
    report.steps.lookup = classifyThrown(e);
  }
  report.stopped_at = 'done';
  return report;
}

function emit(stdout, report) {
  stdout.write(`${PREFIX} ${JSON.stringify(report)}\n`);
  stdout.write(`${PREFIX}_DONE\n`);
}

async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, fetchImpl, createClient } = {}) {
  const args = parseArgs(argv);
  const profileUrl = str(env.UCP_AGENT_PROFILE_URL);
  let profileOk = false;
  try { profileOk = new URL(profileUrl).protocol === 'https:'; } catch { profileOk = false; }
  if (!profileOk) args.errors.push('UCP_AGENT_PROFILE_URL must be an https URL');
  if (args.errors.length) {
    emit(stdout, { verdict: 'INPUT_REFUSED', errors: args.errors });
    return 2;
  }
  try {
    const report = await runProbe({
      store: args.store,
      query: args.query,
      country: args.country,
      profileUrl,
      baseFetch: typeof fetchImpl === 'function' ? fetchImpl : createPublicNetworkFetch(),
      ...(typeof createClient === 'function' ? { createClient } : {}),
    });
    report.verdict = 'RAN';
    emit(stdout, report);
    return 0;
  } catch (e) {
    emit(stdout, { verdict: 'PROBE_FAILED', error: safeName(e && e.name) });
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  main,
  runProbe,
  parseArgs,
  parseStore,
  guardedFetch,
  summarizeProfile,
  classifyToolsList,
  summarizeProducts,
  idShape,
  READ_TOOLS,
  MAX_REQUESTS,
};
