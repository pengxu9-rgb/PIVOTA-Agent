const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const repoRoot = path.join(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'validate_platform_smoke_evidence.mjs');

function validEvidence(overrides = {}) {
  return mergeDeep({
    operator: {
      approver: 'platform@example.com',
    },
    environment: {
      gateway_full_sha: '429079c206866a5be3ab6d8d9462b24a9ae581e9',
      gateway_deployment_id: '4c539441-62f3-433c-9ab9-cf92669a8057',
    },
    remote_mcp: {
      server_url: 'https://pivota-agent-production.up.railway.app/mcp',
      initialize_ok: true,
      tools_listed: [
        'search_catalog',
        'get_product',
        'create_checkout_session',
        'update_checkout_session',
        'get_checkout_session',
        'complete_checkout_session',
        'cancel_checkout_session',
        'get_order',
        'request_after_sales',
      ],
      write_without_verified_identity_failed: true,
      write_without_verified_identity_code: 'USER_AUTH_REQUIRED',
      verified_session_created_checkout_session: true,
      model_supplied_identity_refused: true,
    },
    identity: {
      user_ref_source: 'oauth_sub',
      acp_session_id_source: 'server_session',
      body_identity_rejected: true,
    },
    confirmation_action: {
      route: 'https://pivota-agent-production.up.railway.app/checkout/confirm',
      unsigned_action_rejected: true,
      signed_user_action_minted_token: true,
      token_minted_only_after_user_action: true,
      token_not_exposed_to_model_tool: true,
    },
    no_money_ops: {
      complete_checkout_session_called: false,
      submit_payment_called: false,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-smoke-evidence-'));
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

describe('platform smoke evidence validator', () => {
  test('accepts complete remote MCP and confirmation action smoke evidence', async () => {
    const { stdout } = await runEvidence(validEvidence());
    const result = JSON.parse(stdout);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      mcp_url: 'https://pivota-agent-production.up.railway.app/mcp',
      confirmation_url: 'https://pivota-agent-production.up.railway.app/checkout/confirm',
    }));
    expect(result.tools_checked).toEqual(expect.arrayContaining([
      'create_checkout_session',
      'complete_checkout_session',
      'request_after_sales',
    ]));
  });

  test('rejects missing required MCP commerce tools', async () => {
    await expect(runEvidence(validEvidence({
      remote_mcp: {
        tools_listed: ['search_catalog', 'get_product'],
      },
    }))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Remote MCP tool list is missing required commerce tools'),
    });
  });

  test('rejects platform smoke that allowed a model-visible money op', async () => {
    await expect(runEvidence(validEvidence({
      no_money_ops: {
        complete_checkout_session_called: true,
      },
    }))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('no_money_ops.complete_checkout_session_called=false'),
    });
  });

  test('rejects confirmation token minting without signed user action proof', async () => {
    await expect(runEvidence(validEvidence({
      confirmation_action: {
        token_minted_only_after_user_action: false,
      },
    }))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('confirmation_action.token_minted_only_after_user_action=true'),
    });
  });

  test('rejects raw auth tokens in platform evidence', async () => {
    await expect(runEvidence(validEvidence({
      notes: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    }))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Evidence file contains sensitive-looking values'),
    });
  });
});
