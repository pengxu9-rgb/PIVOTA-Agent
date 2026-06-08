#!/usr/bin/env node
/*
 * Validate deployed platform smoke evidence for agent-facing integrations.
 *
 * This does not call ChatGPT, Claude, Gemini, or the gateway. It validates the
 * operator evidence from the deployed remote MCP + confirmation UI smoke:
 * - MCP server reachable and lists the safe commerce tools
 * - write tools fail closed without verified identity
 * - verified OAuth/session identity is used, model/body identity is ignored
 * - confirmation token is minted only through signed user action
 * - no payment completion or submit_payment was attempted
 */

import { readFileSync } from 'node:fs';

const REQUIRED_MCP_TOOLS = [
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

class EvidenceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EvidenceError';
    this.details = details;
  }
}

function parseArgs(argv) {
  const flags = { json: false, input: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--input') {
      i += 1;
      flags.input = argv[i];
    } else if (!flags.input && !arg.startsWith('--')) {
      flags.input = arg;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usageText());
      process.exit(0);
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  if (!flags.input) {
    throw new UsageError('Missing evidence file. Usage: node scripts/validate_platform_smoke_evidence.mjs --input evidence.json');
  }
  return flags;
}

function usageText() {
  return [
    'Usage: node scripts/validate_platform_smoke_evidence.mjs --input evidence.json [--json]',
    '',
    'Required evidence:',
    '- operator.approver',
    '- environment gateway deployment id/full sha',
    '- remote_mcp HTTPS /mcp URL, initialize/list-tools success, required tools listed',
    '- write without verified identity fails USER_AUTH_REQUIRED',
    '- verified session creates checkout session and ignores model/body identity',
    '- confirmation route rejects unsigned action and mints token only from signed user action',
    '- no complete_checkout_session, submit_payment, or paid operation attempted',
    '- redaction scan and credential hygiene proof',
  ].join('\n');
}

function readEvidence(path) {
  const raw = readFileSync(path, 'utf8');
  const sensitiveHits = scanSensitive(raw);
  if (sensitiveHits.length) {
    throw new EvidenceError('Evidence file contains sensitive-looking values', { sensitive_hits: sensitiveHits });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new EvidenceError('Evidence file is not valid JSON', { parse_error: error?.message || String(error) });
  }
}

function scanSensitive(raw) {
  const hits = [];
  const patterns = [
    { type: 'bearer_token', regex: /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
    { type: 'api_key', regex: /\b(?:ak|sk|rk)_(?:live|test)_[A-Za-z0-9_]+\b/g },
    { type: 'client_secret', regex: /\b[A-Za-z0-9_-]+_secret_[A-Za-z0-9_-]+\b/g },
    { type: 'jwt', regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern.regex)) {
      hits.push({ type: pattern.type, sample: redactSample(match[0]) });
      if (hits.length >= 10) return hits;
    }
  }
  return hits;
}

function redactSample(value) {
  const text = String(value);
  if (text.length <= 8) return '[REDACTED]';
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function requireString(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new EvidenceError(`Missing required string: ${path}`);
  }
  return value.trim();
}

function requireBoolTrue(value, path) {
  if (value !== true) {
    throw new EvidenceError(`Expected ${path}=true`);
  }
}

function requireBoolFalse(value, path) {
  if (value !== false) {
    throw new EvidenceError(`Expected ${path}=false`);
  }
}

function validateTools(tools) {
  if (!Array.isArray(tools)) {
    throw new EvidenceError('remote_mcp.tools_listed must be an array');
  }
  const set = new Set(tools.map((tool) => String(tool)));
  const missing = REQUIRED_MCP_TOOLS.filter((tool) => !set.has(tool));
  if (missing.length) {
    throw new EvidenceError('Remote MCP tool list is missing required commerce tools', { missing });
  }
  return Array.from(set).sort();
}

function validateUrl(value, path, requiredSuffix) {
  const url = requireString(value, path);
  if (!url.startsWith('https://')) {
    throw new EvidenceError(`${path} must be HTTPS`);
  }
  if (requiredSuffix && !url.replace(/\/+$/, '').endsWith(requiredSuffix)) {
    throw new EvidenceError(`${path} must end with ${requiredSuffix}`);
  }
  return url;
}

