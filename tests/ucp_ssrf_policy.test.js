'use strict';

const {
  createPublicOnlyLookup,
  createUcpBuyerAgentClient,
  isForbiddenNetworkAddress,
} = require('../src/services/ucpBuyerAgentClient');

test.each([
  '127.0.0.1', '10.0.0.9', '169.254.169.254', '172.16.0.1',
  '192.168.1.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1',
  '::127.0.0.1', '::7f00:1', 'fe81::1', 'ff02::1',
])('forbids non-public address %s', (address) => {
  expect(isForbiddenNetworkAddress(address)).toBe(true);
});

test.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('permits public address %s', (address) => {
  expect(isForbiddenNetworkAddress(address)).toBe(false);
});

test('DNS lookup rejects a mixed public/private answer to prevent rebinding fallback', (done) => {
  const lookup = createPublicOnlyLookup((_host, _opts, callback) => callback(null, [
    { address: '8.8.8.8', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ]));
  lookup('merchant.example', {}, (error) => {
    expect(error).toBeInstanceOf(Error);
    done();
  });
});

test('literal private storefront is rejected before an injected fetch is called', async () => {
  const fetchImpl = jest.fn();
  const client = createUcpBuyerAgentClient({ forceAnonymous: true, fetchImpl });
  await expect(client.discoverEndpoint('https://127.0.0.1')).rejects.toThrow('public address');
  expect(fetchImpl).not.toHaveBeenCalled();
});
