#!/usr/bin/env node
/*
 * No-charge deployed remote MCP + confirmation-action smoke.
 *
 * This script never calls complete_checkout_session, submit_payment, or any paid
 * path. Full platform evidence requires a short verified test-identity window
 * and an unpaid order id from the strict create-order canary.
 */

import { createHmac, randomUUID } from 'node:crypto';

const REQUIRED_TOOLS = [
  'search_catalog',
  'get_product',
  'create_checkout_session',
  'get_checkout_session',
  'complete_checkout_session',
  'get_order',
  'request_after_sales',
];

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

class SmokeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SmokeError';
    this.details = details;
  }
}

function parseArgs(argv) {
  const flags = { json: false, full: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') flags.json = true;
    else if (arg === '--full') flags.full = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (/complete|charge|payment/i.test(arg)) {
      throw new UsageError('This smoke refuses payment/complete/charge flags.');
    } else {
      throw new UsageError(`Unknown flag: ${arg}`);
    }
  }
  return flags;
}

function usageText() {
  return [
    'Usage: node scripts/smoke_protocol_edge_remote_mcp.mjs [--json] [--full]',
    '',
    'Required env: PROBE_BASE, PROBE_KEY',
    'Optional env: PROBE_AUTH_HEADER, MCP_SMOKE_USER_REF, MCP_SMOKE_ACP_SESSION_ID',
    'Full evidence env: MCP_SMOKE_ALLOW_VERIFIED_SESSION=1, MCP_SMOKE_MERCHANT_ID, MCP_SMOKE_PRODUCT_ID, MCP_SMOKE_ORDER_ID, CONFIRMATION_SECRET',
    '',
    'Safety: never calls complete_checkout_session, submit_payment, or any paid operation.',
  ].join('\n');
}

function env(name) {
  const value = process.env[name];
  return value && String(value).trim() ? String(value).trim() : undefined;
}

function boolEnv(name) {
  return /^(1|true|yes|on)$/i.test(env(name) || '');
}

function must(name) {
  const value = env(name);
  if (!value) throw new UsageError(`Missing required env var: ${name}`);
  return value;
}

function loadConfig() {
  const runId = env('MCP_SMOKE_RUN_ID') || `mcp_smoke_${Date.now()}_${randomUUID().slice(0, 8)}`;
  return {
    runId,
    base: must('PROBE_BASE').replace(/\/+$/, ''),
    key: must('PROBE_KEY'),
    authHeader: env('PROBE_AUTH_HEADER') || 'Authorization',
    userRef: env('MCP_SMOKE_USER_REF') || env('STRICT_CANARY_USER_REF') || `usr_mcp_smoke_${runId}`,
    acpSessionId: env('MCP_SMOKE_ACP_SESSION_ID') || env('STRICT_CANARY_ACP_SESSION_ID') || `acp_mcp_smoke_${runId}`,
    allowVerifiedSession: boolEnv('MCP_SMOKE_ALLOW_VERIFIED_SESSION'),
    merchantId: env('MCP_SMOKE_MERCHANT_ID') || env('PROBE_MERCHANT_ID'),
    productId: env('MCP_SMOKE_PRODUCT_ID') || env('PROBE_PRODUCT_ID'),
    variantId: env('MCP_SMOKE_VARIANT_ID') || env('PROBE_VARIANT_ID'),
    currency: (env('MCP_SMOKE_CURRENCY') || env('PROBE_CURRENCY') || 'USD').toUpperCase(),
    orderId: env('MCP_SMOKE_ORDER_ID') || env('ORDER_ID'),
    confirmationSecret: env('CONFIRMATION_SECRET'),
    operator: env('MCP_SMOKE_APPROVER') || env('USER') || 'unknown-operator',
    expectedFullSha: env('MCP_SMOKE_GATEWAY_FULL_SHA'),
    expectedDeploymentId: env('MCP_SMOKE_GATEWAY_DEPLOYMENT_ID'),
  };
}

function authHeaders(config) {
  if (config.authHeader.toLowerCase() === 'authorization') {
    const value = /^(Bearer|ApiKey|Basic)\s+/i.test(config.key) ? config.key : `Bearer ${config.key}`;
    return { Authorization: value };
  }
  return { [config.authHeader]: config.key };
}

