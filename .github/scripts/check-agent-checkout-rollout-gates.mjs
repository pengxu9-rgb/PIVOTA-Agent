#!/usr/bin/env node
// CI/docs guard for agent-checkout rollout safety. This intentionally checks only workflow/docs
// artifacts: it must not depend on runtime code to prove the rollout gates are present.
import { readFileSync } from 'node:fs';

const REQUIRED_MONEY_PATH_JOBS = [
  'safety-kernel',
  'mcp-adapters',
  'merchant-connectors',
  'gateway-strict-route',
  'test-count-floor',
  'rollout-observability-gates',
];

const REQUIRED_DOC_MARKERS = [
  '## Required Gates',
  'No automated paid charge',
  'Strict create-order canary',
  'Remote MCP and confirmation UI smoke',
  'Observability export',
  'Manual Paid-Canary Evidence',
  'B4 status verifier',
  'Rollback',
  'checkout-payment-safety',
];

function read(path) {
  return readFileSync(path, 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertJobExists(workflowText, jobName) {
  const pattern = new RegExp(`^  ${jobName}:`, 'm');
  assert(pattern.test(workflowText), `Missing workflow job: ${jobName}`);
}

function assertNoAutomatedChargeProbe(probeWorkflowText) {
  const forbidden = [
    /^      charge:/m,
    /\$\{\{\s*inputs\.charge\b/,
    /PROBE_ALLOW_CHARGE:/,
    /PROBE_CHARGE_CONFIRM:/,
    /STRICT_CANARY_ALLOW_CHARGE:/,
    /STRICT_CANARY_CHARGE_CONFIRM:/,
    /STRICT_CANARY_REMOTE_PAY_ENABLED_ACK:/,
    /STRICT_CANARY_PSP_MODE:/,
    /STRIPE_SECRET_KEY/,
    /b4_complete_charge\.mjs/,
    /FLAGS="--charge \$FLAGS"/,
    /probe_strict_checkout_canary\.mjs --create-order --charge/,
  ];
  for (const pattern of forbidden) {
    assert(!pattern.test(probeWorkflowText), `Wire-format probe still has automated charge hook: ${pattern}`);
  }
  assert(/workflow_dispatch:/.test(probeWorkflowText), 'Wire-format probe must stay workflow_dispatch-only');
  assert(!/pull_request:|push:|schedule:/.test(probeWorkflowText), 'Wire-format probe must not run on pull_request, push, or schedule');
}

function assertNoAutomatedChargeWiring(...workflowTexts) {
  const joined = workflowTexts
    .join('\n---workflow---\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const forbidden = [
    /STRIPE_SECRET_KEY/,
    /b4_complete_charge\.mjs/,
    /PROBE_ALLOW_CHARGE:/,
    /STRICT_CANARY_ALLOW_CHARGE:/,
    /STRICT_CANARY_CHARGE_CONFIRM:/,
    /STRICT_CANARY_REMOTE_PAY_ENABLED_ACK:/,
    /node\s+scripts\/(?:probe_wire_format|probe_strict_checkout_canary)\.mjs[^\n]*--charge\b/,
    /FLAGS=.*--charge\b/,
  ];
  for (const pattern of forbidden) {
    assert(!pattern.test(joined), `Workflow must not contain automated charge wiring: ${pattern}`);
  }
}

function main() {
  const moneyPathWorkflow = read('.github/workflows/agent-checkout-money-path-gate.yml');
  const probeWorkflow = read('.github/workflows/agent-checkout-wire-format-probe.yml');
  const platformSmokeWorkflow = read('.github/workflows/agent-checkout-platform-smoke.yml');
  const rolloutDoc = read('docs/agent-checkout/ROLLOUT_OBSERVABILITY_GATES.md');

  for (const jobName of REQUIRED_MONEY_PATH_JOBS) {
    assertJobExists(moneyPathWorkflow, jobName);
  }

  assert(/needs:\s*\[[^\]]*safety-kernel[^\]]*mcp-adapters[^\]]*merchant-connectors[^\]]*\]/m.test(moneyPathWorkflow),
    'test-count-floor must depend on the split money-path suite jobs');
  assert(/\.github\/scripts\/assert-money-path-test-floors\.mjs --report-dir/.test(moneyPathWorkflow),
    'test-count-floor must read reports from prior jobs');
  assert(/checkout-payment-safety/.test(rolloutDoc),
    'rollout doc must mention the backend checkout-payment-safety lane');
  assert(/validate_paid_canary_evidence\.mjs/.test(rolloutDoc),
    'rollout doc must point manual paid evidence at the validator script');
  assert(/validate_platform_smoke_evidence\.mjs/.test(rolloutDoc),
    'rollout doc must point platform smoke evidence at the validator script');
  assert(/smoke_protocol_edge_remote_mcp\.mjs/.test(rolloutDoc),
    'rollout doc must point platform smoke evidence at the remote MCP smoke script');
  assert(/tests\/paid_canary_evidence_script\.test\.js/.test(moneyPathWorkflow),
    'Gateway strict-route workflow must run the paid-canary evidence validator test');
  assert(/tests\/b4_verify_script\.test\.js/.test(moneyPathWorkflow),
    'Gateway strict-route workflow must run the status-only B4 verifier test');
  assert(/tests\/platform_smoke_evidence_script\.test\.js/.test(moneyPathWorkflow),
    'Gateway strict-route workflow must run the platform smoke evidence validator test');
  assert(/tests\/remote_mcp_smoke_script\.test\.js/.test(moneyPathWorkflow),
    'Gateway strict-route workflow must run the remote MCP smoke script test');
  assert(/tests\/integration\/safety_kernel_mount\.node\.test\.cjs/.test(moneyPathWorkflow),
    'Gateway strict-route workflow must run the strict Safety Kernel mount test');
  assert(/smoke_protocol_edge_remote_mcp\.mjs/.test(platformSmokeWorkflow),
    'Platform smoke workflow must run the remote MCP smoke script');
  assert(/validate_platform_smoke_evidence\.mjs/.test(platformSmokeWorkflow),
    'Platform smoke workflow must validate the platform smoke evidence packet');

  assertNoAutomatedChargeProbe(probeWorkflow);
  assertNoAutomatedChargeWiring(moneyPathWorkflow, probeWorkflow, platformSmokeWorkflow);
  assertJobExists(probeWorkflow, 'strict-create-order-canary');
  assert(/run_strict_create_order_canary:/.test(probeWorkflow),
    'Wire-format probe workflow must expose the strict create-order canary input');
  assert(/probe_strict_checkout_canary\.mjs --create-order --json/.test(probeWorkflow),
    'Strict create-order canary job must run the strict canary script without --charge');
  assert(/PROBE_QUERY:\s*\$\{\{\s*inputs\.query\s*\}\}/.test(probeWorkflow),
    'Strict create-order canary job must pass PROBE_QUERY so it can auto-select when pins are absent');
  assert(/auto-select from find_products/.test(probeWorkflow),
    'Strict create-order canary workflow must document product auto-selection in preflight');
  assert(!/requires product_id and merchant_id inputs/.test(probeWorkflow),
    'Strict create-order canary workflow must not fail closed solely because product pins are absent');

  for (const marker of REQUIRED_DOC_MARKERS) {
    assert(rolloutDoc.includes(marker), `Missing rollout doc marker: ${marker}`);
  }

  console.log('ok agent-checkout rollout/observability gates are documented and CI-addressable');
}

try {
  main();
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
