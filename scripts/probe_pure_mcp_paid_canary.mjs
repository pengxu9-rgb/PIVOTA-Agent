#!/usr/bin/env node
/*
 * Manual-only pure MCP paid canary.
 *
 * This script proves the agent-facing path can transact without direct REST invoke:
 * /mcp initialize -> tools/list -> create_checkout_session with a signed user JWT ->
 * complete_checkout_session with a signed payment grant.
 *
 * Safety:
 * - Without --charge it never calls complete_checkout_session.
 * - With --charge it requires explicit env acknowledgements.
 * - It prints redacted evidence only; JWTs/private keys/client secrets are never emitted.
 */

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

class ProbeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProbeError';
    this.details = details;
  }
}

let josePromise;

async function loadJose() {
  if (!josePromise) {
    josePromise = import('jose').catch(() => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const fallback = path.join(here, '..', 'safety-kernel', 'node_modules', 'jose', 'dist', 'webapi', 'index.js');
      return import(pathToFileURL(fallback).href);
    });
  }
  return josePromise;
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

function parseArgs(argv) {
  const flags = { json: false, charge: false, replay: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') flags.json = true;
    else if (arg === '--charge') flags.charge = true;
    else if (arg === '--replay') flags.replay = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else throw new UsageError(`Unknown flag: ${arg}`);
  }
  if (flags.replay && !flags.charge) throw new UsageError('--replay requires --charge');
  return flags;
}

function usageText() {
  return [
    'Usage: node scripts/probe_pure_mcp_paid_canary.mjs [--json] [--charge] [--replay]',
    '',
    'Required env for no-charge session probe:',
    '  PROBE_BASE, PROBE_KEY, PROBE_MERCHANT_ID, PROBE_PRODUCT_ID',
    '  MCP_IDENTITY_PRIVATE_JWK, MCP_IDENTITY_ISS, MCP_IDENTITY_AUD, MCP_IDENTITY_SUB',
    '  MCP_PAYMENT_PRIVATE_JWK, MCP_PAYMENT_ISS, MCP_PAYMENT_AUD',
    '',
    'Optional env:',
    '  PROBE_AUTH_HEADER, PROBE_VARIANT_ID, PROBE_CURRENCY, MCP_CANARY_RUN_ID',
    '  MCP_IDENTITY_KID, MCP_PAYMENT_KID, MCP_AGENT_SESSION_ID',
    '  PROBE_CUSTOMER_EMAIL, PROBE_SHIPPING_NAME, PROBE_SHIPPING_ADDRESS_LINE1',
    '  PROBE_SHIPPING_ADDRESS_LINE2, PROBE_SHIPPING_CITY, PROBE_SHIPPING_STATE',
    '  PROBE_SHIPPING_POSTAL_CODE, PROBE_SHIPPING_COUNTRY, PROBE_SHIPPING_PHONE',
    '',
    'Extra env required for --charge:',
    '  MCP_PAID_ALLOW_CHARGE=1',
    '  MCP_PAID_CHARGE_CONFIRM=yes',
    '  MCP_PAID_PSP_MODE=test|live',
    '  If live: MCP_PAID_LIVE_ACK=live-charge-approved',
    '',
    'Safety: --charge calls complete_checkout_session over MCP. No direct invoke is used.',
  ].join('\n');
}

