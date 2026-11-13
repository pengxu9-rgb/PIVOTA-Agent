'use strict';

// Every gateway call to the backend invoke route carries a credential when one is configured.
//
// WHY THIS FILE EXISTS. Until 2026-11-12 one call did not: the review-summary fetch sent a checkout token when
// the request had one and nothing otherwise, while every neighbouring call took its credential from the shared
// builder (src/server.js buildInvokeUpstreamAuthHeaders). The fetch now sends the gateway's service credential
// from that builder. Its answer is cached and shared between callers, so it goes out on the gateway's identity
// and carries nothing derived from the caller.
//
//   1. behaviour: the three operations that reach the fetch, on both invoke addresses, driven through the real
//      handlers against a recording backend, for each caller class; the header CLASS each call carried is
//      asserted (a placeholder key's class, never a value);
//   2. no service credential configured: the fetch goes out as it did before, and one warning line says so;
//   3. the cache: its key holds no credential, and two callers share one entry;
//   4. the source: every place src/server.js builds the backend invoke URL takes its credential from the
//      shared builder, and the review fetch's credential helper is that builder and nothing hand-built.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ts = require('typescript');

const CHILD = path.join(__dirname, '_support', 'reviewFetchCredentialChild.cjs');
const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const INVOKE_PATH = '/agent/shop/v1/invoke';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const REVIEW_OPERATIONS = ['get_pdp_v2', 'get_product_feedback_v1', 'prepare_pivota_insights_coverage_v1'];
const ADDRESSES = ['shop', 'creator'];
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-agent-api-key', 'x-internal-key', 'x-checkout-token'];

function runChild(auth, service, outFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, outFile, auth, service], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`auth=${auth} service=${service}: child exited ${code}\n${stderr}`));
      return resolve(JSON.parse(fs.readFileSync(outFile, 'utf8')));
    });
  });
}

