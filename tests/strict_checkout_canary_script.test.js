const path = require('path');
const http = require('http');
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

function baseEnvWithoutPins(extra = {}) {
  const out = baseEnv(extra);
  delete out.PROBE_MERCHANT_ID;
  delete out.PROBE_PRODUCT_ID;
  delete out.PROBE_VARIANT_ID;
  return out;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
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

  test('auto-discovers a product and retries stale quote candidates before create_order', async () => {
    const requests = [];
    const { server, baseUrl } = await listen(async (req, res) => {
      try {
        const body = await readJson(req);
        requests.push(body);
        res.setHeader('Content-Type', 'application/json');

        if (req.url !== '/agent/shop/v1/invoke') {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
          return;
        }

        if (body.operation === 'find_products') {
          res.end(JSON.stringify({
            products: [
              { product_id: 'prod_stale', merchant_id: 'merch_a', title: 'Stale Probe' },
              { product_id: 'prod_good', merchant_id: 'merch_b', title: 'Good Probe' },
            ],
          }));
          return;
        }

        if (body.operation === 'get_product_detail') {
          res.end(JSON.stringify({
            product: {
              variants: [{ variant_id: `variant_${body.payload.product.product_id}` }],
            },
          }));
          return;
        }

        if (body.operation === 'preview_quote') {
          const productId = body.payload.quote.items[0].product_id;
          if (productId === 'prod_stale') {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: { code: 'SHOPIFY_PRICING_UNAVAILABLE' } }));
            return;
          }
          res.end(JSON.stringify({
            quote_id: 'quote_good',
            locked_totals: { total: 199 },
            currency: 'USD',
            merchant_of_record: 'merchant',
          }));
          return;
        }

        if (body.operation === 'create_order') {
          res.end(JSON.stringify({
            order_id: 'order_good',
            amount_total: 199,
            currency: 'USD',
          }));
          return;
        }

        res.statusCode = 400;
        res.end(JSON.stringify({ error: { code: 'UNEXPECTED_OPERATION' } }));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: error.message } }));
      }
    });

    try {
      const { stdout } = await execFileAsync(
        'node',
        [scriptPath, '--create-order', '--json'],
        {
          cwd: repoRoot,
          env: baseEnvWithoutPins({
            PROBE_BASE: baseUrl,
            PROBE_QUERY: 'cheap test item',
            STRICT_CANARY_ALLOW_CREATE_ORDER: '1',
            STRICT_CANARY_SEND_TEST_IDENTITY: '1',
            STRICT_CANARY_RUN_ID: 'run_auto_select',
          }),
          encoding: 'utf8',
        },
      );

      const summary = JSON.parse(stdout);
      expect(summary.selection).toEqual(expect.objectContaining({
        source: 'find_products',
        products_seen: 2,
        candidates_available: 2,
        quote_failures: 1,
        selected_product_id: 'prod_good',
        selected_merchant_id: 'merch_b',
        variant_id_present: true,
      }));
      expect(summary.steps.preview_quote.quote_id).toBe('quote_good');
      expect(summary.steps.create_order.order_id).toBe('order_good');

      expect(requests.map((body) => body.operation)).toEqual([
        'find_products',
        'get_product_detail',
        'preview_quote',
        'get_product_detail',
        'preview_quote',
        'create_order',
      ]);
      expect(requests[2].payload.quote.items[0]).toEqual(expect.objectContaining({
        product_id: 'prod_stale',
        variant_id: 'variant_prod_stale',
      }));
      expect(requests[4].payload.quote.items[0]).toEqual(expect.objectContaining({
        product_id: 'prod_good',
        variant_id: 'variant_prod_good',
      }));
      expect(requests[5].payload.order).toEqual(expect.objectContaining({
        quote_id: 'quote_good',
      }));
      expect(requests[5].payload.order).not.toHaveProperty('items');
      expect(requests[5].payload.order).not.toHaveProperty('amount');
      expect(requests[5].payload.order).not.toHaveProperty('total_amount');
      expect(requests[5].payload.order).not.toHaveProperty('unit_price');
    } finally {
      server.close();
    }
  });
});
