const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const repoRoot = path.join(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'probe_strict_checkout_canary.mjs');

function baseEnv(extra = {}) {
  return {
    ...process.env,
    PROBE_BASE: 'https://gateway.example',
    PROBE_KEY: 'ak_live_test_probe_key',
    PROBE_MERCHANT_ID: 'merch_test',
    PROBE_PRODUCT_ID: 'prod_test',
    PROBE_VARIANT_ID: 'variant_test',
    STRICT_CANARY_USER_REF: 'usr_test',
    STRICT_CANARY_ACP_SESSION_ID: 'acp_test',
    ...extra,
  };
}

describe('strict checkout canary script', () => {
  test('dry-run emits strict-safe quote/order/pay bodies without a model-minted confirmation', async () => {
    const { stdout } = await execFileAsync(
      'node',
      [scriptPath, '--dry-run', '--create-order', '--charge', '--json'],
      { cwd: repoRoot, env: baseEnv(), encoding: 'utf8' },
    );

    const body = JSON.parse(stdout);
    expect(body.mode).toBe('dry_run');
    expect(body.attempted).toEqual({
      preview_quote: true,
      create_order: true,
      submit_payment: true,
      submit_payment_replay: true,
    });

    const createPayload = body.requests.create_order.payload;
    expect(createPayload.idempotency_key).toMatch(/^idem_create_/);
    expect(createPayload.order.quote_id).toBe('__QUOTE_ID__');
    expect(createPayload.order.shipping_address).toEqual(
      expect.objectContaining({
        recipient_name: 'Strict Canary',
        address_line1: '1 Market St',
        postal_code: '94105',
        country: 'US',
      }),
    );
    expect(createPayload.order).not.toHaveProperty('items');
    expect(createPayload.order).not.toHaveProperty('amount');
    expect(createPayload.order).not.toHaveProperty('total_amount');

    const payPayload = body.requests.submit_payment.payload;
    expect(payPayload.idempotency_key).toMatch(/^idem_pay_/);
    expect(payPayload.confirmation_token).toBe('[REDACTED]');
    expect(payPayload.payment).toEqual(
      expect.objectContaining({
        order_id: '__ORDER_ID__',
        expected_amount: 1,
        currency: 'USD',
        payment_method_hint: 'card',
      }),
    );
    expect(payPayload.payment).not.toHaveProperty('quote_id');
    expect(payPayload.payment).not.toHaveProperty('amount');
    expect(payPayload.payment).not.toHaveProperty('total_amount');
    expect(body.host_only_confirmation).toContain('in-process');
  });

  test('refuses create_order writes without the explicit create canary acknowledgment', async () => {
    await expect(
      execFileAsync(
        'node',
        [scriptPath, '--create-order'],
        { cwd: repoRoot, env: baseEnv(), encoding: 'utf8' },
      ),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('STRICT_CANARY_ALLOW_CREATE_ORDER=1'),
    });
  });

  test('refuses charge unless the operator declares test PSP mode', async () => {
    await expect(
      execFileAsync(
        'node',
        [scriptPath, '--create-order', '--charge'],
        {
          cwd: repoRoot,
          env: baseEnv({
            STRICT_CANARY_ALLOW_CREATE_ORDER: '1',
            STRICT_CANARY_ALLOW_CHARGE: '1',
            STRICT_CANARY_CHARGE_CONFIRM: 'yes',
            STRICT_CANARY_REMOTE_PAY_ENABLED_ACK: '1',
            DATABASE_URL: 'postgres://example.invalid/db',
            CONFIRMATION_SECRET: 'strict-confirmation-secret-0123456789',
          }),
          encoding: 'utf8',
        },
      ),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('STRICT_CANARY_PSP_MODE=test'),
    });
  });
});