function validateEvidence(evidence) {
  const checks = [];

  requireString(evidence.operator?.approver, 'operator.approver');
  requireString(evidence.environment?.gateway_full_sha, 'environment.gateway_full_sha');
  requireString(evidence.environment?.gateway_deployment_id, 'environment.gateway_deployment_id');
  checks.push('operator_environment');

  const mcpUrl = validateUrl(evidence.remote_mcp?.server_url, 'remote_mcp.server_url', '/mcp');
  requireBoolTrue(evidence.remote_mcp?.initialize_ok, 'remote_mcp.initialize_ok');
  const tools = validateTools(evidence.remote_mcp?.tools_listed);
  requireBoolTrue(evidence.remote_mcp?.write_without_verified_identity_failed, 'remote_mcp.write_without_verified_identity_failed');
  if (evidence.remote_mcp?.write_without_verified_identity_code !== 'USER_AUTH_REQUIRED') {
    throw new EvidenceError('remote_mcp.write_without_verified_identity_code must be USER_AUTH_REQUIRED');
  }
  requireBoolTrue(evidence.remote_mcp?.verified_session_created_checkout_session, 'remote_mcp.verified_session_created_checkout_session');
  requireBoolTrue(evidence.remote_mcp?.model_supplied_identity_ignored, 'remote_mcp.model_supplied_identity_ignored');
  checks.push('remote_mcp');

  requireString(evidence.identity?.user_ref_source, 'identity.user_ref_source');
  requireString(evidence.identity?.acp_session_id_source, 'identity.acp_session_id_source');
  requireBoolTrue(evidence.identity?.body_identity_rejected, 'identity.body_identity_rejected');
  checks.push('identity');

  const confirmationUrl = validateUrl(evidence.confirmation_action?.route, 'confirmation_action.route', '/checkout/confirm');
  requireBoolTrue(evidence.confirmation_action?.unsigned_action_rejected, 'confirmation_action.unsigned_action_rejected');
  requireBoolTrue(evidence.confirmation_action?.signed_user_action_minted_token, 'confirmation_action.signed_user_action_minted_token');
  requireBoolTrue(evidence.confirmation_action?.token_minted_only_after_user_action, 'confirmation_action.token_minted_only_after_user_action');
  requireBoolTrue(evidence.confirmation_action?.token_not_exposed_to_model_tool, 'confirmation_action.token_not_exposed_to_model_tool');
  checks.push('confirmation_action');

  requireBoolFalse(evidence.no_money_ops?.complete_checkout_session_called, 'no_money_ops.complete_checkout_session_called');
  requireBoolFalse(evidence.no_money_ops?.submit_payment_called, 'no_money_ops.submit_payment_called');
  requireBoolFalse(evidence.no_money_ops?.paid_charge_attempted, 'no_money_ops.paid_charge_attempted');
  checks.push('no_money_ops');

  requireBoolTrue(evidence.redaction?.scan_passed, 'redaction.scan_passed');
  if (evidence.credential_hygiene?.rotation_needed === true) {
    requireBoolTrue(evidence.credential_hygiene?.rotation_completed, 'credential_hygiene.rotation_completed');
  } else {
    requireBoolFalse(evidence.credential_hygiene?.rotation_needed, 'credential_hygiene.rotation_needed');
  }
  checks.push('hygiene');

  return {
    ok: true,
    mcp_url: mcpUrl,
    confirmation_url: confirmationUrl,
    tools_checked: tools,
    checks,
  };
}

function printResult(result, flags) {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Platform smoke evidence PASS mcp=${result.mcp_url}`);
  console.log(`Checks: ${result.checks.join(', ')}`);
}

function fail(error) {
  if (error instanceof UsageError) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (error instanceof EvidenceError) {
    console.error(`ERROR: ${error.message}`);
    if (Object.keys(error.details || {}).length) {
      console.error(JSON.stringify(error.details, null, 2));
    }
    process.exitCode = 1;
    return;
  }
  console.error(`ERROR: ${error?.message || String(error)}`);
  process.exitCode = 1;
}

try {
  const flags = parseArgs(process.argv.slice(2));
  printResult(validateEvidence(readEvidence(flags.input)), flags);
} catch (error) {
  fail(error);
}