// auth=real: the key and checkout-token checks run. auth=bypass: the test-runtime bypass, the only way a
// request with no key of its own reaches the handler. service: whether the gateway's service credential is set.
const runs = {};
test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fetch-credential-'));
  try {
    const modes = [['real', 'on'], ['real', 'off'], ['bypass', 'on'], ['bypass', 'off']];
    const outputs = await Promise.all(modes.map(([auth, service]) => runChild(auth, service, path.join(dir, `${auth}_${service}.json`))));
    modes.forEach(([auth, service], i) => { runs[`${auth}/${service}`] = outputs[i]; });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const pathOf = (o) => o.path.split('?')[0];
const isReviewFetch = (o) => pathOf(o) === INVOKE_PATH && o.body && o.body.operation === 'get_review_summary';
const reviewFetches = (r) => r.outbound.filter(isReviewFetch);
const pastAuth = (r) => r.outbound.filter((o) => pathOf(o) !== INTROSPECT_PATH);
const at = (run, id) => {
  const found = run.results.find((r) => r.id === id);
  assert.ok(found, `case ${id} exists`);
  return found;
};
const credentialsOf = (o) => Object.fromEntries(CREDENTIAL_HEADERS.filter((h) => o.identity[h]).map((h) => [h, o.identity[h]]));

const SERVICE_IDENTITY = { authorization: 'service_key', 'x-api-key': 'service_key' };
const TOKEN_ALONE = { 'x-checkout-token': 'checkout_token' };

function assertNothingFromTheCaller(fetch, id) {
  assert.equal(fetch.identity['x-buyer-ref'], null, `${id}: no buyer ref on a shared read`);
  assert.equal(fetch.identity['x-agent-user-jwt'], null, `${id}: no user token on a shared read`);
  assert.deepEqual(fetch.identity.other, [], `${id}: no other x- header`);
  for (const header of CREDENTIAL_HEADERS) {
    assert.ok(!['caller_key', 'second_caller_key'].includes(fetch.identity[header]), `${id}: ${header} is not the caller's key`);
  }
}

function reviewCases(run, credential) {
  return ADDRESSES.flatMap((address) => REVIEW_OPERATIONS.map((operation) => at(run, `${address}|${operation}|${credential}`)));
}

// ---- 1. behaviour, service credential configured -------------------------------------------------------

test('both runs with a service credential are clean and reach the review fetch (the assertions below are not vacuous)', () => {
  for (const mode of ['real/on', 'bypass/on']) {
    const run = runs[mode];
    assert.deepEqual(run.stray, [], `${mode}: no outbound request outside a case`);
    assert.deepEqual(run.warnings, [], `${mode}: no warning line when the credential is configured`);
    const fetched = run.results.filter((r) => reviewFetches(r).length > 0);
    assert.ok(fetched.length >= 12, `${mode}: ${fetched.length} cases fetched a review summary`);
  }
  // The fetched summary is what the answer serves.
  const page = at(runs['real/on'], 'shop|get_pdp_v2|key');
  assert.equal(page.status, 200);
  const preview = (page.body.modules || []).find((m) => m.type === 'reviews_preview');
  assert.equal(preview && preview.data && preview.data.rating, 4.5, 'the review module carries the fetched rating');
});

test('with a service credential configured, no call to the backend invoke route goes out without a credential', () => {
  for (const mode of ['real/on', 'bypass/on']) {
    const keyless = [];
    let seen = 0;
    for (const r of runs[mode].results) {
      for (const o of r.outbound) {
        if (pathOf(o) !== INVOKE_PATH) continue;
        seen += 1;
        if (!Object.keys(credentialsOf(o)).length) keyless.push(`${r.id}: ${o.body && o.body.operation} to ${o.host}`);
      }
    }
    assert.ok(seen >= 30, `${mode}: ${seen} invoke calls recorded`);
    assert.deepEqual(keyless, [], `${mode}: keyless calls to the backend invoke route`);
  }
});

test('a caller with its own key: the review fetch carries the service credential, never the caller\'s key', () => {
  for (const credential of ['key', 'key_buyer']) {
    for (const r of reviewCases(runs['real/on'], credential)) {
      assert.equal(r.status, 200, r.id);
      const fetches = reviewFetches(r);
      assert.equal(fetches.length, 1, `${r.id}: one review fetch`);
      assert.deepEqual(credentialsOf(fetches[0]), SERVICE_IDENTITY, r.id);
      assertNothingFromTheCaller(fetches[0], r.id);
    }
  }
  // Not vacuous: the caller did send a buyer ref and a user token, and a neighbouring call forwards them.
  const detail = at(runs['real/on'], 'shop|neighbour:get_product_detail|key_buyer');
  const forwarded = pastAuth(detail).filter((o) => pathOf(o) === INVOKE_PATH);
  assert.ok(forwarded.length >= 1);
  assert.equal(forwarded[0].identity['x-buyer-ref'], 'buyer_ref');
  assert.equal(forwarded[0].identity['x-api-key'], 'caller_key');
});

test('a caller with a key and a checkout token: the review fetch sends the token alone, as before', () => {
  for (const r of reviewCases(runs['real/on'], 'key_token')) {
    assert.equal(r.status, 200, r.id);
    const fetches = reviewFetches(r);
    assert.equal(fetches.length, 1, `${r.id}: one review fetch`);
    assert.deepEqual(credentialsOf(fetches[0]), TOKEN_ALONE, r.id);
    assertNothingFromTheCaller(fetches[0], r.id);
  }
});

test('a caller with a checkout token only, or with nothing, is refused at the door and nothing is fetched', () => {
  for (const credential of ['token', 'none']) {
    for (const r of reviewCases(runs['real/on'], credential)) {
      assert.equal(r.status, 401, r.id);
      assert.deepEqual(pastAuth(r), [], `${r.id}: nothing sent to the backend`);
    }
  }
});

test('a request that reaches the handler with no key of its own: the review fetch carries the service credential', () => {
  for (const credential of ['none', 'key_buyer']) {
    for (const r of reviewCases(runs['bypass/on'], credential)) {
      assert.equal(r.status, 200, r.id);
      const fetches = reviewFetches(r);
      assert.equal(fetches.length, 1, `${r.id}: one review fetch`);
      assert.deepEqual(credentialsOf(fetches[0]), SERVICE_IDENTITY, r.id);
      assertNothingFromTheCaller(fetches[0], r.id);
    }
  }
  for (const r of reviewCases(runs['bypass/on'], 'token')) {
    assert.deepEqual(reviewFetches(r).map(credentialsOf), [TOKEN_ALONE], r.id);
  }
});

// ---- 2. no service credential configured ---------------------------------------------------------------

test('no service credential configured: the review fetch goes out with no credential, and the read is served', () => {
  for (const [mode, credentials] of [['real/off', ['key', 'key_buyer']], ['bypass/off', ['none', 'key_buyer']]]) {
    for (const credential of credentials) {
      for (const r of reviewCases(runs[mode], credential)) {
        assert.equal(r.status, 200, `${mode} ${r.id}`);
        const fetches = reviewFetches(r);
        assert.equal(fetches.length, 1, `${mode} ${r.id}: the fetch is still made`);
        assert.deepEqual(credentialsOf(fetches[0]), {}, `${mode} ${r.id}: no credential, and not the caller's key`);
        assertNothingFromTheCaller(fetches[0], `${mode} ${r.id}`);
      }
    }
    const tokenCredential = mode === 'real/off' ? 'key_token' : 'token';
    for (const r of reviewCases(runs[mode], tokenCredential)) {
      assert.deepEqual(reviewFetches(r).map(credentialsOf), [TOKEN_ALONE], `${mode} ${r.id}`);
    }
  }
});

test('no service credential configured: one warning line names the missing configuration, and no value', () => {
  for (const mode of ['real/off', 'bypass/off']) {
    const { warnings } = runs[mode];
    assert.equal(warnings.length, 1, `${mode}: one line for the whole run, not one per fetch`);
    assert.deepEqual(warnings[0].fields, {
      operation: 'get_review_summary',
      missing_config: 'gateway_service_credential',
      env: 'PIVOTA_API_KEY',
    }, mode);
    assert.match(warnings[0].message, /no service credential configured/, mode);
    assert.doesNotMatch(JSON.stringify(warnings[0]), /placeholder|ak_live_|Bearer/, `${mode}: the line holds no header value`);
  }
});

// ---- 3. the cache --------------------------------------------------------------------------------------

test('two different callers share one cached review summary, fetched once on the service credential', () => {
  for (const [mode, first, second] of [['real/on', 'key_buyer', 'second_key'], ['bypass/off', 'token', 'none']]) {
    const one = at(runs[mode], `cache|get_pdp_v2|caller_1:${first}`);
    const two = at(runs[mode], `cache|get_pdp_v2|caller_2:${second}`);
    assert.equal(reviewFetches(one).length, 1, `${mode}: the first caller's request fetches`);
    assert.equal(reviewFetches(two).length, 0, `${mode}: the second caller is answered from the first one's entry`);
    const preview = (r) => (r.body.modules || []).find((m) => m.type === 'reviews_preview').data;
    assert.deepEqual(preview(two), preview(one), `${mode}: both callers get the same summary`);
    assert.equal(preview(two).rating, 4.5, mode);
  }
  assert.deepEqual(credentialsOf(reviewFetches(at(runs['real/on'], 'cache|get_pdp_v2|caller_1:key_buyer'))[0]), SERVICE_IDENTITY);
});

// ---- 4. the source -------------------------------------------------------------------------------------

const SHARED_BUILDER = 'buildInvokeUpstreamAuthHeaders';
const REVIEW_HELPER = 'buildReviewSummaryUpstreamAuthHeaders';
// The base URLs of the backend in src/server.js.
const BACKEND_BASES = ['PIVOTA_API_BASE', 'REVIEWS_API_BASE'];
// A function that builds the invoke URL and hands it to another function, which adds the credential.
const DELEGATES = { handleOffersResolveOperation: 'callOffersResolveSourceWithRetry' };

function parse(source) {
  return ts.createSourceFile('server.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function topLevelFunctions(sourceFile) {
  const out = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) out.set(statement.name.text, statement);
  }
  return out;
}