function loadConfig(flags) {
  const runId = env('MCP_CANARY_RUN_ID') || `pure_mcp_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const pspMode = (env('MCP_PAID_PSP_MODE') || 'test').toLowerCase();
  const config = {
    runId,
    charge: flags.charge,
    replay: flags.replay,
    base: must('PROBE_BASE').replace(/\/+$/, ''),
    key: must('PROBE_KEY'),
    authHeader: env('PROBE_AUTH_HEADER') || 'Authorization',
    merchantId: must('PROBE_MERCHANT_ID'),
    productId: must('PROBE_PRODUCT_ID'),
    variantId: env('PROBE_VARIANT_ID'),
    currency: (env('PROBE_CURRENCY') || 'USD').toUpperCase(),
    identity: {
      privateJwk: parseJwkEnv('MCP_IDENTITY_PRIVATE_JWK'),
      iss: must('MCP_IDENTITY_ISS'),
      aud: must('MCP_IDENTITY_AUD'),
      sub: must('MCP_IDENTITY_SUB'),
      kid: env('MCP_IDENTITY_KID'),
      sessionId: env('MCP_AGENT_SESSION_ID') || `acp_${runId}`,
    },
    payment: {
      privateJwk: parseJwkEnv('MCP_PAYMENT_PRIVATE_JWK'),
      iss: must('MCP_PAYMENT_ISS'),
      aud: must('MCP_PAYMENT_AUD'),
      sub: env('MCP_PAYMENT_SUB'),
      kid: env('MCP_PAYMENT_KID'),
    },
    buyer: {
      customerEmail: env('PROBE_CUSTOMER_EMAIL'),
      shippingAddress: shippingAddressFromEnv(),
    },
    pspMode,
  };
  config.identity.userRef = deriveUserRef(config.identity.iss, config.identity.sub);

  if (flags.charge) {
    if (!boolEnv('MCP_PAID_ALLOW_CHARGE')) throw new UsageError('--charge requires MCP_PAID_ALLOW_CHARGE=1');
    if ((env('MCP_PAID_CHARGE_CONFIRM') || '').toLowerCase() !== 'yes') throw new UsageError('--charge requires MCP_PAID_CHARGE_CONFIRM=yes');
    if (!['test', 'live'].includes(pspMode)) throw new UsageError('MCP_PAID_PSP_MODE must be test or live');
    if (pspMode === 'live' && env('MCP_PAID_LIVE_ACK') !== 'live-charge-approved') {
      throw new UsageError('live --charge requires MCP_PAID_LIVE_ACK=live-charge-approved');
    }
    if (!config.buyer.customerEmail) throw new UsageError('--charge requires PROBE_CUSTOMER_EMAIL');
    const missing = requiredShippingFields(config.buyer.shippingAddress);
    if (missing.length) throw new UsageError(`--charge requires shipping fields: ${missing.join(', ')}`);
  }
  return config;
}

function shippingAddressFromEnv() {
  const shipping = {
    name: env('PROBE_SHIPPING_NAME'),
    recipient_name: env('PROBE_SHIPPING_NAME'),
    address_line1: env('PROBE_SHIPPING_ADDRESS_LINE1'),
    address_line2: env('PROBE_SHIPPING_ADDRESS_LINE2'),
    city: env('PROBE_SHIPPING_CITY'),
    state: env('PROBE_SHIPPING_STATE'),
    postal_code: env('PROBE_SHIPPING_POSTAL_CODE'),
    country: env('PROBE_SHIPPING_COUNTRY'),
    phone: env('PROBE_SHIPPING_PHONE'),
  };
  for (const key of Object.keys(shipping)) {
    if (shipping[key] === undefined) delete shipping[key];
  }
  return Object.keys(shipping).length ? shipping : undefined;
}

function requiredShippingFields(shipping) {
  const fields = ['name', 'address_line1', 'city', 'postal_code', 'country'];
  if (!shipping || typeof shipping !== 'object') return fields;
  return fields.filter((field) => !(typeof shipping[field] === 'string' && shipping[field].trim()));
}

function parseJwkEnv(name) {
  const raw = must(name);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.kty || !parsed.d) {
      throw new Error('not a private JWK');
    }
    return parsed;
  } catch (error) {
    throw new UsageError(`${name} must be a JSON private JWK (${error?.message || 'parse failed'})`);
  }
}

function authHeaders(config) {
  if (config.authHeader.toLowerCase() === 'authorization') {
    const value = /^(Bearer|ApiKey|Basic)\s+/i.test(config.key) ? config.key : `Bearer ${config.key}`;
    return { Authorization: value };
  }
  return { [config.authHeader]: config.key };
}

async function signUserJwt(config) {
  const { importJWK, SignJWT } = await loadJose();
  const key = await importJWK(config.identity.privateJwk, config.identity.privateJwk.alg || 'ES256');
  const header = {
    alg: config.identity.privateJwk.alg || 'ES256',
    ...(config.identity.kid || config.identity.privateJwk.kid ? { kid: config.identity.kid || config.identity.privateJwk.kid } : {}),
  };
  return new SignJWT({ acp_session_id: config.identity.sessionId })
    .setProtectedHeader(header)
    .setIssuer(config.identity.iss)
    .setAudience(config.identity.aud)
    .setSubject(config.identity.sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key);
}

async function signPaymentGrant(config, session, amountMinor) {
  const { importJWK, SignJWT } = await loadJose();
  const key = await importJWK(config.payment.privateJwk, config.payment.privateJwk.alg || 'ES256');
  const header = {
    alg: config.payment.privateJwk.alg || 'ES256',
    ...(config.payment.kid || config.payment.privateJwk.kid ? { kid: config.payment.kid || config.payment.privateJwk.kid } : {}),
  };
  const jwt = new SignJWT({
    allowance: {
      max_amount: amountMinor,
      currency: session.currency || config.currency,
      merchant_id: config.merchantId,
      checkout_session_id: session.session_id,
      user_ref: config.identity.userRef,
    },
  })
    .setProtectedHeader(header)
    .setIssuer(config.payment.iss)
    .setAudience(config.payment.aud)
    .setIssuedAt()
    .setExpirationTime('10m')
    .setJti(`grant_${config.runId}`);
  if (config.payment.sub) jwt.setSubject(config.payment.sub);
  return jwt.sign(key);
}

function deriveUserRef(iss, sub) {
  const digest = createHash('sha256').update(`${iss}|${sub}`, 'utf8').digest('base64url').slice(0, 32);
  return `usr_${digest}`;
}

function rpc(method, params = {}, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

async function postJson(url, body, headers = {}, meta = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).catch((error) => {
    throw new ProbeError('network_error', {
      url,
      ...meta,
      message: redact(error?.message || String(error)),
      cause: redact(error?.cause?.message || error?.cause?.code || ''),
    });
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new ProbeError('non_json_response', { url, status: response.status, ...meta, body: redact(text) });
  }
  return { status: response.status, body: parsed };
}

async function mcp(config, body, extraHeaders = {}, meta = {}) {
  const requestMeta = {
    step: meta.step || body?.method || 'mcp',
    method: body?.method || null,
    tool: body?.params?.name || null,
  };
  const out = await postJson(`${config.base}/mcp`, body, { ...authHeaders(config), ...extraHeaders }, requestMeta);
  if (out.status < 200 || out.status >= 300) {
    throw new ProbeError('mcp_http_error', { status: out.status, ...requestMeta, body: redactValue(out.body) });
  }
  return out.body;
}

function parseToolResult(body, toolName) {
  const result = body?.result;
  if (result?.isError === true) {
    throw new ProbeError(`${toolName}_tool_error`, { result: redactValue(result) });
  }
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function amountMinorFromSession(session) {
  const total = session?.totals?.total ?? session?.total ?? session?.amount_total;
  if (Number.isSafeInteger(total) && total > 0) return total;
  if (typeof total === 'string' && /^\d+$/.test(total)) return Number(total);
  throw new ProbeError('session_total_missing', { session: redactValue(session) });
}

function createSessionArgs(config) {
  const quote = {
    merchant_id: config.merchantId,
    currency: config.currency,
    items: [{
      product_id: config.productId,
      ...(config.variantId ? { variant_id: config.variantId } : {}),
      quantity: 1,
    }],
  };
  if (config.buyer.customerEmail) quote.customer_email = config.buyer.customerEmail;
  if (config.buyer.shippingAddress) quote.shipping_address = config.buyer.shippingAddress;
  return {
    idempotency_key: `idem_mcp_create_${config.runId}`,
    quote,
  };
}

async function run(flags) {
  const config = loadConfig(flags);
  const userJwt = await signUserJwt(config);
  const identityHeader = { 'X-Agent-User-JWT': `Bearer ${userJwt}` };
  const evidence = {
    run_id: config.runId,
    mode: config.charge ? 'charge' : 'no_charge',
    psp_mode: config.pspMode,
    mcp_url: `${config.base}/mcp`,
    merchant_id: config.merchantId,
    product_id: config.productId,
    variant_id: config.variantId || null,
    identity_jwt_present: true,
    payment_grant_present: false,
    buyer_context_present: Boolean(config.buyer.customerEmail && config.buyer.shippingAddress),
    complete_checkout_session_called: false,
    replay_called: false,
  };

  const init = await mcp(config, rpc('initialize', {}, 1), {}, { step: 'initialize' });
  evidence.initialize_ok = init?.result?.protocolVersion != null || init?.result != null;

  const tools = await mcp(config, rpc('tools/list', {}, 2), {}, { step: 'tools_list' });
  evidence.tools_listed = (tools?.result?.tools || []).map((t) => t.name).sort();

  const createBody = await mcp(config, rpc('tools/call', {
    name: 'create_checkout_session',
    arguments: createSessionArgs(config),
  }, 3), identityHeader, { step: 'create_checkout_session' });
  const session = parseToolResult(createBody, 'create_checkout_session');
  const amountMinor = amountMinorFromSession(session);
  evidence.session = {
    session_id: session.session_id,
    currency: session.currency,
    amount_minor: amountMinor,
    expires_at: session.expires_at || null,
  };

  const grant = await signPaymentGrant(config, session, amountMinor);
  evidence.payment_grant_present = true;

  if (!config.charge) return evidence;

  const completeArgs = {
    session_id: session.session_id,
    idempotency_key: `idem_mcp_pay_${config.runId}`,
    payment_authorization: {
      method: 'acp_delegated_token',
      token: grant,
    },
  };
  if (config.buyer.shippingAddress) completeArgs.shipping_address = config.buyer.shippingAddress;
  const completeBody = await mcp(config, rpc('tools/call', {
    name: 'complete_checkout_session',
    arguments: completeArgs,
  }, 4), identityHeader, { step: 'complete_checkout_session' });
  evidence.complete_checkout_session_called = true;
  evidence.complete = summarizeComplete(parseToolResult(completeBody, 'complete_checkout_session'));

  if (config.replay) {
    const replayBody = await mcp(config, rpc('tools/call', {
      name: 'complete_checkout_session',
      arguments: completeArgs,
    }, 5), identityHeader, { step: 'complete_checkout_session_replay' });
    evidence.replay_called = true;
    evidence.replay = summarizeComplete(parseToolResult(replayBody, 'complete_checkout_session'));
    evidence.replay_same_payment_reference = evidence.replay.payment_reference === evidence.complete.payment_reference;
  }
  return evidence;
}

function summarizeComplete(out) {
  return {
    order_id: out?.order?.order_id || out?.order_id || null,
    order_status: out?.order?.status || out?.payment?.order_status || null,
    amount_minor: out?.order?.amount_total ?? null,
    currency: out?.order?.currency || out?.payment?.currency || null,
    payment_status: out?.payment?.payment_status || out?.payment_status || null,
    payment_reference: maskReference(out?.payment?.payment_id || out?.payment_id || out?.payment?.payment_reference || null),
    requires_action: Boolean(out?.payment?.redirect_url || out?.payment?.qr_code || out?.payment?.instructions),
  };
}

function maskReference(value) {
  if (typeof value !== 'string' || value.length <= 12) return value || null;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function redactValue(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (/token|secret|authorization|jwt|jwk|key/i.test(key)) out[key] = '[REDACTED]';
    else out[key] = redactValue(inner);
  }
  return out;
}

function redact(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g, '[REDACTED_JWT]')
    .replace(/sk_(?:live|test|restricted)_[A-Za-z0-9_]+/g, '[REDACTED_STRIPE_KEY]')
    .replace(/client_secret=[^&\s"]+/gi, 'client_secret=[REDACTED]');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usageText());
    return;
  }
  const evidence = await run(flags);
  if (flags.json) {
    console.log(JSON.stringify(redactValue(evidence), null, 2));
    return;
  }
  console.log(`Pure MCP canary ${evidence.mode} complete: ${evidence.mcp_url}`);
  console.log(`  session: ${evidence.session?.session_id || 'n/a'} ${evidence.session?.amount_minor || 'n/a'} ${evidence.session?.currency || ''}`);
  console.log(`  complete called: ${evidence.complete_checkout_session_called ? 'yes' : 'no'}`);
  if (evidence.complete) console.log(`  payment: ${evidence.complete.payment_status || evidence.complete.order_status || 'unknown'} ${evidence.complete.payment_reference || ''}`);
  if (evidence.replay_called) console.log(`  replay same reference: ${evidence.replay_same_payment_reference ? 'yes' : 'no'}`);
}

main().catch((error) => {
  const payload = {
    error: error?.name || 'Error',
    message: error?.message || String(error),
    details: redactValue(error?.details || {}),
  };
  if (process.argv.includes('--json')) console.error(JSON.stringify(payload, null, 2));
  else {
    console.error(`${payload.error}: ${payload.message}`);
    if (Object.keys(payload.details).length) console.error(JSON.stringify(payload.details, null, 2));
  }
  process.exit(1);
});
