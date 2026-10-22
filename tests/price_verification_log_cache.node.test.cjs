'use strict';

// THE READ CACHES ON (COMMERCE_READ_CACHE_ENABLED, PUBLIC_READ_CACHE_ENABLED): a replay writes its line, counted
// from the entry it replays, and none of its prices is live.
//
// A file of its own because the caches are built when the surfaces are, from the env at that moment
// (tests/_support/priceLogDoors.cjs; the golden and fixture files run with both caches off). `Date` is frozen, so
// an entry never expires here: the second identical call is always a hit.
//
// Pinned:
//   - commerce (/mcp, /ucp/mcp): the miss and the hit each write one line; the hit says cache_hit true and
//     mcp_read_cache_replay, waited for nothing, and its fresh merchant answers are `recent`, never `live`. The
//     facts are read from the cached value on every call, so an entry stored while the flag was OFF is counted
//     the moment it is on.
//   - public (/public/mcp): its facts are computed with the answer and cached with it, so an entry stored while
//     the flag was off replays with NO line (priceVerificationLog: FLIPPING THE FLAG ON); one stored while on
//     replays with its line.
//   - the answer is byte-identical: miss and hit, flag off and on, and equal to the answer captured before the
//     log existed (tests/fixtures/price_verification_log/door_answers.json, cache off): a facts hook that
//     changed the value it reads would change the cache ENTRY, which miss-vs-hit alone cannot see.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { createPriceLogDoors, rpc, AGENT_META, maskIds } = require('./_support/priceLogDoors.cjs');

const doors = createPriceLogDoors({ port: 3996, env: { COMMERCE_READ_CACHE_ENABLED: '1', PUBLIC_READ_CACHE_ENABLED: '1' } });
const { app } = doors;

test.before(() => doors.start(test.mock.timers));
test.after(() => doors.stop(test.mock.timers));

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'price_verification_log', 'door_answers.json'), 'utf8'));

const served = (r) => r.lines.filter((l) => l.event === 'price_verification_served');
const counts = (l) => ({ live: l.live, recent: l.recent, stored: l.stored, verified_count: l.verified_count, total: l.total });
const mcpSearch = (query) => () => supertest(app).post('/mcp').send(rpc('search_catalog', { query, market: 'US' }));
const ucpSearch = (query) => () => supertest(app).post('/ucp/mcp').send(rpc('search_catalog', { meta: AGENT_META, catalog: { query } }));
const publicSearch = (query) => () => supertest(app).post('/public/mcp').send(rpc('search_catalog', { query }));

test('/mcp: the miss and the replay each write one line; the replay is never live and waited for nothing', async () => {
  const miss = await doors.send(mcpSearch('cache probe one'), { flag: true });
  const hit = await doors.send(mcpSearch('cache probe one'), { flag: true });
  assert.equal(miss.status, 200);
  assert.equal(maskIds(hit.text), maskIds(miss.text), 'a replay is the answer the miss gave');
  assert.equal(miss.headers.length, 1, 'the miss reached the search lane');
  assert.equal(hit.headers.length, 0, 'the hit did not');

  const [m, ...mMore] = served(miss);
  assert.equal(mMore.length, 0);
  assert.equal(m.cache_hit, false);
  assert.deepEqual(counts(m), { live: 2, recent: 2, stored: 3, verified_count: 4, total: 7 });

  const [h, ...hMore] = served(hit);
  assert.equal(hMore.length, 0, 'one line for the replay');
  assert.equal(h.door, 'mcp');
  assert.equal(h.cache_hit, true);
  assert.equal(h.skipped_reason, 'mcp_read_cache_replay');
  assert.equal(h.added_ms, 0);
  assert.deepEqual(counts(h), { live: 0, recent: 4, stored: 3, verified_count: 4, total: 7 },
    'the two answers stamped NOW are replayed: recent, not live');
});

test('/ucp/mcp: a replay counts only the rows the UCP shaper publishes', async () => {
  const miss = await doors.send(ucpSearch('cache probe two'), { flag: true });
  const hit = await doors.send(ucpSearch('cache probe two'), { flag: true });
  assert.equal(maskIds(hit.text), maskIds(miss.text));
  const [m] = served(miss);
  const [h, ...more] = served(hit);
  assert.equal(more.length, 0);
  assert.equal(m.door, 'ucp_mcp');
  assert.deepEqual(counts(m), { live: 1, recent: 1, stored: 2, verified_count: 2, total: 4 });
  assert.equal(h.door, 'ucp_mcp');
  assert.equal(h.cache_hit, true);
  assert.equal(h.skipped_reason, 'mcp_read_cache_replay');
  assert.deepEqual(counts(h), { live: 0, recent: 2, stored: 2, verified_count: 2, total: 4 });
});

test('commerce: an entry stored while the flag was OFF is counted as soon as it is on', async () => {
  const off = await doors.send(mcpSearch('cache probe three'), { flag: false });
  const on = await doors.send(mcpSearch('cache probe three'), { flag: true });
  assert.deepEqual(served(off), []);
  assert.equal(maskIds(on.text), maskIds(off.text));
  assert.equal(on.headers.length, 0, 'served from the entry the off call stored');
  const [h, ...more] = served(on);
  assert.equal(more.length, 0);
  assert.equal(h.cache_hit, true);
  assert.deepEqual(counts(h), { live: 0, recent: 4, stored: 3, verified_count: 4, total: 7 });
});

test('/public/mcp: an entry stored while off replays with no line; one stored while on replays with its line', async () => {
  const off = await doors.send(publicSearch('cache probe four'), { flag: false });
  const onReplayOfOff = await doors.send(publicSearch('cache probe four'), { flag: true });
  assert.equal(maskIds(onReplayOfOff.text), maskIds(off.text));
  assert.equal(onReplayOfOff.headers.length, 0, 'a replay');
  assert.deepEqual(served(onReplayOfOff), [], 'its facts were never computed: the documented gap after the flip');

  const miss = await doors.send(publicSearch('cache probe five'), { flag: true });
  const hit = await doors.send(publicSearch('cache probe five'), { flag: true });
  assert.equal(maskIds(hit.text), maskIds(miss.text));
  const [m] = served(miss);
  const [h, ...more] = served(hit);
  assert.equal(more.length, 0);
  assert.equal(m.cache_hit, false);
  assert.deepEqual(counts(m), { live: 1, recent: 1, stored: 2, verified_count: 2, total: 4 });
  assert.equal(h.door, 'public_mcp');
  assert.equal(h.cache_hit, true);
  assert.equal(h.skipped_reason, 'mcp_read_cache_replay');
  assert.deepEqual(counts(h), { live: 0, recent: 2, stored: 2, verified_count: 2, total: 4 });
});

for (const name of ['mcp_search', 'ucp_search', 'public_search']) {
  test(`${name} with the cache on: the miss and the replay are the pre-log answer, flag off and on`, async () => {
    const want = FIXTURE.cases[name].text;
    const missOff = await doors.send(doors.CASES[name], { flag: false });
    assert.equal(missOff.headers.length, 1, 'a miss');
    const hitOn = await doors.send(doors.CASES[name], { flag: true });
    const hitOff = await doors.send(doors.CASES[name], { flag: false });
    assert.equal(hitOn.headers.length + hitOff.headers.length, 0, 'replays');
    for (const [label, r] of [['miss, off', missOff], ['replay, on', hitOn], ['replay, off', hitOff]]) {
      assert.equal(maskIds(r.text), want, `${name} ${label}: the pre-log answer, byte for byte`);
    }
  });
}
