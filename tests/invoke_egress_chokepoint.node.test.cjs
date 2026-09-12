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
// The parser is `typescript`, not `acorn`. acorn is present in a developer's flat
// node_modules as somebody's transitive dependency and is NOT a declared dependency of this
// repo, so `require('acorn')` resolves on a laptop and throws on a CI runner — verified the
// hard way on run 34529976633. typescript is in devDependencies and is already relied on by
// tests/server_invoke_scope_guard.node.test.cjs, which passes in CI.
const ts = require('typescript');

const { installInvokeEgress, projectInvokeResponse } = require('../src/invokeEgress');

const serverPath = path.join(__dirname, '..', 'src', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

const sourceFile = ts.createSourceFile(
  'server.js',
  source,
  ts.ScriptTarget.Latest,
  /* setParentNodes */ true,
  ts.ScriptKind.JS,
);

function lineOf(node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function invokeHandlerNode() {
  let found = null;
  (function walk(node) {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === 'handleInvokeRequest') {
      found = node;
      return;
    }
    ts.forEachChild(node, walk);
  })(sourceFile);
  return found;
}

// Every way an Express handler can put bytes on the wire. `json` is the chokepoint; the rest
// would bypass it entirely, so their absence is what makes an ingress wrap COMPLETE rather
// than merely broad.
const BYPASSING_METHODS = ['send', 'end', 'write', 'sendStatus', 'redirect', 'jsonp', 'writeHead', 'sendFile', 'render'];

test('res.json is the only way a response leaves the invoke route', () => {
  const fn = invokeHandlerNode();
  assert.ok(fn, 'handleInvokeRequest should be a top-level function declaration');

  const resParam = fn.parameters[1];
  assert.ok(resParam && ts.isIdentifier(resParam.name), 'expected a named response parameter');
  const resName = resParam.name.text;

  // ALIASES. The first version of this walk only matched the literal parameter identifier, so
  // `const r = res; r.send(...)` — the most natural thing to write when a response is used a
  // lot — walked straight past it. Three such mutants survived review. Collect every local
  // name bound directly to `res` first, then treat them all as the response.
  const responseNames = new Set([resName]);
  (function collectAliases(node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer)
        && responseNames.has(node.initializer.text) && ts.isIdentifier(node.name)) {
      responseNames.add(node.name.text);
    }
    // `let r; r = res;`
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left) && ts.isIdentifier(node.right)
        && responseNames.has(node.right.text)) {
      responseNames.add(node.left.text);
    }
    ts.forEachChild(node, collectAliases);
  })(fn);
  // Two passes, because an alias may be declared after a use in source order.
  (function collectAgain(node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer)
        && responseNames.has(node.initializer.text) && ts.isIdentifier(node.name)) {
      responseNames.add(node.name.text);
    }
    ts.forEachChild(node, collectAgain);
  })(fn);

  const exits = [];
  const bypasses = [];
  (function walk(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      // `res.json(...)` and `res.status(n).json(...)` both end in a `.json` call whose object
      // resolves to the response; the second is covered because `status()` returns the same
      // object, which is exactly why wrapping `json` once is sufficient.
      const obj = node.expression.expression;
      const onResponse = ts.isIdentifier(obj) && responseNames.has(obj.text);
      // Count only json calls ON THE RESPONSE. A bare `.json(` count would also sweep in
      // `await something.json()` and inflate the floor below with calls that are not exits.
      if (name === 'json' && (onResponse || ts.isCallExpression(obj))) exits.push(lineOf(node));
      if (BYPASSING_METHODS.includes(name) && onResponse) {
        bypasses.push(`${name} at line ${lineOf(node)} (via ${obj.text})`);
      }
      // The prototype escape. `installInvokeEgress` sets an OWN property, so reaching the
      // method on the prototype — `Object.getPrototypeOf(res).json.call(res, body)` — writes
      // straight past it. Nobody does that by accident, and there is no legitimate reason to
      // take the response's prototype in this handler, so the call itself is the signal.
      if (name === 'getPrototypeOf' && ts.isIdentifier(node.expression.expression)
          && node.expression.expression.text === 'Object') {
        const [arg] = node.arguments;
        if (arg && ts.isIdentifier(arg) && responseNames.has(arg.text)) {
          bypasses.push(`Object.getPrototypeOf(${arg.text}) at line ${lineOf(node)}`);
        }
      }
    }
    ts.forEachChild(node, walk);
  })(fn);

  // A COUNT, not a floor. `> 50` would have stayed green with 46 exits deleted, so it only
  // ever asserted "the walk found the function". Pinning the number means adding or removing
  // an exit is a deliberate edit here — which is the point, since every one of them is a place
  // a response leaves. Update it when you change the route, and look at what you changed.
  // Three selected beauty-primary error exits return through the same JSON wrapper.
  assert.equal(
    exits.length,
    99,
    `expected 99 response exits in handleInvokeRequest, saw ${exits.length}`,
  );
  assert.ok(responseNames.size >= 1);
  assert.deepEqual(
    bypasses,
    [],
    'a response leaves the invoke route by a method the egress chokepoint does not wrap',
  );
});