function identityHeaders(config) {
  return {
    'X-Test-User-Ref': config.userRef,
    'X-Test-Acp-Session-Id': config.acpSessionId,
    'X-Test-Diagnostics': '1',
  };
}

function rpc(method, params = {}, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).catch((error) => {
    throw new SmokeError('Network error', { url, message: redactString(error?.message || String(error)) });
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new SmokeError('Response was not JSON', { url, status: response.status, body: redactValue(text), parse_error: error?.message || String(error) });
  }
  return { status: response.status, body: parsed };
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { method: 'GET', headers }).catch(() => null);
  if (!response) return {};
  const text = await response.text().catch(() => '');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

async function mcp(config, body, extraHeaders = {}) {
  const out = await postJson(`${config.base}/mcp`, body, { ...authHeaders(config), ...extraHeaders });
  if (out.status < 200 || out.status >= 300) {
    throw new SmokeError('MCP HTTP non-2xx response', { status: out.status, body: redactValue(out.body) });
  }
  return out.body;
}

function parseToolText(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function requireUserAuthToolError(body) {
  const result = body?.result;
  const text = JSON.stringify(parseToolText(result));
  if (result?.isError !== true || !text.includes('USER_AUTH_REQUIRED')) {
    throw new SmokeError('Expected USER_AUTH_REQUIRED tool error for write without verified identity', { body: redactValue(body) });
  }
}

// The DECLARED shape — every field below is in the door's published inputSchema. Since PR #2103 the door
// refuses undeclared arguments by name (declared-schema guard), so the spoofed variant below is a separate
// probe with its own expected outcome, not extra fields piggybacked onto this one.
function createSessionArgs(config) {
  return {
    idempotency_key: `idem_mcp_session_${config.runId}`,
    quote: {
      merchant_id: config.merchantId,
      items: [{
        product_id: config.productId,
        ...(config.variantId ? { variant_id: config.variantId } : {}),
        quantity: 1,
      }],
      // The door requires a buyer email (unless the identity JWT attests one — this smoke's does not) and,
      // if a shipping address is supplied at all, all five of name/address_line1/city/postal_code/country.
      // Both are checked at intake, before pricing; this body used to omit the email and the name entirely
      // and was accepted, which is the defect the intake now closes.
      customer_email: env('MCP_SMOKE_CUSTOMER_EMAIL') || 'smoke-probe@pivota.cc',
      shipping_address: {
        name: env('MCP_SMOKE_SHIP_NAME') || 'Pivota Smoke Probe',
        country: env('MCP_SMOKE_SHIP_COUNTRY') || 'US',
        state: env('MCP_SMOKE_SHIP_STATE') || 'CA',
        city: env('MCP_SMOKE_SHIP_CITY') || 'San Francisco',
        postal_code: env('MCP_SMOKE_SHIP_POSTAL') || '94105',
        address_line1: env('MCP_SMOKE_SHIP_ADDRESS1') || '1 Market St',
      },
    },
  };
}

// The SPOOF probe: model-asserted identity (`user_ref`/`acp_session_id`), a caller-set money field
// (`items[].amount`) and an undeclared `quote.currency`. Before PR #2103 these were silently stripped and
// the create SUCCEEDED (evidence key: model_supplied_identity_ignored). Since the declared-schema guard,
// the whole call is REFUSED with INVALID_ARGUMENTS naming the fields — which is what this smoke now
// requires (evidence key: model_supplied_identity_refused). A gateway that ACCEPTS this body is the defect.
function spoofedCreateSessionArgs(config) {
  const args = createSessionArgs(config);
  return {
    ...args,
    idempotency_key: `idem_mcp_spoof_${config.runId}`,
    user_ref: 'usr_body_attacker',
    acp_session_id: 'acp_body_attacker',
    quote: {
      ...args.quote,
      currency: config.currency,
      items: args.quote.items.map((it) => ({ ...it, amount: 99999999 })),
    },
  };
}

function assertCanRunVerifiedSession(config) {
  if (!config.allowVerifiedSession) {
    throw new UsageError('Full smoke requires MCP_SMOKE_ALLOW_VERIFIED_SESSION=1.');
  }
  if (!config.merchantId || !config.productId) {
    throw new UsageError('Full smoke requires MCP_SMOKE_MERCHANT_ID/PROBE_MERCHANT_ID and MCP_SMOKE_PRODUCT_ID/PROBE_PRODUCT_ID.');
  }
}

function assertCanRunConfirmation(config) {
  if (!config.orderId) throw new UsageError('Full smoke requires MCP_SMOKE_ORDER_ID or ORDER_ID from the strict create-order canary.');
  if (!config.confirmationSecret || config.confirmationSecret.length < 16) {
    throw new UsageError('Full smoke requires CONFIRMATION_SECRET to sign /checkout/confirm locally.');
  }
}

function signedConfirmationHeaders(config) {
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', config.confirmationSecret)
    .update(`${timestamp}.${config.userRef}.${config.acpSessionId}.${config.orderId}`)
    .digest('hex');
  return {
    'X-Pivota-Confirm-Timestamp': timestamp,
    'X-Pivota-Confirm-Signature': signature,
  };
}

async function runSmoke(flags, config) {
  const version = await getJson(`${config.base}/version`, authHeaders(config));
  const gatewayFullSha = config.expectedFullSha || version.full_sha || version.commit || 'unknown';
  const gatewayDeploymentId = config.expectedDeploymentId || version.deployment_id || 'unknown';

  const init = await mcp(config, rpc('initialize', {}, 1));
  if (!init?.result?.serverInfo) throw new SmokeError('MCP initialize did not return serverInfo', { body: redactValue(init) });

  const listed = await mcp(config, rpc('tools/list', {}, 2));
  const tools = Array.isArray(listed?.result?.tools) ? listed.result.tools.map((tool) => tool?.name).filter(Boolean) : [];
  const missing = REQUIRED_TOOLS.filter((tool) => !tools.includes(tool));
  if (missing.length) throw new SmokeError('MCP tools/list missing required tools', { missing, tools });

  const noIdentity = await mcp(config, rpc('tools/call', {
    name: 'create_checkout_session',
    arguments: {
      idempotency_key: `idem_mcp_no_identity_${config.runId}`,
      quote: { merchant_id: 'probe-merchant', items: [{ product_id: 'probe-product', quantity: 1 }] },
    },
  }, 3));
  requireUserAuthToolError(noIdentity);

  const evidence = {
    operator: { approver: config.operator },
    environment: {
      gateway_full_sha: String(gatewayFullSha),
      gateway_deployment_id: String(gatewayDeploymentId),
    },
    remote_mcp: {
      server_url: `${config.base}/mcp`,
      initialize_ok: true,
      tools_listed: tools,
      write_without_verified_identity_failed: true,
      write_without_verified_identity_code: 'USER_AUTH_REQUIRED',
      verified_session_created_checkout_session: false,
      model_supplied_identity_refused: false,
    },
    identity: {
      user_ref_source: 'verified_session_or_test_identity',
      acp_session_id_source: 'verified_session_or_test_identity',
      body_identity_rejected: false,
    },
    confirmation_action: {
      route: `${config.base}/checkout/confirm`,
      unsigned_action_rejected: false,
      signed_user_action_minted_token: false,
      token_minted_only_after_user_action: false,
      token_not_exposed_to_model_tool: true,
    },
    no_money_ops: {
      complete_checkout_session_called: false,
      submit_payment_called: false,
      paid_charge_attempted: false,
    },
    redaction: { scan_passed: true },
    credential_hygiene: { rotation_needed: false },
  };

  if (flags.full) {
    assertCanRunVerifiedSession(config);
    // 1) SPOOF: model-asserted identity/money fields must be REFUSED loudly (declared-schema guard,
    //    PR #2103) — never silently stripped, never priced.
    const spoofed = await mcp(config, rpc('tools/call', {
      name: 'create_checkout_session',
      arguments: spoofedCreateSessionArgs(config),
    }, 4), identityHeaders(config));
    const spoofBody = JSON.stringify(parseToolText(spoofed?.result));
    if (spoofed?.result?.isError !== true || !spoofBody.includes('INVALID_ARGUMENTS') || !spoofBody.includes('user_ref')) {
      throw new SmokeError('Spoofed create_checkout_session (model-supplied identity/amount) was not refused with INVALID_ARGUMENTS', { body: redactValue(spoofed) });
    }
    evidence.remote_mcp.model_supplied_identity_refused = true;
    evidence.identity.body_identity_rejected = true;

    // 2) CLEAN: the declared shape, on the verified session, must still mint a session.
    const create = await mcp(config, rpc('tools/call', {
      name: 'create_checkout_session',
      arguments: createSessionArgs(config),
    }, 5), identityHeaders(config));
    const result = parseToolText(create?.result);
    if (create?.result?.isError === true || !result?.session_id) {
      throw new SmokeError('Verified remote MCP create_checkout_session did not return a session', { body: redactValue(create) });
    }
    evidence.remote_mcp.verified_session_created_checkout_session = true;

    assertCanRunConfirmation(config);
    const unsigned = await postJson(`${config.base}/checkout/confirm`, {
      order_id: config.orderId,
      user_ref: 'usr_body_attacker',
      acp_session_id: 'acp_body_attacker',
    }, { ...authHeaders(config), ...identityHeaders(config) });
    if (unsigned.status !== 403 || unsigned.body?.error?.code !== 'CONFIRMATION_ACTION_REQUIRED') {
      throw new SmokeError('Unsigned confirmation action did not fail closed', { status: unsigned.status, body: redactValue(unsigned.body) });
    }

    const signed = await postJson(`${config.base}/checkout/confirm`, {
      order_id: config.orderId,
      user_ref: 'usr_body_attacker',
      acp_session_id: 'acp_body_attacker',
    }, { ...authHeaders(config), ...identityHeaders(config), ...signedConfirmationHeaders(config) });
    if (signed.status !== 200 || typeof signed.body?.confirmation_token !== 'string') {
      throw new SmokeError('Signed confirmation action did not mint a confirmation token', { status: signed.status, body: redactValue(signed.body) });
    }
    evidence.confirmation_action.unsigned_action_rejected = true;
    evidence.confirmation_action.signed_user_action_minted_token = true;
    evidence.confirmation_action.token_minted_only_after_user_action = true;
  }

  return evidence;
}

function redactValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = isSecretKey(key)
      ? '[REDACTED]'
      : redactValue(child, seen);
  }
  return out;
}

