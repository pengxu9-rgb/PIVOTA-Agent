'use strict';

/*
 * scripts/lib/aurora_surface_auth.sh shadows `curl` so the release-gate smokes carry
 * X-Internal-Key to the gateway without editing dozens of call sites.
 *
 * The property that needs pinning is NOT "the header is added" — it is that the header is added
 * ONLY for gateway URLs. The alternatives considered (a ~/.curlrc entry, or appending the header
 * unconditionally in the wrapper) would have attached the shared secret to every curl the CI job
 * makes, including fixture downloads and vendor APIs. That is a credential-exfiltration bug that
 * would never show up as a test failure, so it gets a test of its own.
 *
 * Driven through real bash with `command` stubbed, so what is asserted is the actual argv the real
 * curl binary would have received.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'aurora_surface_auth.sh');
const KEY = 'secret-key-value-do-not-leak';
const T = { timeout: 20_000 };

/** Returns the argv the real curl would have been invoked with. */
function argvFor({ url, key = KEY, base = 'https://gw.example', extra = [] }) {
  const script = `
set -u
BASE=${JSON.stringify(base)}
${key === null ? '' : `AURORA_SURFACE_INTERNAL_KEY=${JSON.stringify(key)}`}
command() { if [ "$1" = "curl" ]; then shift; printf '%s\\n' "$*"; else builtin command "$@"; fi; }
. ${JSON.stringify(LIB)}
curl ${extra.map((e) => JSON.stringify(e)).join(' ')} ${JSON.stringify(url)}
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

test('a gateway request carries the header', T, () => {
  const argv = argvFor({ url: 'https://gw.example/v1/chat' });
  assert.match(argv, /X-Internal-Key: secret-key-value-do-not-leak/);
});

test('a THIRD-PARTY request never carries the key', T, () => {
  // The whole reason this wrapper scopes by host. A blanket header would ship the shared secret to
  // every host the job talks to.
  for (const url of [
    'https://images.example/fixture.jpg',
    'https://api.github.com/repos/x/y',
    'http://localhost:9999/health',
    'https://gw.example.evil.test/v1/chat',
  ]) {
    const argv = argvFor({ url });
    assert.ok(!argv.includes(KEY), `key leaked to ${url}: ${argv}`);
    assert.ok(!argv.includes('X-Internal-Key'), `header sent to ${url}`);
  }
});

test('the URL is found wherever it sits in the arguments', T, () => {
  // Every call site orders its flags differently; matching only $1 would silently skip most of them.
  const argv = argvFor({ url: 'https://gw.example/v1/analysis/skin', extra: ['-s', '-X', 'POST', '-d', '{}'] });
  assert.match(argv, /X-Internal-Key/);
});

test('with no key configured the command is untouched', T, () => {
  const argv = argvFor({ url: 'https://gw.example/v1/chat', key: null });
  assert.ok(!argv.includes('X-Internal-Key'), argv);
  assert.match(argv, /https:\/\/gw\.example\/v1\/chat/);
});

test('an empty key is treated as absent, not sent as an empty header', T, () => {
  // An empty X-Internal-Key reads as `bad_key` at the gateway rather than `missing_key`, which is a
  // worse signal during the observe-mode measurement.
  const argv = argvFor({ url: 'https://gw.example/v1/chat', key: '' });
  assert.ok(!argv.includes('X-Internal-Key'), argv);
});

test('every smoke that defaults BASE to the gateway sources the wrapper', T, () => {
  // The wiring, not the wrapper. A smoke that forgets to source it 401s the release gate at the flip.
  const fs = require('node:fs');
  const dir = path.join(__dirname, '..', 'scripts');
  const smokes = fs.readdirSync(dir).filter((f) => /^smoke_.*\.sh$/.test(f));
  const targeting = smokes.filter((f) =>
    /BASE="\$\{BASE:-https:\/\/pivota-agent-production/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.ok(targeting.length >= 4, `expected the known gateway smokes, found ${targeting.length}`);
  for (const f of targeting) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(src, /lib\/aurora_surface_auth\.sh/, `${f} does not source the wrapper`);
  }
});
