'use strict';

// Every address that serves the invoke handler is the same route.
//
// WHY THIS FILE EXISTS. The invoke handler is served at two addresses, the shop address and a
// backward-compatible alias. Until 2026-11-12 the alias was registered by its own line, and that line gave it
// the invoke handler without the strict checkout route in front. With strict checkout on, a money operation
// sent to the alias was therefore answered by the legacy handler: no verified buyer was required, no kernel
// quote or charge-once lock was involved, and neither the submit_payment switch nor the confirm_payment block
// applied.
//
// The addresses are now one list registered by one loop (src/server.js INVOKE_ROUTES / registerInvokeRoutes).
// These tests are what keeps it that way:
//   1. the app's route table: every address serving the handler passes exactly what the shop address passes;
//   2. the source: nothing but the shared loop reaches the handler or the two registration functions;
//   3. each of those two scans refuses a wrong registration (the real registration function, used wrongly);
//   4. behaviour: for every operation, strict state and credential class, the alias gives the shop address's
//      answer and sends the shop address's outbound requests;
//   5. every switch that stops an operation on the shop address stops it on the alias, with nothing sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  STRICT_HANDLER,
  INVOKE_HANDLER,
  invokeAddresses,
  handlerChain,
  invokeRouteWiringProblems,
  invokeRegistrationSourceProblems,
} = require('./_support/invokeRouteWiring.cjs');

process.env.NODE_ENV = 'test';
const app = require('../src/server');
const { OperationEnum } = require('../src/schema');
const { INVOKE_ROUTES, registerCommerceStrictInvokeRoute, registerExternalInvokeRoute } = app._debug.__invokeRoutes;

const SHOP = '/agent/shop/v1/invoke';
const ALIAS = '/agent/creator/v1/invoke';
const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

// What a request to an invoke address passes at the route level, in order. `priceContext` is the handler
// priceContextMiddleware returns.
const EXPECTED_ROUTE_HANDLERS = [
  `post:${STRICT_HANDLER}`,
  'post:priceContext',
  'post:authenticateExternalInvokeRoute',
  `post:${INVOKE_HANDLER}`,
];
const wiringProblems = () => invokeRouteWiringProblems(app, { routes: INVOKE_ROUTES, expectedRouteHandlers: EXPECTED_ROUTE_HANDLERS });
// Read before any test below registers a wrong address on this app.
const PROBLEMS_AS_SHIPPED = wiringProblems();
const ADDRESSES_AS_SHIPPED = invokeAddresses(app);

// ---- 1. the route table --------------------------------------------------------------------------------

test('the shared list is the shop address and its alias, and they are the only addresses serving the handler', () => {
  assert.deepEqual(INVOKE_ROUTES.map((r) => r.path), [SHOP, ALIAS]);
  assert.deepEqual([...ADDRESSES_AS_SHIPPED].sort(), [ALIAS, SHOP].sort());
  assert.ok(Object.isFrozen(INVOKE_ROUTES) && INVOKE_ROUTES.every(Object.isFrozen), 'the list cannot be changed after load');
});

test('every address serving the invoke handler passes exactly what the shop address passes, in the same order', () => {
  assert.deepEqual(PROBLEMS_AS_SHIPPED, []);
  // Not vacuous: the chain is the global middleware plus the four route handlers, strict first.
  const chain = handlerChain(app, ALIAS);
  assert.ok(chain.filter((h) => h.kind === 'use').length >= 5, 'the scan sees the app-level middleware');
  assert.deepEqual(chain.filter((h) => h.kind === 'route').map((h) => `${h.method}:${h.name}`), EXPECTED_ROUTE_HANDLERS);
});

test('an entry differs from another only in its client-channel label', () => {
  for (const route of INVOKE_ROUTES) assert.deepEqual(Object.keys(route).sort(), ['clientChannel', 'path']);
  assert.deepEqual(INVOKE_ROUTES.map((r) => r.clientChannel), ['shop', 'creator']);
});

// ---- 2. the source -------------------------------------------------------------------------------------

test('in the source, only the shared loop reaches the invoke handler and the two registration functions', () => {
  assert.deepEqual(invokeRegistrationSourceProblems(SERVER_SOURCE), []);
});

// ---- 3. each scan refuses a wrong registration ---------------------------------------------------------

test('router scan: an address given the invoke handler without the strict route is refused', () => {
  registerExternalInvokeRoute('/agent/half-wired/v1/invoke', 'placeholder');
  const problems = wiringProblems().filter((p) => p.includes('/agent/half-wired/v1/invoke'));
  assert.ok(problems.some((p) => p.includes('is not in the shared list')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes(`missing [post:${STRICT_HANDLER}`)), problems.join('\n'));
});

