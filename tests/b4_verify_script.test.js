const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const repoRoot = path.join(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'b4_verify.mjs');

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

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function baseEnv(baseUrl, extra = {}) {
  return {
    ...process.env,
    PROBE_BASE: baseUrl,
    PROBE_KEY: 'probe_secret_should_not_print',
    ORDER_ID: 'order_test_1',
    POLL_SECONDS: '0.25',
    POLL_INTERVAL: '0.01',
    ...extra,
  };
}

describe('B4 post-charge verifier script', () => {
  test('polls get_order_status until the gateway reports a paid status', async () => {
    const requests = [];
    const { server, baseUrl } = await listen(async (req, res) => {
      const body = await readJson(req);
      requests.push({ headers: req.headers, body });

      expect(req.method).toBe('POST');
      expect(req.url).toBe('/agent/shop/v1/invoke');
      expect(body).toEqual({
        operation: 'get_order_status',
        payload: { status: { order_id: 'order_test_1' } },
      });

      if (requests.length === 1) {
        json(res, 200, {
          order_id: 'order_test_1',
          payment_status: 'charge_pending',
          payment_intent_id: 'pi_test_pending',
        });
        return;
      }

      json(res, 200, {
        order: {
          order_id: 'order_test_1',
          payment_status: 'succeeded',
          payment_summary: { psp: 'stripe' },
        },
        payment: { payment_intent_id: 'pi_test_paid' },
      });
    });

    try {
      const { stdout } = await execFileAsync('node', [scriptPath], {
        cwd: repoRoot,
        env: baseEnv(baseUrl),
        encoding: 'utf8',
      });

      expect(stdout).toContain('B4 poll');
      expect(stdout).toContain('VERDICT: B4 PASS');
      expect(stdout).toContain('order order_test_1 finalized to paid');
      expect(stdout).not.toContain('probe_secret_should_not_print');
      expect(requests).toHaveLength(2);
      expect(requests[0].headers.authorization).toBe('Bearer probe_secret_should_not_print');
    } finally {
      server.close();
    }
  });

  test('returns exit code 2 when paid status is not confirmed before the polling deadline', async () => {
    const { server, baseUrl } = await listen(async (_req, res) => {
      json(res, 200, {
        order_id: 'order_test_2',
        payment_status: 'charge_pending',
        status: 'processing',
      });
    });

    try {
      await expect(execFileAsync('node', [scriptPath], {
        cwd: repoRoot,
        env: baseEnv(baseUrl, {
          ORDER_ID: 'order_test_2',
          POLL_SECONDS: '0.02',
          POLL_INTERVAL: '0.01',
        }),
        encoding: 'utf8',
      })).rejects.toMatchObject({
        code: 2,
        stdout: expect.stringContaining('VERDICT: B4 NOT CONFIRMED'),
      });
    } finally {
      server.close();
    }
  });

  test('supports a custom auth header without adding a bearer prefix', async () => {
    let seenHeader;
    const { server, baseUrl } = await listen(async (req, res) => {
      seenHeader = req.headers['x-api-key'];
      json(res, 200, {
        order_id: 'order_test_3',
        payment_status: 'paid',
      });
    });

    try {
      await execFileAsync('node', [scriptPath], {
        cwd: repoRoot,
        env: baseEnv(baseUrl, {
          ORDER_ID: 'order_test_3',
          PROBE_AUTH_HEADER: 'X-API-Key',
        }),
        encoding: 'utf8',
      });
      expect(seenHeader).toBe('probe_secret_should_not_print');
    } finally {
      server.close();
    }
  });

  test.each(['paid', 'completed', 'succeeded', 'success', 'settled'])(
    'accepts paid alias %s as terminal status',
    async (paidStatus) => {
      const { server, baseUrl } = await listen(async (_req, res) => {
        json(res, 200, {
          order: {
            orderId: 'order_alias',
            paymentStatus: paidStatus,
          },
          payment: { psp_reference: 'psp_ref_alias' },
        });
      });

      try {
        const { stdout } = await execFileAsync('node', [scriptPath], {
          cwd: repoRoot,
          env: baseEnv(baseUrl, { ORDER_ID: 'order_alias' }),
          encoding: 'utf8',
        });
        expect(stdout).toContain('VERDICT: B4 PASS');
      } finally {
        server.close();
      }
    },
  );

  test('fails if get_order_status returns a different order id', async () => {
    const { server, baseUrl } = await listen(async (_req, res) => {
      json(res, 200, {
        order_id: 'order_wrong',
        payment_status: 'paid',
      });
    });

    try {
      await expect(execFileAsync('node', [scriptPath], {
        cwd: repoRoot,
        env: baseEnv(baseUrl, { ORDER_ID: 'order_expected' }),
        encoding: 'utf8',
      })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Order status response order_id mismatch'),
      });
    } finally {
      server.close();
    }
  });

  test('does not duplicate a bearer prefix when the probe key already has a scheme', async () => {
    let seenAuth;
    const { server, baseUrl } = await listen(async (req, res) => {
      seenAuth = req.headers.authorization;
      json(res, 200, {
        order_id: 'order_bearer',
        payment_status: 'paid',
      });
    });

    try {
      await execFileAsync('node', [scriptPath], {
        cwd: repoRoot,
        env: baseEnv(baseUrl, {
          ORDER_ID: 'order_bearer',
          PROBE_KEY: 'ApiKey already-prefixed-key',
        }),
        encoding: 'utf8',
      });
      expect(seenAuth).toBe('ApiKey already-prefixed-key');
    } finally {
      server.close();
    }
  });

  test('redacts probe key and secret-looking values from HTTP error details', async () => {
    const { server, baseUrl } = await listen(async (_req, res) => {
      json(res, 500, {
        error: {
          message: 'backend rejected Bearer probe_secret_should_not_print',
          client_secret: 'pi_123_secret_should_not_print',
          acp_state: { access_token: 'state-token-should-not-print' },
        },
      });
    });

    try {
      await expect(execFileAsync('node', [scriptPath], {
        cwd: repoRoot,
        env: baseEnv(baseUrl),
        encoding: 'utf8',
      })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('[REDACTED]'),
      });
    } catch (error) {
      throw error;
    } finally {
      server.close();
    }

    try {
      await execFileAsync('node', [scriptPath], {
        cwd: repoRoot,
        env: baseEnv(baseUrl),
        encoding: 'utf8',
      });
    } catch (error) {
      expect(error.stderr).not.toContain('probe_secret_should_not_print');
      expect(error.stderr).not.toContain('pi_123_secret_should_not_print');
      expect(error.stderr).not.toContain('state-token-should-not-print');
    }
  });

  test('fails usage preflight before any network call when ORDER_ID is missing', async () => {
    const env = baseEnv('http://127.0.0.1:9');
    delete env.ORDER_ID;

    await expect(execFileAsync('node', [scriptPath], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Missing required env var: ORDER_ID'),
    });
  });

  test('fails usage preflight for invalid polling intervals', async () => {
    await expect(execFileAsync('node', [scriptPath], {
      cwd: repoRoot,
      env: baseEnv('http://127.0.0.1:9', { POLL_SECONDS: '0' }),
      encoding: 'utf8',
    })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('POLL_SECONDS must be a positive number of seconds'),
    });
  });
});