function enclosingTopLevelName(node, sourceFile) {
  let top = node;
  while (top.parent && top.parent !== sourceFile) top = top.parent;
  if (ts.isFunctionDeclaration(top) && top.name) return top.name.text;
  return '<top level>';
}

function callsTo(node, name) {
  const found = [];
  (function walk(n) {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) found.push(n);
    ts.forEachChild(n, walk);
  })(node);
  return found;
}

// Every template literal that puts the invoke path on a backend base, with the function it sits in.
function backendInvokeUrlSites(sourceFile) {
  const sites = [];
  (function walk(node) {
    if (ts.isTemplateExpression(node) && node.getText(sourceFile).includes(INVOKE_PATH)) {
      const bases = node.templateSpans.map((span) => span.expression).filter((e) => ts.isIdentifier(e) && BACKEND_BASES.includes(e.text));
      if (bases.length) sites.push({ fn: enclosingTopLevelName(node, sourceFile), base: bases[0].text });
    }
    ts.forEachChild(node, walk);
  })(sourceFile);
  return sites;
}

function invokeCredentialSourceProblems(source) {
  const sourceFile = parse(source);
  const functions = topLevelFunctions(sourceFile);
  const problems = [];
  const sites = backendInvokeUrlSites(sourceFile);

  for (const site of sites) {
    const fn = functions.get(site.fn);
    if (!fn) {
      problems.push(`the backend invoke URL is built outside a top-level function (${site.fn})`);
      continue;
    }
    const delegate = DELEGATES[site.fn];
    const holder = delegate ? functions.get(delegate) : fn;
    if (delegate && !callsTo(fn, delegate).length) problems.push(`${site.fn} no longer hands its request to ${delegate}`);
    const fromBuilder = holder && (callsTo(holder, SHARED_BUILDER).length || callsTo(holder, REVIEW_HELPER).length);
    if (!fromBuilder) problems.push(`${site.fn} builds the backend invoke URL and takes no credential from ${SHARED_BUILDER}`);
  }

  // The review fetch's helper: the shared builder, on the service identity, with nothing from the caller.
  const helper = functions.get(REVIEW_HELPER);
  if (!helper) {
    problems.push(`${REVIEW_HELPER} is missing`);
  } else {
    const calls = callsTo(helper, SHARED_BUILDER);
    if (calls.length !== 1) problems.push(`${REVIEW_HELPER} calls ${SHARED_BUILDER} ${calls.length} times, not once`);
    const options = calls.length === 1 && calls[0].arguments[0] && ts.isObjectLiteralExpression(calls[0].arguments[0])
      ? Object.fromEntries(calls[0].arguments[0].properties.map((p) => [p.name && p.name.getText(sourceFile), p.initializer && p.initializer.getText(sourceFile)]))
      : {};
    const wanted = { forceInternalFallback: 'true', forwardAgentUserJwt: 'false', forwardBuyerRef: 'false' };
    if (JSON.stringify(Object.entries(options).sort()) !== JSON.stringify(Object.entries(wanted).sort())) {
      problems.push(`${REVIEW_HELPER} asks the builder for ${JSON.stringify(options)}, not ${JSON.stringify(wanted)}`);
    }
    // Its returns are the builder's answer or the empty object; no header is written by hand.
    (function walk(n) {
      if (ts.isReturnStatement(n) && n.expression) {
        const text = n.expression.getText(sourceFile);
        const isBuilderCall = ts.isCallExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === SHARED_BUILDER;
        if (!isBuilderCall && text !== '{}') problems.push(`${REVIEW_HELPER} returns something other than the builder's headers: ${text.slice(0, 60)}`);
      }
      if (ts.isStringLiteral(n) && /^(x-api-key|authorization|x-checkout-token|x-buyer-ref|x-agent-user-jwt)$/i.test(n.text)) {
        problems.push(`${REVIEW_HELPER} writes the ${n.text} header by hand`);
      }
      ts.forEachChild(n, walk);
    })(helper);
  }

  // The fetch itself: the token alone when the request has one, the helper otherwise, and no other header.
  const fetch = functions.get('fetchReviewSummaryFromUpstream');
  if (!fetch) {
    problems.push('fetchReviewSummaryFromUpstream is missing');
  } else {
    if (callsTo(fetch, REVIEW_HELPER).length !== 1) problems.push(`fetchReviewSummaryFromUpstream does not take its credential from ${REVIEW_HELPER}`);
    const handWritten = [];
    (function walk(n) {
      if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.name)) handWritten.push(n.name.text);
      ts.forEachChild(n, walk);
    })(fetch);
    const unexpected = handWritten.filter((name) => !['Content-Type', 'X-Checkout-Token'].includes(name));
    if (unexpected.length) problems.push(`fetchReviewSummaryFromUpstream writes headers by hand: ${unexpected.join(', ')}`);
  }

  return { problems, sites };
}

