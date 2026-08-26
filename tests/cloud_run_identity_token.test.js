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