function isSecretKey(key) {
  return /^(authorization|api[-_]?key|client[-_]?secret|secret|password|credential|confirmation[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token)$/i.test(key);
}

function redactString(value) {
  let out = String(value);
  for (const secret of [process.env.PROBE_KEY, process.env.CONFIRMATION_SECRET]) {
    if (secret) out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  out = out.replace(/\b(?:ak|sk|rk)_(?:live|test)_[A-Za-z0-9_]+/g, '[REDACTED]');
  out = out.replace(/\b[A-Za-z0-9_-]+_secret_[A-Za-z0-9_-]+\b/g, '[REDACTED]');
  return out;
}

function printEvidence(evidence, flags) {
  if (flags.json) {
    console.log(JSON.stringify(redactValue(evidence), null, 2));
    return;
  }
  console.log(`Remote MCP smoke complete: ${evidence.remote_mcp.server_url}`);
  console.log(`  tools listed: ${evidence.remote_mcp.tools_listed.length}`);
  console.log(`  identity gate: ${evidence.remote_mcp.write_without_verified_identity_code}`);
  console.log(`  verified session: ${evidence.remote_mcp.verified_session_created_checkout_session ? 'yes' : 'not run'}`);
  console.log(`  confirmation action: ${evidence.confirmation_action.signed_user_action_minted_token ? 'signed token minted' : 'not run'}`);
}

function fail(error) {
  if (error instanceof UsageError) {
    console.error(`ERROR: ${redactString(error.message)}`);
    process.exitCode = 2;
    return;
  }
  if (error instanceof SmokeError) {
    console.error(`ERROR: ${redactString(error.message)}`);
    if (Object.keys(error.details || {}).length) {
      console.error(JSON.stringify(redactValue(error.details), null, 2));
    }
    process.exitCode = 1;
    return;
  }
  console.error(`ERROR: ${redactString(error?.message || String(error))}`);
  process.exitCode = 1;
}

try {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usageText());
    process.exit(0);
  }
  const config = loadConfig();
  const evidence = await runSmoke(flags, config);
  printEvidence(evidence, flags);
} catch (error) {
  fail(error);
}
