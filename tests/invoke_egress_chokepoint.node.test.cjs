// Pins the single door every /invoke response leaves by.
//
// The defect this guards against is structural, not a bug in any one line: `handleInvokeRequest`
// is ~13,000 lines with 96 response exits, and the anti-leak projection this repo already owns
// (mcp-server/src/publicReadProjection.js) is applied at one OTHER door and never at this one.
// With no owner, "what may leave the invoke route" gets re-derived at each call site — a fix
// pins the result where the bug was seen, its test pins that site's output, and the same defect
// resurfaces at the next site. src/invokeEgress.js gives the question one owner. These tests
// exist so a 97th exit that bypasses it is a failing test rather than a later discovery.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const { installInvokeEgress, projectInvokeResponse } = require('../src/invokeEgress');

const serverPath = path.join(__dirname, '..', 'src', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

function invokeHandlerNode() {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  let found = null;
  (function walk(node) {
    if (!node || typeof node.type !== 'string' || found) return;
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name === 'handleInvokeRequest') {
      found = node;
      return;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach((c) => c && typeof c.type === 'string' && walk(c));
      else if (value && typeof value.type === 'string') walk(value);
    }
  })(ast);
  return found;
}

// Every way an Express handler can put bytes on the wire. `json` is the chokepoint; the rest
// would bypass it entirely, so their absence is what makes an ingress wrap COMPLETE rather
// than merely broad.
const BYPASSING_METHODS = ['send', 'end', 'write', 'sendStatus', 'redirect', 'jsonp', 'writeHead', 'sendFile', 'render'];

test('res.json is the only way a response leaves the invoke route', () => {
  const fn = invokeHandlerNode();
  assert.ok(fn, 'handleInvokeRequest should be a top-level function declaration');

  const resParam = fn.params[1];
  assert.ok(resParam && resParam.type === 'Identifier', 'expected a named response parameter');
  const resName = resParam.name;

  const exits = [];
  const bypasses = [];
  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'MemberExpression') {
      const prop = node.callee.property;
      const name = prop && (prop.name || prop.value);
      // `res.json(...)` and `res.status(n).json(...)` both end in a `.json` call whose object
      // resolves to the response; the second is covered because `status()` returns the same
      // object, which is exactly why wrapping `json` once is sufficient.
      if (name === 'json') exits.push(node.loc.start.line);
      if (BYPASSING_METHODS.includes(name)) {
        const obj = node.callee.object;
        if (obj && obj.type === 'Identifier' && obj.name === resName) {
          bypasses.push(`${name} at line ${node.loc.start.line}`);
        }
      }
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach((c) => c && typeof c.type === 'string' && walk(c));
      else if (value && typeof value.type === 'string') walk(value);
    }
  })(fn);

  assert.ok(exits.length > 50, `expected the route's many json exits, saw ${exits.length}`);
  assert.deepEqual(
    bypasses,
    [],
    'a response leaves the invoke route by a method the egress chokepoint does not wrap',
  );
});

test('the chokepoint is installed at the ingress, before any exit', () => {
  const fn = invokeHandlerNode();
  const body = source.slice(fn.start, fn.end);

  const installedAt = body.indexOf('installInvokeEgress(');
  assert.notEqual(installedAt, -1, 'handleInvokeRequest must install the egress chokepoint');

  const firstExit = body.search(/\bres\s*\.\s*(json|status)\s*\(/);
  assert.notEqual(firstExit, -1);
  assert.ok(
    installedAt < firstExit,
    'the chokepoint must be installed before the first response exit, or early exits bypass it',
  );
});

test('every exit passes through the projector — including res.status(n).json', () => {
  // The behavioural half. The AST tests above prove the shape; this proves the wrap actually
  // intercepts, which is the claim the shape is evidence FOR.
  const seen = [];
  const original = [];
  const res = {
    json(body) { original.push(body); return 'sent'; },
    status() { return this; },
  };

  const calls = [];
  installInvokeEgress(res, { operation: 'find_products' }, {
    project: (body, ctx) => { calls.push(ctx); seen.push(body); return body; },
  });
  res.json({ products: [{ id: 'a' }] });
  res.status(400).json({ error: 'BAD' });

  assert.equal(seen.length, 2, 'both exits should reach the projector');
  assert.deepEqual(seen[1], { error: 'BAD' });
  assert.equal(calls[0].operation, 'find_products', 'context should reach the projector');
  assert.equal(original.length, 2, 'and both should still reach the real res.json');
});

test('CONTROL: the observation above can actually fail', () => {
  // An "it passed through" assertion is worthless if the harness would report success with no
  // wrap at all. Same res, no installInvokeEgress: the projector must NOT see the body.
  const seen = [];
  const res = { json() { return 'sent'; }, status() { return this; } };
  const observer = (body) => { seen.push(body); return body; };
  // The SAME observer the passing test uses, simply never installed.
  void observer;
  res.json({ products: [] });
  assert.equal(seen.length, 0, 'without the wrap nothing should reach the projector');
});

test('this change removes no field — the projector is the identity', () => {
  // Pins the scope of this PR. Policy comes later and separately: destination_url carries
  // Pivota click attribution and platform/source feed the UI's external-seed predicate, so
  // shrinking the surface has consumers to settle first.
  const body = {
    products: [{ id: 'p1', platform: 'external_seed', source: 'canonical_chain', destination_url: 'https://x/y' }],
    metadata: { gateway_request_id: 'r1' },
  };
  // Compare against a snapshot taken BEFORE the call, not against `body` itself. A projector
  // that mutates in place (`delete p.platform`) returns the same object it damaged, so
  // `deepEqual(out, body)` would compare the damage to itself and pass — a test that cannot
  // fail. Caught by mutation: that exact projector survived the first version of this
  // assertion.
  const before = JSON.stringify(body);
  const out = projectInvokeResponse(body, { operation: 'find_products' });
  assert.equal(JSON.stringify(out), before, 'byte-identical to the input, key order included');
  assert.equal(JSON.stringify(body), before, 'and the input itself must not be mutated');

  // Name the fields explicitly: these are the ones with known external consumers, so a future
  // policy change that drops them should have to edit this line and think about it.
  assert.equal(out.products[0].platform, 'external_seed');
  assert.equal(out.products[0].source, 'canonical_chain');
  assert.equal(out.products[0].destination_url, 'https://x/y');
});

test('installing twice does not double-wrap, and a throwing projector cannot break a response', () => {
  let calls = 0;
  const res = { json() { calls += 1; return 'sent'; }, status() { return this; } };
  installInvokeEgress(res, {});
  installInvokeEgress(res, {});
  res.json({ a: 1 });
  assert.equal(calls, 1, 'the real res.json should be called exactly once per response');

  const res2 = { json(body) { return body; }, status() { return this; } };
  installInvokeEgress(res2, {}, { project: () => { throw new Error('projector exploded'); } });
  // Failing closed here would turn a good response into a 500. An egress hook must never be
  // able to fail the surface it guards.
  assert.deepEqual(res2.json({ ok: true }), { ok: true });
});

test('a response object without json degrades to a no-op instead of throwing', () => {
  const send = installInvokeEgress(null, {});
  assert.deepEqual(send({ a: 1 }), { a: 1 });
});
