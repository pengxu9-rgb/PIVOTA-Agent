const {
  INVOKE_EXTERNAL_API_KEY_PATTERN,
  parseBearerToken,
  fingerprintSecret,
  hashSecretForCache,
  createExternalInvokeAuthRuntime,
} = require('../../src/commerce/externalInvokeAuth');

describe('externalInvokeAuth', () => {
  test('parseBearerToken and secret hashing helpers stay stable', () => {
    expect(parseBearerToken('Bearer abc')).toBe('abc');
    expect(parseBearerToken('bearer   xyz  ')).toBe('xyz');
    expect(parseBearerToken('Basic abc')).toBeNull();
    expect(INVOKE_EXTERNAL_API_KEY_PATTERN.test(`ak_live_${'a'.repeat(64)}`)).toBe(true);
    expect(fingerprintSecret('secret')).toHaveLength(16);
    expect(hashSecretForCache('secret')).toHaveLength(64);
  });

  test('buildInvokeUpstreamAuthHeaders prefers checkout token then auth context then internal fallback', async () => {
    const runtime = createExternalInvokeAuthRuntime({
      axiosClient: { post: jest.fn() },
      logger: { warn: jest.fn(), error: jest.fn() },
      pivotaApiKey: 'internal_key',
    });

    expect(
      runtime.buildInvokeUpstreamAuthHeaders({ checkoutToken: 'chk_123' }),
    ).toEqual({
      'X-Checkout-Token': 'chk_123',
    });

    const contextHeaders = await runtime.invokeAuthContext.run(
      { api_key: 'ak_live_context' },
      async () => runtime.buildInvokeUpstreamAuthHeaders(),
    );
    expect(contextHeaders).toEqual({
      'X-API-Key': 'ak_live_context',
      Authorization: 'Bearer ak_live_context',
    });

    expect(runtime.buildInvokeUpstreamAuthHeaders()).toEqual({
      'X-API-Key': 'internal_key',
      Authorization: 'Bearer internal_key',
    });
    expect(
      runtime.buildInvokeUpstreamAuthHeaders({ allowInternalFallback: false }),
    ).toEqual({});
  });

  test('requireExternalInvokeAuth allows test bypass when introspection is unset', async () => {
    const runtime = createExternalInvokeAuthRuntime({
      axiosClient: { post: jest.fn() },
      logger: { warn: jest.fn(), error: jest.fn() },
      nodeEnv: 'test',
    });
    const req = {
      header: jest.fn(() => ''),
    };
    const next = jest.fn();

    await runtime.requireExternalInvokeAuth(req, {}, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.invokeAuth).toMatchObject({
      auth_mode: 'test_bypass',
      auth_source: 'test_bypass',
    });
  });

  test('requireExternalInvokeAuth rejects invalid key format before introspection', async () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const axiosClient = { post: jest.fn() };
    const runtime = createExternalInvokeAuthRuntime({
      axiosClient,
      logger,
      agentAuthIntrospectUrl: 'https://auth.test/introspect',
      agentAuthIntrospectInternalKey: 'internal_key',
      nodeEnv: 'production',
    });
    const req = {
      path: '/agent/shop/v1/invoke',
      header(name) {
        if (String(name).toLowerCase() === 'x-agent-api-key') return 'invalid';
        return '';
      },
    };
    const res = {
      status: jest.fn(function status() {
        return this;
      }),
      json: jest.fn(function json(body) {
        return body;
      }),
    };

    const result = await runtime.requireExternalInvokeAuth(req, res, jest.fn());

    expect(axiosClient.post).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid API key',
    });
    expect(logger.warn).toHaveBeenCalled();
    expect(result).toEqual({
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid API key',
    });
  });

  test('requireExternalInvokeAuth returns 403 for inactive introspected agent', async () => {
    const runtime = createExternalInvokeAuthRuntime({
      axiosClient: {
        post: jest.fn(async () => ({
          status: 200,
          data: {
            valid: true,
            agent_id: 'agent_123',
            is_active: false,
            auth_source: 'api_keys',
          },
        })),
      },
      logger: { warn: jest.fn(), error: jest.fn() },
      agentAuthIntrospectUrl: 'https://auth.test/introspect',
      agentAuthIntrospectInternalKey: 'internal_key',
      nodeEnv: 'production',
    });
    const req = {
      header(name) {
        if (String(name).toLowerCase() === 'x-agent-api-key') {
          return `ak_live_${'a'.repeat(64)}`;
        }
        return '';
      },
    };
    const res = {
      status: jest.fn(function status() {
        return this;
      }),
      json: jest.fn(function json(body) {
        return body;
      }),
    };

    const result = await runtime.requireExternalInvokeAuth(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'FORBIDDEN',
      message: 'Agent is deactivated',
    });
    expect(result).toEqual({
      error: 'FORBIDDEN',
      message: 'Agent is deactivated',
    });
  });
});
