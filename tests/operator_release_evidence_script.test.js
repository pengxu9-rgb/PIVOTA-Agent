const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const repoRoot = path.join(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'validate_operator_release_evidence.mjs');

function validEvidence(overrides = {}) {
  return mergeDeep({
    operator: {
      approver: 'ops-redacted',
    },
    production_pay_authorized: false,
    environment: {
      gateway_full_sha: '2bea62395fff745514c4effa8e4faf998179f327',
      gateway_deployment_id: 'd893f24a-5041-4c14-a96e-a305352f8a7f',
      backend_full_sha: '694e883c50b523502b6cb0f36c353bd5b17a0bda',
      backend_deployment_id: 'backend-deploy-redacted',
    },
    production_flags: {
      AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED: '0',
      AGENT_CHECKOUT_ALLOW_TEST_IDENTITY: '0',
      AGENT_CHECKOUT_TEST_IDENTITY_WINDOW: '0',
    },
    gateway_gate: {
      clean_worktree: true,
      release_source_sha: '2bea62395fff745514c4effa8e4faf998179f327',
      rollout_guard_passed: true,
      money_path_local_passed: true,
    },
    backend_gate: {
      clean_worktree: true,
      release_source_sha: '694e883c50b523502b6cb0f36c353bd5b17a0bda',
      commands: [
        'pytest -q tests/test_agent_external_platform_checkout.py tests/test_stripe_webhook_contract.py tests/test_adyen_webhook_contract.py tests/test_checkout_webhook_contract.py tests/test_stripe_idempotency_keys.py',
        'PIVOTA_BACKEND_REPO="$PWD" bash scripts/run_payment_aftercare_gate.sh',
      ],
      checkout_payment_safety: {
        passed: true,
        pass_count: 147,
      },
      payment_aftercare: {
        passed: true,
        pass_count: 76,
      },
    },
    github_actions: {
      used_as_release_gate: false,
      billing_blocked: true,
      blocked_run_id: '27122065333',
    },
    no_money_ops: {
      submit_payment_enabled: false,
      paid_charge_attempted: false,
    },
    redaction: {
      scan_passed: true,
    },
    credential_hygiene: {
      rotation_needed: false,
    },
  }, overrides);
}

function mergeDeep(base, overrides) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = mergeDeep(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function writeEvidence(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-release-evidence-'));
  const file = path.join(dir, 'evidence.json');
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

async function runEvidence(body) {
  const file = writeEvidence(body);
  return execFileAsync('node', [scriptPath, '--input', file, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('operator release evidence validator', () => {
  test('accepts a complete no-cost local release-gate packet', async () => {
    const { stdout } = await runEvidence(validEvidence());
    const result = JSON.parse(stdout);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      gateway_sha: '2bea62395fff745514c4effa8e4faf998179f327',
      backend_sha: '694e883c50b523502b6cb0f36c353bd5b17a0bda',
      checkout_payment_safety_pass_count: 147,
      payment_aftercare_pass_count: 76,
    }));
    expect(result.checks).toEqual(expect.arrayContaining([
      'gateway_local_gate',
      'backend_local_gate',
      'github_actions_bypass',
      'no_money_ops',
    ]));
  });

  test('rejects evidence that authorizes production pay', async () => {
    await expect(runEvidence(validEvidence({
      production_pay_authorized: true,
    }))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('production_pay_authorized=false'),
    });
  });

  test('rejects missing aftercare command', async () => {
    await expect(runEvidence(validEvidence({
      backend_gate: {
        commands: [
          'pytest -q tests/test_agent_external_platform_checkout.py tests/test_stripe_webhook_contract.py',
          'echo aftercare omitted',
        ],
      },
    }))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('run_payment_aftercare_gate.sh'),
    });
  });

  test('rejects dirty backend release worktree evidence', async () => {
    await expect(runEvidence(validEvidence({
      backend_gate: {
        clean_worktree: false,
      },
    }))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('backend_gate.clean_worktree=true'),
    });
  });

  test('rejects sensitive values in operator evidence', async () => {
    await expect(runEvidence(validEvidence({
      notes: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    }))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Evidence file contains sensitive-looking values'),
    });
  });
});
