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
});
