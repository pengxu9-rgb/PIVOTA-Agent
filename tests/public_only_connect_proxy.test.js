'use strict';

const { parseConnectAuthority, resolvePublicConnectTarget } = require('../src/services/publicOnlyConnectProxy');
const { createCommerceStorefrontAudit } = require('../src/services/commerceStorefrontAudit');
const { createPublicOnlyConnectProxy } = require('../src/services/publicOnlyConnectProxy');

test('accepts only HTTPS CONNECT authorities with a public hostname and port 443', () => {
  expect(parseConnectAuthority('merchant.example:443')).toEqual({ hostname: 'merchant.example', port: 443 });
  expect(parseConnectAuthority('merchant.example:8443')).toBeNull();
  expect(parseConnectAuthority('127.0.0.1:443')).toBeNull();
  expect(parseConnectAuthority('localhost:443')).toBeNull();
});

test('rejects DNS answers containing a private address instead of selecting a public sibling', async () => {
  await expect(resolvePublicConnectTarget('merchant.example:443', {
    lookup: async () => [{ address: '203.0.113.10' }, { address: '10.0.0.5' }],
  })).resolves.toBeNull();
  await expect(resolvePublicConnectTarget('merchant.example:443', {
    lookup: async () => [{ address: '8.8.8.8' }],
  })).resolves.toEqual({ hostname: 'merchant.example', port: 443, address: '8.8.8.8' });
});

test('pins CONNECT to the validated public IP, so a later DNS answer cannot rebind Chromium', async () => {
  const upstream = Object.assign(new (require('node:events').EventEmitter)(), {
    setTimeout: jest.fn(), pipe: jest.fn(), destroy: jest.fn(), write: jest.fn(),
  });
  const connect = jest.fn().mockReturnValue(upstream);
  const client = Object.assign(new (require('node:events').EventEmitter)(), {
    end: jest.fn(), write: jest.fn(), pipe: jest.fn(),
  });
  const proxy = createPublicOnlyConnectProxy({ lookup: async () => [{ address: '8.8.8.8' }], connect });
  proxy.server.emit('connect', { url: 'merchant.example:443' }, client, Buffer.alloc(0));
  await new Promise((resolve) => setImmediate(resolve));
  expect(connect).toHaveBeenCalledWith({ host: '8.8.8.8', port: 443 });
  upstream.emit('connect');
  expect(client.write).toHaveBeenCalledWith('HTTP/1.1 200 Connection Established\r\n\r\n');
  expect(client.pipe).toHaveBeenCalledWith(upstream);
  expect(upstream.pipe).toHaveBeenCalledWith(client);
});

test('launches Chromium through the connection-bound proxy instead of direct merchant DNS', async () => {
  const proxy = { start: jest.fn().mockResolvedValue({ server: 'http://127.0.0.1:32123' }), close: jest.fn().mockResolvedValue() };
  const page = {
    goto: jest.fn().mockResolvedValue(), url: () => 'https://merchant.example/product/a',
    locator: () => ({ first: () => ({ getAttribute: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0), isVisible: jest.fn() }), innerText: jest.fn().mockResolvedValue('') }),
    getByRole: () => ({ count: jest.fn().mockResolvedValue(0), first: () => ({ isVisible: jest.fn().mockResolvedValue(false) }) }),
  };
  const context = { route: jest.fn().mockResolvedValue(), newPage: jest.fn().mockResolvedValue(page) };
  const browser = { newContext: jest.fn().mockResolvedValue(context), close: jest.fn().mockResolvedValue() };
  const playwright = { chromium: { launch: jest.fn().mockResolvedValue(browser) } };
  const audit = createCommerceStorefrontAudit({ playwright, validateUrl: async () => ({ ok: true }), connectProxyFactory: () => proxy });
  await expect(audit.audit({ targetUrl: 'https://merchant.example/product/a' })).resolves.toMatchObject({ verification_status: 'succeeded' });
  expect(playwright.chromium.launch).toHaveBeenCalledWith(expect.objectContaining({ proxy: { server: 'http://127.0.0.1:32123' } }));
  expect(proxy.close).toHaveBeenCalled();
});