test('in the source, every place that builds the backend invoke URL takes its credential from the shared builder', () => {
  const { problems, sites } = invokeCredentialSourceProblems(SERVER_SOURCE);
  assert.deepEqual(problems, []);
  // A COUNT, so a new call to the backend invoke route is a deliberate edit here: look at the credential it
  // sends, then change the number. 2026-11-12: eight, in seven functions.
  assert.equal(sites.length, 8, sites.map((s) => `${s.fn} (${s.base})`).join(', '));
  assert.deepEqual(sites.filter((s) => s.base === 'REVIEWS_API_BASE').map((s) => s.fn), ['fetchReviewSummaryFromUpstream']);
});

test('the review-summary cache key is merchant, platform and product: it holds no credential', () => {
  const functions = topLevelFunctions(parse(SERVER_SOURCE));
  const keyBuilder = functions.get('buildPdpReviewSummaryCacheKey');
  assert.ok(keyBuilder, 'buildPdpReviewSummaryCacheKey exists');
  const text = keyBuilder.getText();
  assert.match(text, /\{ merchantId, platform, platformProductId \}/);
  assert.doesNotMatch(text, /token|key\b.*api|invokeAuth|getInvokeAuth/i);
  const cached = functions.get('fetchReviewSummaryCached');
  assert.equal(callsTo(cached, 'buildPdpReviewSummaryCacheKey').length, 1);
  const keyCall = callsTo(cached, 'buildPdpReviewSummaryCacheKey')[0].getText();
  assert.doesNotMatch(keyCall, /checkoutToken|api_key|apiKey/);
});