test('router scan: an address wired in full, but outside the shared list, is refused', () => {
  registerCommerceStrictInvokeRoute('/agent/outside-list/v1/invoke', 'placeholder');
  registerExternalInvokeRoute('/agent/outside-list/v1/invoke', 'placeholder');
  const problems = wiringProblems().filter((p) => p.includes('/agent/outside-list/v1/invoke'));
  assert.deepEqual(problems, [
    '/agent/outside-list/v1/invoke serves the invoke handler but is not in the shared list',
    // Registered here, it also sits behind the app-level handlers that follow the listed addresses.
    `/agent/outside-list/v1/invoke does not pass what ${SHOP} passes: missing [], extra [] (same handlers, different order)`,
  ]);
});

test('router scan: the strict route registered after the invoke handler is refused', () => {
  registerExternalInvokeRoute('/agent/wrong-order/v1/invoke', 'placeholder');
  registerCommerceStrictInvokeRoute('/agent/wrong-order/v1/invoke', 'placeholder');
  const problems = wiringProblems().filter((p) => p.includes('/agent/wrong-order/v1/invoke'));
  assert.ok(problems.some((p) => p.includes('route handlers are [post:priceContext')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('same handlers, different order')), problems.join('\n'));
});

test('router scan: a handler in front of one listed address only is refused', () => {
  // Registered last, so it changes nothing a request meets; the scan must still see the chains differ.
  app.post(ALIAS, function aliasOnlyHandler(req, res, next) { next(); });
  const problems = wiringProblems().filter((p) => p.startsWith(ALIAS));
  assert.ok(problems.some((p) => p.includes('post:aliasOnlyHandler')), problems.join('\n'));
});

const withLine = (line) => `${SERVER_SOURCE}\n${line}\n`;
const WRONG_SOURCES = [
  {
    name: 'a third address registered by its own line',
    source: withLine("registerExternalInvokeRoute('/agent/third/v1/invoke', 'third');"),
    expect: /registerExternalInvokeRoute is called outside the loop/,
  },
  {
    name: 'a third address registered by both functions, outside the loop',
    source: withLine("registerCommerceStrictInvokeRoute('/agent/third/v1/invoke', 'third');\nregisterExternalInvokeRoute('/agent/third/v1/invoke', 'third');"),
    expect: /registerCommerceStrictInvokeRoute is called 2 times/,
  },
  {
    name: 'a route that calls the handler itself',
    source: withLine("app.post('/agent/third/v1/invoke', (req, res) => handleInvokeRequest(req, res, {}));"),
    expect: /handleInvokeRequest is called from the top level/,
  },
  {
    name: 'the handler called from another function',
    source: withLine('function serveThirdAddress(req, res) { return handleInvokeRequest(req, res, {}); }'),
    expect: /handleInvokeRequest is called from serveThirdAddress/,
  },
  {
    name: 'the handler handed around under another name',
    source: withLine('const serveInvoke = handleInvokeRequest;'),
    expect: /handleInvokeRequest is referenced without being called/,
  },
  {
    name: 'a registration function handed around under another name',
    source: withLine('const registerQuietly = registerExternalInvokeRoute;'),
    expect: /registerExternalInvokeRoute is referenced without being called/,
  },
  {
    name: 'the loop registering the invoke handler before the strict route',
    source: SERVER_SOURCE.replace(
      /(\n\s*registerCommerceStrictInvokeRoute\(path, clientChannel\);)(\n\s*registerExternalInvokeRoute\(path, clientChannel\);)/,
      '$2$1',
    ),
    expect: /registered before registerCommerceStrictInvokeRoute/,
  },
  {
    name: 'the loop without the strict route',
    source: SERVER_SOURCE.replace(/\n\s*registerCommerceStrictInvokeRoute\(path, clientChannel\);/, ''),
    expect: /registerCommerceStrictInvokeRoute is called 0 times/,
  },
  {
    name: 'the strict route registered for the first entry only',
    source: SERVER_SOURCE.replace(
      /\n(\s*)registerCommerceStrictInvokeRoute\(path, clientChannel\);/,
      "\n$1if (clientChannel === 'shop') registerCommerceStrictInvokeRoute(path, clientChannel);",
    ),
    expect: /registerCommerceStrictInvokeRoute is not an unconditional statement of the loop/,
  },
  {
    name: 'the shared loop never run',
    source: SERVER_SOURCE.replace(/\nregisterInvokeRoutes\(\);/, ''),
    expect: /registerInvokeRoutes is called 0 times/,
  },
  {
    name: 'the shared loop run from inside another function',
    source: SERVER_SOURCE.replace(/\nregisterInvokeRoutes\(\);/, '\nfunction later() { registerInvokeRoutes(); }'),
    expect: /registerInvokeRoutes must be called from the top level/,
  },
];

