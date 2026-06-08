const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

describe('agent checkout audit export assertion script', () => {
  test('passes when quote and order audit events are present and redacted', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-checkout-audit-'));
    const inputPath = path.join(outDir, 'raw.ndjson');
    const scriptPath = path.join(repoRoot, 'scripts', 'assert_agent_checkout_audit_export.js');

    fs.writeFileSync(
      inputPath,
      [
        JSON.stringify({
          message: JSON.stringify({
            event: 'agent_checkout_audit',
            audit: {
              event: 'quote_issued',
              operation: 'preview_quote',
              quote_id: 'q_test',
              user_ref: 'usr_test',
              currency: 'USD',
            },
          }),
        }),
        JSON.stringify({
          event: 'agent_checkout_audit',
          audit: {
            event: 'order_created',
            operation: 'create_order',
            order_id: 'ORD_TEST',
            user_ref: 'usr_test',
            idempotency_key: 'idem_test',
            currency: 'USD',
          },
        }),
      ].join('\n'),
    );

    const stdout = execFileSync(
      process.execPath,
      [
        scriptPath,
        '--input',
        inputPath,
        '--quote-id',
        'q_test',
        '--order-id',
        'ORD_TEST',
        '--user-ref',
        'usr_test',
        '--idempotency-key',
        'idem_test',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    const payload = JSON.parse(stdout);
    expect(payload.quote_issued_found).toBe(true);
    expect(payload.order_created_found).toBe(true);
    expect(payload.sensitive_hits).toEqual([]);
  });

  test('passes when required audit events are present', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-checkout-audit-'));
    const inputPath = path.join(outDir, 'raw.ndjson');
    const scriptPath = path.join(repoRoot, 'scripts', 'assert_agent_checkout_audit_export.js');

    fs.writeFileSync(
      inputPath,
      [
        JSON.stringify({
          event: 'agent_checkout_audit',
          audit: {
            event: 'quote_issued',
            operation: 'preview_quote',
            quote_id: 'q_test',
            user_ref: 'usr_test',
            currency: 'USD',
          },
        }),
        JSON.stringify({
          event: 'agent_checkout_audit',
          audit: {
            event: 'order_created',
            operation: 'create_order',
            order_id: 'ORD_TEST',
            user_ref: 'usr_test',
            idempotency_key: 'idem_test',
            currency: 'USD',
          },
        }),
        JSON.stringify({
          event: 'agent_checkout_audit',
          audit: {
            event: 'idempotent_replay',
            operation: 'create_order',
            order_id: 'ORD_TEST',
            user_ref: 'usr_test',
            idempotency_key: 'idem_test',
            currency: 'USD',
          },
        }),
        JSON.stringify({
          event: 'agent_checkout_audit',
          audit: {
            event: 'user_auth_blocked',
            operation: 'create_order',
          },
        }),
      ].join('\n'),
    );

    const stdout = execFileSync(
      process.execPath,
      [
        scriptPath,
        '--input',
        inputPath,
        '--quote-id',
        'q_test',
        '--order-id',
        'ORD_TEST',
        '--user-ref',
        'usr_test',
        '--idempotency-key',
        'idem_test',
        '--require-event',
        'idempotent_replay,user_auth_blocked',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    const payload = JSON.parse(stdout);
    expect(payload.required_event_matches).toEqual({
      idempotent_replay: true,
      user_auth_blocked: true,
    });
  });

  test('passes for blocked-event exports without quote/order identifiers', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-checkout-audit-'));
    const inputPath = path.join(outDir, 'raw.ndjson');
    const scriptPath = path.join(repoRoot, 'scripts', 'assert_agent_checkout_audit_export.js');

    fs.writeFileSync(
      inputPath,
      JSON.stringify({
        event: 'agent_checkout_audit',
        audit: {
          event: 'user_auth_blocked',
          operation: 'preview_quote',
          detail: {
            code: 'USER_AUTH_REQUIRED',
            reason: 'missing_verified_user',
          },
        },
      }),
    );

    const stdout = execFileSync(
      process.execPath,
      [
        scriptPath,
        '--input',
        inputPath,
        '--require-event',
        'user_auth_blocked',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    const payload = JSON.parse(stdout);
    expect(payload.quote_issued_found).toBe(false);
    expect(payload.order_created_found).toBe(false);
    expect(payload.required_event_matches).toEqual({ user_auth_blocked: true });
    expect(payload.sensitive_hits).toEqual([]);
  });

  test('fails when a required audit event is missing', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-checkout-audit-'));
    const inputPath = path.join(outDir, 'raw.ndjson');
    const scriptPath = path.join(repoRoot, 'scripts', 'assert_agent_checkout_audit_export.js');

    fs.writeFileSync(
      inputPath,
      [
        JSON.stringify({
          event: 'agent_checkout_audit',
          audit: {
            event: 'quote_issued',
            operation: 'preview_quote',
            quote_id: 'q_test',
            user_ref: 'usr_test',
          },
        }),
        JSON.stringify({
          event: 'agent_checkout_audit',
          audit: {
            event: 'order_created',
            operation: 'create_order',
            order_id: 'ORD_TEST',
            user_ref: 'usr_test',
            idempotency_key: 'idem_test',
          },
        }),
      ].join('\n'),
    );

    expect(() =>
      execFileSync(
        process.execPath,
        [
          scriptPath,
          '--input',
          inputPath,
          '--quote-id',
          'q_test',
          '--order-id',
          'ORD_TEST',
          '--user-ref',
          'usr_test',
          '--idempotency-key',
          'idem_test',
          '--require-event',
          'idempotent_replay',
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    ).toThrow(/missing required audit event/);
  });

  test('fails when a sensitive audit field is present', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-checkout-audit-'));
    const inputPath = path.join(outDir, 'raw.ndjson');
    const scriptPath = path.join(repoRoot, 'scripts', 'assert_agent_checkout_audit_export.js');

    fs.writeFileSync(
      inputPath,
      [
        JSON.stringify({
          event: 'agent_checkout_audit',
          audit: {
            event: 'quote_issued',
            operation: 'preview_quote',
            quote_id: 'q_test',
            user_ref: 'usr_test',
          },
        }),
        JSON.stringify({
          event: 'agent_checkout_audit',
          audit: {
            event: 'order_created',
            operation: 'create_order',
            order_id: 'ORD_TEST',
            user_ref: 'usr_test',
            idempotency_key: 'idem_test',
            payment_token: 'tok_secret',
          },
        }),
      ].join('\n'),
    );

    expect(() =>
      execFileSync(
        process.execPath,
        [
          scriptPath,
          '--input',
          inputPath,
          '--quote-id',
          'q_test',
          '--order-id',
          'ORD_TEST',
          '--user-ref',
          'usr_test',
          '--idempotency-key',
          'idem_test',
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    ).toThrow(/sensitive audit fields found/);
  });
});
