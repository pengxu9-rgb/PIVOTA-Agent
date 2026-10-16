'use strict';

// The PDP live-refresh token: the ONLY thing pdp_live_read trusts. HMAC-SHA256 over the received claims,
// constant time; a previous secret verifies (rotation) but never signs; no secret, no token.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  readRefreshSecrets,
  signRefreshToken,
  tokenTtlSeconds,
  verifyRefreshToken,
  MAC_CONTEXT,
} = require('../src/services/pdpLiveRefreshToken');

const SECRET = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const NOW = 1_790_000_000;

function claims(extra = {}) {
  return {
    v: 1,
    op: 'pdp_live_read',
    pid: 'ext_lsm',
    mid: 'merch_obs_laneige',
    lid: 'ext_lsm',
    h: 'us.laneige.com',
    hd: 'lip-sleeping-mask',
    m: 'US',
    c: 'USD',
    ids: ['48087970185268', '31760703160372'],
    iat: NOW,
    exp: NOW + 86400,
    ...extra,
  };
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verify = (token, secrets = [SECRET], nowSec = NOW + 10) => verifyRefreshToken(token, { secrets, nowSec });

test('round trip: the claims come back exactly; the token is v1.<b64url claims>.<b64url mac> with no padding', () => {
  const token = signRefreshToken(claims(), SECRET);
  assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(token.includes('='), false);
  const [, part1, part2] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(part1, 'base64url').toString('utf8')), claims());
  const mac = crypto.createHmac('sha256', SECRET).update(MAC_CONTEXT + part1).digest();
  assert.equal(part2, b64url(mac), 'HMAC-SHA256(secret, "pdp_live_refresh.v1." + part1)');
  const r = verify(token);
  assert.equal(r.ok, true);
  assert.deepEqual(r.claims, claims());
});

test('tampering with ANY claim fails the MAC (re-encoded with the original signature)', () => {
  const token = signRefreshToken(claims(), SECRET);
  const mac = token.split('.')[2];
  const tampered = {
    pid: 'ext_other', mid: 'merch_other', lid: 'x', h: 'evil.example.com', hd: 'other', m: 'SG', c: 'SGD',
    ids: ['48087970185268', '99999999'], iat: NOW + 1, exp: NOW + 999999, v: 2, op: 'get_offers',
  };
  for (const [key, value] of Object.entries(tampered)) {
    const forged = `v1.${b64url(JSON.stringify(claims({ [key]: value })))}.${mac}`;
    assert.deepEqual(verify(forged), { ok: false, error: 'bad_mac' }, key);
  }
  // One flipped character of the mac.
  const flipped = token.slice(0, -2) + (token.at(-2) === 'A' ? 'B' : 'A') + token.at(-1);
  assert.equal(verify(flipped).ok, false);
});

test('a wrong secret fails; the PREVIOUS secret verifies (rotation) but nothing signs without the current one', () => {
  const token = signRefreshToken(claims(), SECRET);
  assert.deepEqual(verify(token, [OTHER]), { ok: false, error: 'bad_mac' });
  assert.equal(verify(token, [OTHER, SECRET]).ok, true, 'signed with what is now the previous secret');
  assert.equal(verify(token, ['', SECRET]).ok, true);
  assert.deepEqual(verify(token, []), { ok: false, error: 'bad_mac' });
  assert.deepEqual(verify(token, ['short']), { ok: false, error: 'bad_mac' }, 'a secret under 32 bytes is no secret');
});

test('expiry: a signed token past exp is `expired` (with its claims); one second before is fine', () => {
  const token = signRefreshToken(claims(), SECRET);
  assert.equal(verify(token, [SECRET], NOW + 86399).ok, true);
  const r = verify(token, [SECRET], NOW + 86400);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'expired');
  assert.equal(r.claims.pid, 'ext_lsm');
  // A forged token is never reported as merely expired.
  const forged = signRefreshToken(claims(), OTHER);
  assert.equal(verify(forged, [SECRET], NOW + 999999).error, 'bad_mac');
});

