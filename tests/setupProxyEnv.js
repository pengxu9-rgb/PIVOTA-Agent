// Strip proxy env vars so axios does not route nock-mocked hosts through a
// local proxy. nock 14 (@mswjs/interceptors) throws TypeError: Invalid URL on
// proxy-style requests (absolute-URI path + proxy hostname), so interceptors
// never match: auth mocks on auth.test fail closed as 503 and upstream mocks
// on backend.test surface as 502/blocked. NO_PROXY rarely covers the .test
// fixture hosts, so a Clash/mihomo-style local proxy silently poisons any
// nock-based route test.
for (const key of [
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
  'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
]) {
  delete process.env[key];
}
