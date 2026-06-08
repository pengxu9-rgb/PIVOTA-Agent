const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const repoRoot = path.join(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'smoke_protocol_edge_remote_mcp.mjs');

const TOOL_NAMES = [
  'search_catalog',
  'get_product',
  'create_checkout_session',
  'update_checkout_session',
  'get_checkout_session',
  'complete_checkout_session',
  'cancel_checkout_session',
  'get_order',
  'request_after_sales',
];

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
    PROBE_KEY: 'ak_live_test_probe_key',
    MCP_SMOKE_APPROVER: 'platform@example.com',
    ...extra,
  };
}

describe('remote MCP protocol-edge smoke script', () => {
  test('runs initialize/list and identity fail-closed without payment calls', async () => {
    const calls = [];
    const { server, baseUrl } = await listen(async (req, res) => {
      calls.push({ method: req.method, url: req.url });
      if (req.method === 'GET' && req.url === '/version') {
        json(res, 200, { full_sha: 'sha_test', deployment_id: 'deploy_test' });
        return;
      }
      if (req.method === 'POST' && req.url === '/mcp') {
        const body = await readJson(req);
        if (body.method === 'initialize') {
          json(res, 200, { jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'pivota' } } });
          return;
        }
        if (body.method === 'tools/list') {
          json(res, 200, { jsonrpc: '2.0', id: body.id, result: { tools: TOOL_NAMES.map((name) => ({ name })) } });
          return;
        }
        if (body.method === 'tools/call' && body.params?.name === 'create_checkout_session') {
          json(res, 200, {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ code: 'USER_AUTH_REQUIRED' }) }],
            },
          });
          return;
        }
      }
      json(res, 500, { error: 'unexpected' });
    });

    try {
      const { stdout } = await execFileAsync('node', [scriptPath, '--json'], {
        cwd: repoRoot,
        env: baseEnv(baseUrl),
        encoding: 'utf8',
      });
      const evidence = JSON.parse(stdout);
      expect(evidence.remote_mcp.initialize_ok).toBe(true);
      expect(evidence.remote_mcp.write_without_verified_identity_code).toBe('USER_AUTH_REQUIRED');
      expect(evidence.remote_mcp.verified_session_created_checkout_session).toBe(false);
      expect(evidence.no_money_ops).toEqual({
        complete_checkout_session_called: false,
        submit_payment_called: false,
        paid_charge_attempted: false,
      });
      expect(calls.map((call) => call.url)).not.toContain('/agent/shop/v1/invoke');
    } finally {
      server.close();
    }
  });

  test('emits full validator-compatible evidence with verified session and signed confirmation action', async () => {
    const toolsCalled = [];
    const { server, baseUrl } = await listen(async (req, res) => {
      if (req.method === 'GET' && req.url === '/version') {
        json(res, 200, { full_sha: 'sha_test', deployment_id: 'deploy_test' });
        return;
      }
      if (req.method === 'POST' && req.url === '/mcp') {
        const body = await readJson(req);
        if (body.method === 'initialize') {
          json(res, 200, { jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'pivota' } } });
          return;
        }
        if (body.method === 'tools/list') {
          json(res, 200, { jsonrpc: '2.0', id: body.id, result: { tools: TOOL_NAMES.map((name) => ({ name })) } });
          return;
        }
        if (body.method === 'tools/call') {
          toolsCalled.push(body.params.name);
          if (!req.headers['x-test-user-ref']) {
            json(res, 200, {
              jsonrpc: '2.0',
              id: body.id,
              result: {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify({ code: 'USER_AUTH_REQUIRED' }) }],
              },
            });
            return;
          }
          json(res, 200, {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{ type: 'text', text: JSON.stringify({ session_id: 'q_test_1', status: 'ready_for_payment' }) }],
            },
          });
          return;
        }
      }
      if (req.method === 'POST' && req.url === '/checkout/confirm') {
        if (!req.headers['x-pivota-confirm-signature']) {
          json(res, 403, { error: { code: 'CONFIRMATION_ACTION_REQUIRED' } });
          return;
        }
        json(res, 200, { confirmation_token: 'confirm_token_should_not_be_output' });
        return;
      }
      json(res, 500, { error: 'unexpected' });
    });

    try {
      const { stdout } = await execFileAsync('node', [scriptPath, '--full', '--json'], {
        cwd: repoRoot,
        env: baseEnv(baseUrl, {
          MCP_SMOKE_ALLOW_VERIFIED_SESSION: '1',
          MCP_SMOKE_MERCHANT_ID: 'merch_test',
          MCP_SMOKE_PRODUCT_ID: 'prod_test',
          MCP_SMOKE_ORDER_ID: 'ord_test',
          MCP_SMOKE_USER_REF: 'usr_test',
          MCP_SMOKE_ACP_SESSION_ID: 'acp_test',
          CONFIRMATION_SECRET: 'strict-confirmation-secret-0123456789',
        }),
        encoding: 'utf8',
      });
      const evidence = JSON.parse(stdout);
      expect(evidence.remote_mcp.verified_session_created_checkout_session).toBe(true);
      expect(evidence.remote_mcp.model_supplied_identity_ignored).toBe(true);
      expect(evidence.identity.body_identity_rejected).toBe(true);
      expect(evidence.confirmation_action.unsigned_action_rejected).toBe(true);
      expect(evidence.confirmation_action.signed_user_action_minted_token).toBe(true);
      expect(JSON.stringify(evidence)).not.toContain('confirm_token_should_not_be_output');
      expect(toolsCalled).toEqual(['create_checkout_session', 'create_checkout_session']);
      expect(toolsCalled).not.toContain('complete_checkout_session');
    } finally {
      server.close();
    }
  });

  test('refuses full smoke without explicit verified-session acknowledgment', async () => {
    const { server, baseUrl } = await listen(async (req, res) => {
      if (req.method === 'GET' && req.url === '/version') {
        json(res, 200, { full_sha: 'sha_test', deployment_id: 'deploy_test' });
        return;
      }
      if (req.method === 'POST' && req.url === '/mcp') {
        const body = await readJson(req);
        if (body.method === 'initialize') {
          json(res, 200, { jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'pivota' } } });
          return;
        }
        if (body.method === 'tools/list') {
          json(res, 200, { jsonrpc: '2.0', id: body.id, result: { tools: TOOL_NAMES.map((name) => ({ name })) } });
          return;
        }
        json(res, 200, {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ code: 'USER_AUTH_REQUIRED' }) }],
          },
        });
        return;
      }
      json(res, 500, { error: 'unexpected' });
    });

    try {
      await expect(execFileAsync('node', [scriptPath, '--full', '--json'], {
        cwd: repoRoot,
        env: baseEnv(baseUrl),
        encoding: 'utf8',
      })).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining('MCP_SMOKE_ALLOW_VERIFIED_SESSION=1'),
      });
    } finally {
      server.close();
    }
  });
});