test('a token issued under a LONGER lifetime than the current TTL is expired: lowering the TTL shortens old tokens', () => {
  const token = signRefreshToken(claims({ exp: NOW + 86400 }), SECRET); // a day, issued under the old default
  assert.equal(verifyRefreshToken(token, { secrets: [SECRET], nowSec: NOW + 10, maxTtlS: 86400 }).ok, true);
  const r = verifyRefreshToken(token, { secrets: [SECRET], nowSec: NOW + 10, maxTtlS: 21600 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'expired');
  const sixHours = signRefreshToken(claims({ exp: NOW + 21600 }), SECRET);
  assert.equal(verifyRefreshToken(sixHours, { secrets: [SECRET], nowSec: NOW + 10, maxTtlS: 21600 }).ok, true, 'exactly the TTL is fine');
  // A forged long token is still bad_mac, not expired.
  assert.equal(verifyRefreshToken(signRefreshToken(claims(), OTHER), { secrets: [SECRET], nowSec: NOW, maxTtlS: 3600 }).error, 'bad_mac');
});

test('malformed tokens are rejected before anything inside them is read', () => {
  const good = signRefreshToken(claims(), SECRET);
  const [, part1, part2] = good.split('.');
  const cases = [
    undefined, null, 42, {}, '', 'v1', 'v1..', `v2.${part1}.${part2}`, `v1.${part1}`, `v1.${part1}.${part2}.x`,
    `v1.${part1}.${part2}=`, `v1.${part1}+.${part2}`, `v1.${part1}.${part2.slice(1)}`, 'x'.repeat(5000),
    ` ${good}`,
  ];
  for (const t of cases) assert.equal(verify(t).error, 'malformed', String(t).slice(0, 40));
  // Signed, but not a claims object we issue: still malformed (only reachable with the secret).
  for (const bad of [
    { ...claims(), ids: [] }, { ...claims(), ids: Array.from({ length: 31 }, (_, i) => String(1000 + i)) },
    { ...claims(), ids: ['abc'] }, { ...claims(), ids: ['1', '1'] }, { ...claims(), m: 'us' }, { ...claims(), c: 'usd' },
    { ...claims(), exp: NOW }, { ...claims(), pid: '' }, { ...claims(), lid: 5 }, { ...claims(), op: 'x' },
  ]) {
    assert.equal(verify(signRefreshToken(bad, SECRET)).error, 'malformed', JSON.stringify(bad).slice(0, 80));
  }
  const notJson = `v1.${b64url('not json')}.${b64url(crypto.createHmac('sha256', SECRET).update(MAC_CONTEXT + b64url('not json')).digest())}`;
  assert.equal(verify(notJson).error, 'malformed');
});

test('no secret means no token; secrets and TTL read from env with their bounds', () => {
  assert.equal(signRefreshToken(claims(), ''), null);
  assert.equal(signRefreshToken(claims(), 'x'.repeat(31)), null, 'under 32 bytes');
  assert.ok(signRefreshToken(claims(), `  ${'x'.repeat(32)}  `));
  assert.deepEqual(readRefreshSecrets({}), { current: '', previous: '' });
  assert.deepEqual(
    readRefreshSecrets({ UCP_LIVE_PDP_REFRESH_SECRET: ` ${SECRET} `, UCP_LIVE_PDP_REFRESH_SECRET_PREVIOUS: 'short' }),
    { current: SECRET, previous: '' },
  );
  assert.equal(tokenTtlSeconds({}), 21600, 'default 6 h');
  assert.equal(tokenTtlSeconds({ UCP_LIVE_PDP_REFRESH_TOKEN_TTL_S: '60' }), 3600);
  assert.equal(tokenTtlSeconds({ UCP_LIVE_PDP_REFRESH_TOKEN_TTL_S: '99999999' }), 604800);
  assert.equal(tokenTtlSeconds({ UCP_LIVE_PDP_REFRESH_TOKEN_TTL_S: '7200' }), 7200);
  assert.equal(tokenTtlSeconds({ UCP_LIVE_PDP_REFRESH_TOKEN_TTL_S: 'soon' }), 21600);
  assert.equal(tokenTtlSeconds({ UCP_LIVE_PDP_REFRESH_TOKEN_TTL_S: '86400' }), 86400);
});