const edit = (from, to) => {
  assert.ok(SERVER_SOURCE.includes(from), `the source still has: ${from.slice(0, 60)}`);
  return SERVER_SOURCE.replace(from, to);
};
const BUILDER_CALL = /return buildInvokeUpstreamAuthHeaders\(\{\s*forceInternalFallback: true,\s*forwardAgentUserJwt: false,\s*forwardBuyerRef: false,\s*\}\);/;
const WRONG_SOURCES = [
  {
    name: 'the review fetch sending the token or nothing, as it did',
    source: () => edit(': buildReviewSummaryUpstreamAuthHeaders()),', ': {}),'),
    expect: /fetchReviewSummaryFromUpstream does not take its credential/,
  },
  {
    name: 'the service key written into the header by hand',
    source: () => SERVER_SOURCE.replace(BUILDER_CALL, "return { 'X-API-Key': PIVOTA_API_KEY, Authorization: `Bearer ${PIVOTA_API_KEY}` };"),
    expect: /writes the X-API-Key header by hand/,
  },
  {
    name: 'the caller\'s key allowed on the shared read',
    source: () => SERVER_SOURCE.replace(BUILDER_CALL, 'return buildInvokeUpstreamAuthHeaders({ forwardAgentUserJwt: false, forwardBuyerRef: false });'),
    expect: /asks the builder for/,
  },
  {
    name: 'the buyer ref forwarded on the shared read',
    source: () => SERVER_SOURCE.replace(BUILDER_CALL, 'return buildInvokeUpstreamAuthHeaders({ forceInternalFallback: true, forwardAgentUserJwt: false });'),
    expect: /asks the builder for/,
  },
  {
    name: 'a new call to the backend invoke route with no credential',
    source: () => `${SERVER_SOURCE}\nasync function fetchSomethingNew() { return axios.post(\`\${PIVOTA_API_BASE}/agent/shop/v1/invoke\`, {}, { headers: {} }); }\n`,
    expect: /fetchSomethingNew builds the backend invoke URL and takes no credential/,
  },
  {
    name: 'a key header added beside the helper in the fetch',
    source: () => edit("...(checkoutToken ? { 'X-Checkout-Token': checkoutToken } : buildReviewSummaryUpstreamAuthHeaders()),",
      "...(checkoutToken ? { 'X-Checkout-Token': checkoutToken } : buildReviewSummaryUpstreamAuthHeaders()), 'X-API-Key': getInvokeAuthApiKey(),"),
    expect: /fetchReviewSummaryFromUpstream writes headers by hand: X-API-Key/,
  },
];

for (const wrong of WRONG_SOURCES) {
  test(`source scan refuses: ${wrong.name}`, () => {
    const source = wrong.source();
    assert.notEqual(source, SERVER_SOURCE, 'the edit applied');
    const { problems } = invokeCredentialSourceProblems(source);
    assert.ok(problems.some((p) => wrong.expect.test(p)), `expected ${wrong.expect}, got:\n${problems.join('\n') || '(no problems)'}`);
  });
}
