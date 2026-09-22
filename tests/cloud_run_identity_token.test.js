'use strict';

const { cloudRunAudience, createCloudRunIdTokenProvider } = require('../src/services/cloudRunIdentityToken');

test('only a bare HTTPS Cloud Run service origin is accepted as audience', () => {
  expect(cloudRunAudience('https://web-abc-uw.a.run.app')).toBe('https://web-abc-uw.a.run.app');
  expect(cloudRunAudience('https://web-abc-uw.a.run.app/')).toBe('https://web-abc-uw.a.run.app');
  expect(cloudRunAudience('https://web-abc-uw.a.run.app/claims')).toBeNull();
  expect(cloudRunAudience('https://user@web-abc-uw.a.run.app')).toBeNull();
  expect(cloudRunAudience('http://web-abc-uw.a.run.app')).toBeNull();
});

test('metadata identity request is fixed and bound to the configured audience', async () => {
  const fetchImpl = jest.fn().mockResolvedValue({ ok: true, text: async () => 'jwt-token' });
  const provider = createCloudRunIdTokenProvider({ audience: 'https://web-abc-uw.a.run.app', fetchImpl });
  await expect(provider.getToken()).resolves.toBe('jwt-token');
  await expect(provider.getToken()).resolves.toBe('jwt-token');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0][0]).toContain('metadata.google.internal/computeMetadata');
  expect(fetchImpl.mock.calls[0][0]).toContain(encodeURIComponent('https://web-abc-uw.a.run.app'));
  expect(fetchImpl.mock.calls[0][1].headers['metadata-flavor']).toBe('Google');
  // The metadata request is bounded by the provider's 3s abort timer.
  expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});

test('audience can be sourced from a caller-named env var', async () => {
  process.env.CLOUD_RUN_ID_TOKEN_TEST_AUDIENCE = 'https://ucp-web-abc-uw.a.run.app';
  try {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, text: async () => 'tok' });
    const provider = createCloudRunIdTokenProvider({ audienceEnvVar: 'CLOUD_RUN_ID_TOKEN_TEST_AUDIENCE', fetchImpl });
    expect(provider.audience).toBe('https://ucp-web-abc-uw.a.run.app');
    await expect(provider.getToken()).resolves.toBe('tok');
  } finally {
    delete process.env.CLOUD_RUN_ID_TOKEN_TEST_AUDIENCE;
  }
});

test('an explicit audience wins over the named env var', () => {
  process.env.CLOUD_RUN_ID_TOKEN_TEST_AUDIENCE = 'https://env-web-abc-uw.a.run.app';
  try {
    const provider = createCloudRunIdTokenProvider({
      audience: 'https://arg-web-abc-uw.a.run.app',
      audienceEnvVar: 'CLOUD_RUN_ID_TOKEN_TEST_AUDIENCE',
      fetchImpl: jest.fn(),
    });
    expect(provider.audience).toBe('https://arg-web-abc-uw.a.run.app');
  } finally {
    delete process.env.CLOUD_RUN_ID_TOKEN_TEST_AUDIENCE;
  }
});

// A NON-OK metadata response must yield `null`, never its body. Before this test nothing measured
// the `response.ok` check: dropping it left every suite green (mutation sweep, 2026-09-22), and the
// consequence is that a metadata-server error page would be sent as an `Authorization: Bearer`
// value by the four store-audit callers — which then reads as an auth failure at the receiving end
// rather than a metadata failure here. Each case builds its own provider because this provider
// caches its first in-flight promise forever (deliberate for its batch callers).
describe('a non-OK metadata response is a null token, not a bearer value', () => {
  test.each([
    ['500, ok:false', { ok: false, status: 500 }, 'some error page'],
    ['403, ok:false', { ok: false, status: 403 }, '<html>Forbidden</html>'],
    // `ok` ABSENT is not `ok`. A real Response always carries a boolean, but a wrapped or stubbed
    // fetchImpl may not, and only a truthy `ok` may turn a body into a bearer value.
    ['ok absent', { status: 200 }, 'body-without-ok'],
  ])('%s: the body is NOT surfaced as the token', async (_label, shape, body) => {
    const fetchImpl = jest.fn().mockResolvedValue({ ...shape, text: async () => body });
    const provider = createCloudRunIdTokenProvider({ audience: 'https://web-abc-uw.a.run.app', fetchImpl });
    await expect(provider.getToken()).resolves.toBeNull();
    // The null is cached like a token would be: a second ask does not re-fetch.
    await expect(provider.getToken()).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('an OK response whose body is only whitespace is a null token, not an empty bearer', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '  \n\t ' });
    const provider = createCloudRunIdTokenProvider({ audience: 'https://web-abc-uw.a.run.app', fetchImpl });
    await expect(provider.getToken()).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('an OK response is still trimmed to the token, so the trim is not what nulls the error page', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '\n jwt-token \n' });
    const provider = createCloudRunIdTokenProvider({ audience: 'https://web-abc-uw.a.run.app', fetchImpl });
    await expect(provider.getToken()).resolves.toBe('jwt-token');
  });
});
