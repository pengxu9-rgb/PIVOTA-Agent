const assert = require('assert');
const test = require('node:test');

const modulePath = require.resolve('../src/auroraBff/routes/chat');

function loadChatModuleFresh() {
  delete require.cache[modulePath];
  return require(modulePath);
}

test('aurora v1 mainline proxy timeout defaults to 25 seconds', () => {
  const previous = process.env.AURORA_V1_MAINLINE_PROXY_TIMEOUT_MS;
  delete process.env.AURORA_V1_MAINLINE_PROXY_TIMEOUT_MS;
  try {
    const mod = loadChatModuleFresh();
    assert.equal(mod.__getAuroraV1MainlineProxyTimeoutMsForTests(), 25000);
  } finally {
    if (previous == null) delete process.env.AURORA_V1_MAINLINE_PROXY_TIMEOUT_MS;
    else process.env.AURORA_V1_MAINLINE_PROXY_TIMEOUT_MS = previous;
    delete require.cache[modulePath];
  }
});

test('aurora v1 mainline proxy timeout honors env override', () => {
  const previous = process.env.AURORA_V1_MAINLINE_PROXY_TIMEOUT_MS;
  process.env.AURORA_V1_MAINLINE_PROXY_TIMEOUT_MS = '32000';
  try {
    const mod = loadChatModuleFresh();
    assert.equal(mod.__getAuroraV1MainlineProxyTimeoutMsForTests(), 32000);
  } finally {
    if (previous == null) delete process.env.AURORA_V1_MAINLINE_PROXY_TIMEOUT_MS;
    else process.env.AURORA_V1_MAINLINE_PROXY_TIMEOUT_MS = previous;
    delete require.cache[modulePath];
  }
});
