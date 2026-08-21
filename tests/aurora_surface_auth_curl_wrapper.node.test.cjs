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

test('the wrapper matches a URL built from variables, not just a literal', T, () => {
  // How entry_routes and travel_plans build their URLs: "${BASE}${path}" with the path in a
  // variable. A static grep for `${BASE}/v1/` cannot see this — that is why the wiring assertions
  // below are about the MECHANISM (sources the wrapper, curl is shadowable) rather than about
  // guessing which scripts hit a guarded path.
  const script = `
set -u
BASE=${JSON.stringify('https://gw.example')}
AURORA_SURFACE_INTERNAL_KEY=${JSON.stringify(KEY)}
command() { if [ "$1" = "curl" ]; then shift; printf '%s\\n' "$*"; else builtin command "$@"; fi; }
. ${JSON.stringify(LIB)}
p="/v1/chat"; curl -sS -X POST "\${BASE}\${p}"
q="/v1/travel-plans"; curl -sS "\${BASE%/}\${q}"
`;
  const out = require('node:child_process').execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 2);
  for (const l of lines) assert.match(l, /X-Internal-Key/, l);
});

test('every smoke sources the wrapper and leaves curl shadowable', T, () => {
  // Two invariants, each encoding a failure that actually happened rather than a hypothetical.
  //
  // I tried to replace this with a real end-to-end drive — stand up a server, run every smoke, assert
  // on what reaches the socket. It does not work as a unit test: the smokes gate on their own health
  // checks and jq assertions and abort before issuing a guarded request, so the run took 138s and
  // observed NOTHING. A slow vacuous test is worse than the grep it replaced. Delivery was instead
  // verified out-of-band against a real server, which is how the entry_routes miss was found.
  //
  // These two invariants are what that miss reduces to: the wrapper must be sourced, and curl must
  // remain shadowable. Both are cheap, neither can pass vacuously.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'scripts');
  const smokes = fs.readdirSync(dir).filter((f) => /^smoke_.*\.sh$/.test(f));
  assert.ok(smokes.length >= 15, `expected the smoke suite, found ${smokes.length}`);

  const sourcing = smokes.filter((f) =>
    /lib\/aurora_surface_auth\.sh/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.ok(sourcing.length >= 10, `only ${sourcing.length} smokes source the wrapper`);

  for (const f of smokes) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // An absolute CURL_BIN cannot be shadowed by a function — entry_routes looked patched and sent
    // nothing for exactly this reason.
    assert.ok(!/CURL_BIN="?\$\{CURL_BIN:-\//.test(src), `${f} pins curl to an absolute path`);
    // Any smoke that sources the wrapper must do so AFTER its base is assigned, or the host scope is
    // empty at source time.
    if (/lib\/aurora_surface_auth\.sh/.test(src)) {
      const srcIdx = src.indexOf('lib/aurora_surface_auth.sh');
      const baseIdx = src.search(/^(BASE|BASE_URL)=/m);
      assert.ok(baseIdx >= 0 && baseIdx < srcIdx, `${f} sources the wrapper before assigning its base`);
    }
  }
});

test('no smoke pins curl to an absolute path, which a function cannot shadow', T, () => {
  // The mechanism behind the entry_routes miss, pinned directly so it cannot come back in a script
  // the delivery test happens not to exercise.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'scripts');
  for (const f of fs.readdirSync(dir).filter((x) => /^smoke_.*\.sh$/.test(x))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/CURL_BIN="?\$\{CURL_BIN:-\//.test(src), `${f} pins curl to an absolute path`);
  }
});