for (const wrong of WRONG_SOURCES) {
  test(`source scan refuses: ${wrong.name}`, () => {
    assert.notEqual(wrong.source, SERVER_SOURCE, 'the edit applied');
    const problems = invokeRegistrationSourceProblems(wrong.source);
    assert.ok(problems.some((p) => wrong.expect.test(p)), `expected ${wrong.expect}, got:\n${problems.join('\n') || '(no problems)'}`);
  });
}

// ---- 4 and 5. behaviour --------------------------------------------------------------------------------

const CHILD = path.join(__dirname, '_support', 'invokeAliasParityChild.cjs');
const MONEY_OPERATIONS = ['preview_quote', 'create_order', 'submit_payment', 'request_after_sales', 'confirm_payment'];
const INTROSPECT_PATH = '/agent/internal/auth/introspect';

function runChild(address, outFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, address, outFile], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${address}: child exited ${code}\n${stderr}`));
      return resolve(JSON.parse(fs.readFileSync(outFile, 'utf8')));
    });
  });
}

// CLOCK AND RANDOM MEMBERS, the only things removed before two answers are compared:
//   - a UUID anywhere in a string (request ids, kernel quote ids `q_<uuid>`);
//   - an ISO timestamp anywhere in a string;
//   - a number under a member whose name says it is a duration (`*_ms`, `phases`, `*timings`);
//   - a kernel audit record's `ts` (epoch milliseconds);
//   - the port of this process's own loopback listener.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;
const DURATION_MEMBER = /(_ms$|^phases$|timings?$)/i;

function normalise(value, key = null, underDuration = false) {
  if (Array.isArray(value)) return value.map((v) => normalise(v, key, underDuration));
  if (value && typeof value === 'object') {
    const duration = underDuration || (key !== null && DURATION_MEMBER.test(key));
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, normalise(value[k], k, duration)]));
  }
  if (typeof value === 'string') {
    return value.replace(UUID, '<uuid>').replace(ISO_TIMESTAMP, '<timestamp>').replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>');
  }
  if (typeof value === 'number' && (underDuration || (key !== null && DURATION_MEMBER.test(key)))) return '<duration>';
  if (typeof value === 'number' && key === 'ts') return '<epoch>';
  return value;
}

function flatten(value, prefix = '', out = {}) {
  if (Array.isArray(value)) {
    if (!value.length) out[prefix] = '[]';
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    if (!Object.keys(value).length) out[prefix] = '{}';
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = value;
  }
  return out;
}

// THE CREATOR-ONLY LABELS: [member, the shop address's value, the alias's value]. The alias differs from the
// shop address in its client-channel label and in nothing else; these are the places the label shows. Any
// other difference between the two addresses fails the test.
const ALIAS_LABELS = [
  // The legacy handler's backend request context (search, quote).
  [/^outbound\[\d+\]\.body\.request_context\.channel$/, 'shopping-agent-ui', 'creator_agent'],
  // The search answer's route authority.
  [/^body(\.metadata)?\.route_authority$/, 'shopping_agent', 'creator_agent'],
];

function differences(shop, alias) {
  const a = flatten(normalise(shop));
  const b = flatten(normalise(alias));
  const out = [];
  for (const member of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const [va, vb] = [member in a ? a[member] : '<absent>', member in b ? b[member] : '<absent>'];
    if (va === vb) continue;
    if (ALIAS_LABELS.some(([pattern, shopValue, aliasValue]) => pattern.test(member) && va === shopValue && vb === aliasValue)) continue;
    out.push(`${member}: shop ${JSON.stringify(va)} / alias ${JSON.stringify(vb)}`);
  }
  return out;
}

const comparable = (r) => ({ status: r.status, body: r.body, outbound: r.outbound, audits: r.audits });
const pastAuth = (r) => r.outbound.filter((o) => o.path.split('?')[0] !== INTROSPECT_PATH);
const errorCode = (r) => (r.body && typeof r.body === 'object' ? r.body.code || r.body.error : null);

let runs = null;
test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoke-alias-parity-'));
  try {
    const [shop, alias] = await Promise.all([
      runChild(SHOP, path.join(dir, 'shop.json')),
      runChild(ALIAS, path.join(dir, 'alias.json')),
    ]);
    runs = { shop, alias };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the matrix covers every operation of the schema in all four strict states, and both runs are clean', () => {
  for (const run of [runs.shop, runs.alias]) {
    assert.deepEqual(run.stray, [], 'no outbound request outside a case');
    assert.deepEqual(run.stray_audits, [], 'no kernel audit record outside a case');
    for (const strict of [false, true]) {
      for (const submit of [false, true]) {
        const seen = new Set(run.results.filter((r) => r.strict === strict && r.submit_enabled === submit).map((r) => r.operation));
        for (const operation of OperationEnum.options) assert.ok(seen.has(operation), `${operation} strict=${strict} submit=${submit}`);
      }
    }
    assert.ok(run.results.every((r) => typeof r.status === 'number'), 'every case was answered');
  }
  assert.deepEqual(runs.alias.results.map((r) => r.id), runs.shop.results.map((r) => r.id));
  assert.ok(runs.shop.results.length >= 280, `matrix size ${runs.shop.results.length}`);
});

test('for every case the alias gives the shop answer and sends the shop outbound requests, labels aside', () => {
  const failures = [];
  runs.shop.results.forEach((shop, i) => {
    const diff = differences(comparable(shop), comparable(runs.alias.results[i]));
    if (diff.length) failures.push(`${shop.id}\n    ${diff.slice(0, 6).join('\n    ')}`);
  });
  assert.equal(failures.length, 0, `${failures.length} case(s) differ:\n${failures.slice(0, 10).join('\n')}`);
});

test('the alias keeps its own labels: the creator channel on the legacy backend context and on a search answer', () => {
  const pick = (run, id) => run.results.find((r) => r.id === id);
  const channel = (r) => pastAuth(r).map((o) => o.body && o.body.request_context && o.body.request_context.channel);
  for (const state of ['strict=0,submit=0', 'strict=0,submit=1', 'strict=1,submit=0', 'strict=1,submit=1']) {
    assert.deepEqual(channel(pick(runs.alias, `${state}|find_products|key_identity`)), ['creator_agent'], state);
    assert.deepEqual(channel(pick(runs.shop, `${state}|find_products|key_identity`)), ['shopping-agent-ui'], state);
    assert.equal(pick(runs.alias, `${state}|find_products_multi|key_identity`).body.route_authority, 'creator_agent', state);
    assert.equal(pick(runs.shop, `${state}|find_products_multi|key_identity`).body.route_authority, 'shopping_agent', state);
  }
  // With strict off the legacy quote carries the label too, as it did before.
  assert.deepEqual(channel(pick(runs.alias, 'strict=0,submit=0|flow:preview_quote')), ['creator_agent']);
});

test('the matrix reaches the kernel, the backend and the legacy handler (the comparison is not of refusals only)', () => {
  const at = (id) => runs.alias.results.find((r) => r.id === id);
  const paths = (r) => pastAuth(r).map((o) => `${o.method} ${o.path.split('?')[0]}`);
  // Strict on: the kernel prices, orders, charges once, refunds.
  const quote = at('strict=1,submit=1|flow:preview_quote');
  assert.equal(quote.status, 200);
  assert.match(quote.body.quote_id, /^q_[0-9a-f-]{36}$/, 'a kernel quote id, not the backend quote id');
  assert.deepEqual(paths(quote), ['POST /agent/v2/quotes/preview']);
  assert.deepEqual(paths(at('strict=1,submit=1|flow:create_order')), ['POST /agent/v2/orders']);
  assert.equal(at('strict=1,submit=1|flow:submit_payment').status, 200);
  assert.deepEqual(paths(at('strict=1,submit=1|flow:submit_payment')), ['POST /agent/v2/payments/checkout-sessions']);
  assert.deepEqual(paths(at('strict=1,submit=1|flow:submit_payment(replay)')), [], 'the replay charges nothing');
  assert.deepEqual(paths(at('strict=1,submit=1|flow:request_after_sales')), ['POST /agent/v2/orders/ORD_PLACEHOLDER/refunds']);
  // Strict off: the legacy handler answers, as before.
  const legacyQuote = at('strict=0,submit=0|flow:preview_quote');
  assert.equal(legacyQuote.status, 200);
  assert.deepEqual(legacyQuote.audits, [], 'no kernel record with strict off');
  assert.deepEqual(paths(legacyQuote), ['POST /agent/v2/quotes/preview']);
});

test('strict on: every money operation on the alias is answered by the strict route', () => {
  const strictOn = runs.alias.results.filter((r) => r.strict && MONEY_OPERATIONS.includes(r.operation));
  assert.ok(strictOn.length >= 5 * 4 * 2);
  for (const r of strictOn) {
    if (r.id.endsWith('|none') || r.id.endsWith('|token')) {
      // A checkout token alone is no credential on the strict route.
      if (!(r.operation === 'submit_payment' && !r.submit_enabled)) {
        assert.equal(r.status, 401, r.id);
        assert.equal(r.body.error, 'UNAUTHORIZED', r.id);
        assert.deepEqual(r.outbound, [], r.id);
      }
      continue;
    }
    assert.ok(r.audits.length >= 1, `${r.id}: the kernel recorded the call`);
    const legacyPaths = pastAuth(r).filter((o) => /^\/agent\/v1\//.test(o.path));
    assert.deepEqual(legacyPaths, [], `${r.id}: nothing went to a legacy backend route`);
  }
});

test('strict on: a key holder with no verified buyer is refused on the alias, with nothing sent', () => {
  const cases = runs.alias.results.filter((r) => r.strict && r.submit_enabled && r.id.endsWith('|key')
    && ['preview_quote', 'create_order', 'submit_payment', 'request_after_sales'].includes(r.operation));
  assert.equal(cases.length, 5, 'four operations, and the padded spelling of submit_payment');
  for (const r of cases) {
    assert.equal(r.status, 401, r.id);
    assert.equal(errorCode(r), 'USER_AUTH_REQUIRED', r.id);
    assert.deepEqual(pastAuth(r), [], r.id);
    assert.equal(r.audits[0].event, 'user_auth_blocked', r.id);
  }
});

test('submit_payment switch off: the alias refuses submit_payment by name, before auth, with nothing sent', () => {
  const cases = runs.alias.results.filter((r) => r.strict && !r.submit_enabled && r.operation === 'submit_payment');
  // Four credential classes, the padded spelling, and the three submits of the purchase flow.
  assert.equal(cases.length, 8);
  for (const r of cases) {
    assert.equal(r.status, 405, r.id);
    assert.equal(errorCode(r), 'OPERATION_NOT_ALLOWED', r.id);
    assert.match(r.body.message, /submit_payment is disabled in strict checkout mode/, r.id);
    assert.deepEqual(r.outbound, [], `${r.id}: nothing sent, the auth service included`);
    assert.deepEqual(r.audits.map((a) => [a.event, a.detail.reason]), [['operation_blocked', 'strict_submit_payment_disabled']], r.id);
  }
});

test('submit_payment switch on: the alias no longer refuses submit_payment by that name', () => {
  const cases = runs.alias.results.filter((r) => r.strict && r.submit_enabled && r.operation === 'submit_payment');
  assert.equal(cases.length, 8);
  for (const r of cases) assert.notEqual(errorCode(r), 'OPERATION_NOT_ALLOWED', r.id);
});

test('confirm_payment block: with strict on the alias refuses confirm_payment by name, with nothing sent', () => {
  const cases = runs.alias.results.filter((r) => r.strict && r.operation === 'confirm_payment'
    && (r.id.endsWith('|key') || r.id.endsWith('|key_identity') || r.id.includes('flow:')));
  // Two credential classes and the purchase flow, in both submit_payment switch states.
  assert.equal(cases.length, 6);
  for (const r of cases) {
    assert.equal(r.status, 405, r.id);
    assert.equal(errorCode(r), 'OPERATION_NOT_ALLOWED', r.id);
    assert.match(r.body.message, /confirm_payment is disabled in strict checkout mode/, r.id);
    assert.deepEqual(pastAuth(r), [], r.id);
    assert.deepEqual(r.audits.map((a) => [a.event, a.detail.reason]), [['operation_blocked', 'legacy_confirm_payment_disabled']], r.id);
  }
});

test('strict off: neither switch applies, on either address (the legacy handler answers)', () => {
  for (const run of [runs.shop, runs.alias]) {
    const cases = run.results.filter((r) => !r.strict && MONEY_OPERATIONS.includes(r.operation));
    assert.ok(cases.length >= 5 * 4 * 2);
    for (const r of cases) {
      assert.deepEqual(r.audits, [], `${run.address} ${r.id}: no kernel record`);
      assert.notEqual(errorCode(r), 'OPERATION_NOT_ALLOWED', `${run.address} ${r.id}`);
      assert.notEqual(errorCode(r), 'USER_AUTH_REQUIRED', `${run.address} ${r.id}`);
    }
  }
});
