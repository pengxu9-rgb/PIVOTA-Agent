const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const repoRoot = path.join(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'validate_paid_canary_evidence.mjs');

function validEvidence(overrides = {}) {
  return mergeDeep({
    operator: {
      approver: 'ops@example.com',
    },
    environment: {
      psp_mode: 'test',
      gateway_full_sha: '429079c206866a5be3ab6d8d9462b24a9ae581e9',
      gateway_deployment_id: '4c539441-62f3-433c-9ab9-cf92669a8057',
      backend_full_sha: '3bdf59d861d6026771209156684aaf86db2fa37a',
      backend_deployment_id: 'backend-deploy-1',
    },
    strict_canary: {
      preview_quote: {
        quote_id: 'q_test_1',
      },
      create_order: {
        order_id: 'ord_test_1',
        amount_minor: 2824,
        currency: 'USD',
      },
      submit_payment: {
        payment_reference: 'pi_test_redacted',
        idempotency_key: 'idem_pay_1',
        payment_status: 'requires_action',
      },
      submit_payment_replay: {
        payment_reference: 'pi_test_redacted',
        payment_status: 'requires_action',
      },
    },
    psp_dashboard: {
      provider: 'stripe',
      livemode: false,
      payment_reference: 'pi_test_redacted',
      amount_minor: 2824,
      currency: 'USD',
      status: 'succeeded',
    },
    replay: {
      same_idempotency_key: true,
      returned_original_result: true,
      extra_charge_created: false,
    },
    webhook_status: {
      signed_webhook_observed: true,
      event: 'payment_intent.succeeded',
      signature_header: 'Stripe-Signature',
      correlation_field: 'metadata.order_id',
      canonical_payment_status: 'paid',
    },
    refund: {
      refund_cap_enforced: true,
      refund_replay_idempotent: true,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-canary-evidence-'));
  const file = path.join(dir, 'evidence.json');
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

async function runEvidence(body, args = []) {
  const file = writeEvidence(body);
  return execFileAsync('node', [scriptPath, '--input', file, '--json', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('paid canary evidence validator', () => {
  test('accepts a complete Stripe test-mode evidence packet', async () => {
    const { stdout } = await runEvidence(validEvidence());
    const result = JSON.parse(stdout);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      mode: 'test',
      order_id: 'ord_test_1',
      amount_minor: 2824,
      currency: 'USD',
    }));
    expect(result.checks).toEqual(expect.arrayContaining([
      'environment',
      'strict_pay_replay',
      'psp_dashboard',
      'idempotency_replay',
      'webhook_status',
      'refund',
      'hygiene',
    ]));
  });

  test('refuses live evidence unless the live-refund override is explicit', async () => {
    await expect(runEvidence(validEvidence({
      environment: { psp_mode: 'live' },
      psp_dashboard: { livemode: true },
      live_refund: {
        refunded: true,
        refund_reference: 're_test_redacted',
        approved_by: 'ops@example.com',
      },
    }))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Live PSP evidence is refused'),
    });
  });

  test('rejects PSP amount/currency drift from the locked order amount', async () => {
    await expect(runEvidence(validEvidence({
      psp_dashboard: { amount_minor: 2825 },
    }))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('PSP dashboard amount/currency does not match locked order amount'),
    });
  });

  test('rejects replay evidence that could hide a double charge', async () => {
    await expect(runEvidence(validEvidence({
      replay: { extra_charge_created: true },
    }))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('replay.extra_charge_created=false'),
    });
  });

  test('rejects raw PSP secrets in the evidence file before parsing gate fields', async () => {
    await expect(runEvidence(validEvidence({
      notes: 'operator accidentally pasted sk_test_abcdefghijklmnopqrstuvwxyz',
    }))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Evidence file contains sensitive-looking values'),
    });
  });
});