test('the chokepoint is installed at the ingress, before any exit', () => {
  // Walks the AST rather than comparing string indexes. The string version was satisfied by a
  // COMMENT containing `installInvokeEgress(`: a mutant that moved the real call below an early
  // `res.status(400).json(...)` exit, leaving a comment behind, kept the suite green. Comments
  // and string literals are not code and must not be able to answer a question about ordering.
  const fn = invokeHandlerNode();

  let installLine = null;
  let firstExitLine = null;
  (function walk(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'installInvokeEgress') {
        const line = lineOf(node);
        if (installLine === null || line < installLine) installLine = line;
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text;
        if (name === 'json' || name === 'status') {
          const line = lineOf(node);
          if (firstExitLine === null || line < firstExitLine) firstExitLine = line;
        }
      }
    }
    ts.forEachChild(node, walk);
  })(fn);

  assert.notEqual(installLine, null, 'handleInvokeRequest must install the egress chokepoint');
  assert.notEqual(firstExitLine, null);
  assert.ok(
    installLine < firstExitLine,
    `the chokepoint is installed at line ${installLine}, after the first response exit at ` +
      `${firstExitLine} — every exit before it bypasses the door`,
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

test('CONTROL: the interception claim above can actually fail', () => {
  // The previous version of this control declared an observer, discarded it with `void`, and
  // asserted it saw nothing — `assert.equal(0, 0)`. It survived every mutant, including
  // deleting the install call outright. A control that cannot fail is worse than none: it
  // makes the test beside it look corroborated.
  //
  // This one captures the ORIGINAL res.json before installing and calls it afterwards. That is
  // the one path which genuinely bypasses the wrap, so if `installInvokeEgress` ever became a
  // no-op, the two assertions below would agree with each other and this test would fail.
  const seen = [];
  const res = { json(body) { return body; }, status() { return this; } };

  const preInstall = res.json;
  installInvokeEgress(res, {}, { project: (body) => { seen.push(body); return body; } });

  preInstall.call(res, { products: ['bypassed'] });
  assert.equal(seen.length, 0, 'the pre-install json must not reach the projector');

  res.json({ products: ['wrapped'] });
  assert.equal(seen.length, 1, 'the patched json must reach it — else the wrap is a no-op');
  assert.notEqual(res.json, preInstall, 'installing must actually replace res.json');
});

test("the projector's OUTPUT is what gets sent, not the body it was handed", () => {
  // The most valuable assertion in this file, and it was missing. Without it,
  // `return originalJson(projected)` can be refactored to `originalJson(body)` and the whole
  // suite stays green: the projector still runs, still sees everything, and its result is
  // thrown away. Once real policy lands here, that mutation silently disarms every field the
  // policy strips — in production, permanently, with the chokepoint reporting as installed.
  //
  // Caught by mutation review: that exact mutant survived the first version of this suite.
  const sent = [];
  const res = { json(body) { sent.push(body); return 'sent'; }, status() { return this; } };

  installInvokeEgress(res, {}, {
    project: (body) => ({ ...body, products: (body.products || []).map(({ secret, ...rest }) => rest) }),
  });

  res.json({ products: [{ id: 'p1', secret: 'internal' }], ok: true });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { products: [{ id: 'p1' }], ok: true });
  assert.equal('secret' in sent[0].products[0], false, 'the projection must reach the wire');
});

test('a projector that transforms conditionally is still honoured', () => {
  // A conditional leak keyed on ctx is exactly what a single-shape identity test cannot see.
  const sent = [];
  const res = { json(body) { sent.push(body); return 'sent'; }, status() { return this; } };
  installInvokeEgress(res, { operation: 'get_product' }, {
    project: (body, ctx) => (ctx.operation === 'get_product' ? { ...body, tagged: true } : body),
  });
  res.json({ id: 'x' });
  assert.deepEqual(sent[0], { id: 'x', tagged: true });
});

test('this change removes no field — the projector is the identity, for EVERY operation', () => {
  // Pins the scope of this PR. Ranges over the real operation vocabulary, not one example:
  // a projector that drops a field only when ctx.operation === 'get_product' is invisible to a
  // single-shape test, and exactly that mutant survived the first version of this assertion.
  // Policy comes later and separately — destination_url carries Pivota click attribution and
  // platform/source feed the UI's external-seed predicate, so shrinking the surface has
  // consumers to settle first.
  const { OperationEnum } = require('../src/schema');
  const operations = OperationEnum.options || OperationEnum._def.values;
  assert.ok(operations.length > 20, `expected the full operation vocabulary, saw ${operations.length}`);

  for (const operation of operations) {
    const body = {
      products: [
        {
          id: 'p1',
          platform: 'external_seed',
          source: 'canonical_chain',
          destination_url: 'https://x/y',
          external_product_id: 'eps_1',
        },
      ],
      metadata: { gateway_request_id: 'r1' },
    };
    // Snapshot BEFORE the call. A projector that mutates in place returns the object it
    // damaged, so comparing the result to `body` would compare the damage to itself and pass —
    // a test that cannot fail. That mutant survived the first version of this assertion too.
    const before = JSON.stringify(body);
    const out = projectInvokeResponse(body, { operation });

    assert.equal(JSON.stringify(out), before, `${operation}: output must be byte-identical`);
    assert.equal(JSON.stringify(body), before, `${operation}: the input must not be mutated`);

    // Named explicitly: these are the fields with known external consumers, so a future policy
    // change that drops one has to edit this line and think about it.
    for (const field of ['platform', 'source', 'destination_url', 'external_product_id']) {
      assert.ok(field in out.products[0], `${operation}: ${field} must survive`);
    }
  }
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
