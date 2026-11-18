'use strict';

// The AgenPas page script (src/agenpas/assets/app.js) run in a vm context against a minimal fake DOM, fake timers and
// a scripted fetch (the repo has no jsdom; the script only uses createElement/appendChild/textContent/attributes).
// Covers: the fragment token, no retry on outcome_unknown, the error backoff, stopping on terminal and on 410, and
// the embed frame surviving error / recovery without being recreated. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'agenpas', 'assets', 'app.js'), 'utf8');
const PID = 'ap_0123456789abcdef01234567';
const TOKEN = 'v1.cGF5bG9hZA.c2lnbmF0dXJl';
const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.ownText = '';
    this.className = '';
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) {
    if (!child) throw new TypeError('appendChild: not a node');
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  set textContent(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.ownText = String(v);
  }
  get textContent() { return [this.ownText, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' '); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  all(pred, out = []) {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      c.all(pred, out);
    }
    return out;
  }
}

function harness({ hash = `#t=${TOKEN}`, answers = [] } = {}) {
  const clock = { t: T0 };
  const timers = [];
  let nextId = 1;
  const addTimer = (fn, ms, repeat) => {
    const id = nextId++;
    timers.push({ id, fn, ms: Number(ms) || 0, at: clock.t + (Number(ms) || 0), repeat });
    return id;
  };
  const removeTimer = (id) => {
    const i = timers.findIndex((x) => x.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const storage = new Map();
  const fetches = [];
  const queue = [...answers];
  const replaced = [];
  const app = new El('main');
  const location = { pathname: `/agenpas/p/${PID}`, search: '', hash, assign(u) { location.assigned = u; } };
  const window = {
    location,
    innerWidth: 390,
    history: { state: null, replaceState(state, title, url) { replaced.push(url); location.hash = ''; } },
    sessionStorage: {
      setItem: (k, v) => storage.set(k, String(v)),
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      removeItem: (k) => storage.delete(k),
    },
    matchMedia: () => ({ matches: false }),
    open: () => null,
    addEventListener() {},
  };
  const document = {
    visibilityState: 'visible',
    getElementById: (id) => (id === 'app' ? app : null),
    createElement: (tag) => new El(tag),
    addEventListener() {},
  };
  class FakeDate extends Date {
    static now() { return clock.t; }
  }
  const fetch = (url, init) => {
    fetches.push({ url, init });
    const next = queue.length ? queue.shift() : { status: 503, body: { error: 'unavailable' } };
    return Promise.resolve({ status: next.status, json: () => Promise.resolve(next.body) });
  };
  const context = vm.createContext({
    window, document, fetch, URL, URLSearchParams, Date: FakeDate,
    setTimeout: (fn, ms) => addTimer(fn, ms, false), clearTimeout: removeTimer,
    setInterval: (fn, ms) => addTimer(fn, ms, true), clearInterval: removeTimer,
  });
  return {
    app, clock, timers, storage, fetches, replaced, location,
    start() { vm.runInContext(SRC, context, { filename: 'app.js' }); },
    answer(...more) { queue.push(...more); },
    pollTimers() { return timers.filter((x) => !x.repeat); },
    /** Run the next one-shot timer (advancing the clock to it); returns its delay in ms. */
    runNext() {
      const pending = timers.filter((x) => !x.repeat).sort((a, b) => a.at - b.at);
      if (!pending.length) return null;
      const timer = pending[0];
      removeTimer(timer.id);
      clock.t = Math.max(clock.t, timer.at);
      timer.fn();
      return timer.ms;
    },
    text() { return app.textContent; },
  };
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
}

function view(over = {}) {
  return {
    purchase_id: PID, state: 'needs_payment_method', screen: 'add_card', terminal: false,
    merchant_domain: 'merchant.example', product_name: 'Sample Lip Gloss', variant_title: null, quantity: 1,
    currency: 'USD', amounts: { unit_price_minor: 1800, quoted_total_minor: null, final_total_minor: null, shipping_minor: null, tax_minor: null },
    action: { kind: 'card_binding', url: 'https://pay.partner.example/bind?s=1', expires_at: '2026-11-17T12:30:00.000Z', open_mode: 'popup' },
    order: null, outcome: null, poll_after_seconds: 5,
    link_expires_at: '2026-11-17T12:30:00.000Z', link_ttl_minutes: 30,
    ...over,
  };
}

test('the token comes from the fragment, the fragment is cleared, and it travels only in the header', async () => {
  const h = harness({ answers: [{ status: 200, body: view() }] });
  h.start();
  await settle();
  assert.deepEqual(h.replaced, [`/agenpas/p/${PID}`]);
  assert.equal(h.location.hash, '');
  assert.equal(h.fetches.length, 1);
  assert.equal(h.fetches[0].url, `/agenpas/api/p/${PID}`);
  assert.equal(h.fetches[0].init.headers['X-Agenpas-Link'], TOKEN);
  assert.equal(h.fetches[0].url.includes(TOKEN), false);
  assert.equal(h.storage.get(`agenpas:t:${PID}`), TOKEN);
  assert.match(h.text(), /Add a card securely/);
});

test('reloaded without the fragment (back from a hosted page), the tab\'s copy of the token is used', async () => {
  const h = harness({ hash: '', answers: [{ status: 200, body: view() }] });
  h.storage.set(`agenpas:t:${PID}`, TOKEN);
  h.start();
  await settle();
  assert.equal(h.fetches[0].init.headers['X-Agenpas-Link'], TOKEN);
});

test('outcome_unknown: no button, no retry wording, polling stops and the token is forgotten', async () => {
  const outcome = {
    kind: 'outcome_unknown', title: "We're checking with the store",
    message: "We're checking with the store — don't try again. Your order may already be in progress, and we'll confirm what happened in the chat.",
    retry_hint: false, outcome_unknown: true,
  };
  const h = harness({ answers: [{ status: 200, body: view({ state: 'failed', screen: 'outcome_unknown', terminal: true, action: null, outcome, poll_after_seconds: null }) }] });
  h.start();
  await settle();
  assert.match(h.text(), /don't try again/);
  assert.equal(h.app.all((n) => n.tagName === 'BUTTON' || (n.tagName === 'A' && /btn/.test(n.className))).length, 0);
  assert.equal(/go back to the chat to try again|start again/i.test(h.text()), false);
  assert.equal(h.pollTimers().length, 0, 'no further poll');
  assert.equal(h.storage.has(`agenpas:t:${PID}`), false);
});

test('errors back off 2, 4, 8, 15, 15 s; a success resets the backoff', async () => {
  const h = harness({ answers: [{ status: 200, body: view() }] });
  h.start();
  await settle();
  const delays = [];
  delays.push(h.runNext()); // the success's own interval (5 s)
  for (let i = 0; i < 5; i += 1) {
    h.answer({ status: 503, body: { error: 'unavailable' } });
    await settle();
    delays.push(h.runNext());
  }
  await settle();
  assert.deepEqual(delays, [5000, 2000, 4000, 8000, 15000, 15000]);
  h.answer({ status: 200, body: view() });
  await settle();
  h.runNext();
  await settle();
  h.answer({ status: 503, body: { error: 'unavailable' } });
  assert.equal(h.runNext(), 5000);
  await settle();
  assert.equal(h.runNext(), 2000, 'backoff starts again from 2 s');
});

test('a 429 is backed off like any error', async () => {
  const h = harness({ answers: [{ status: 429, body: { error: 'rate_limited' } }] });
  h.start();
  await settle();
  assert.equal(h.pollTimers()[0].ms, 2000);
});

test('410: the expired screen (lifetime from the answer), polling stops, the token is forgotten', async () => {
  const h = harness({ answers: [{ status: 410, body: { error: 'link_expired', link_ttl_minutes: 10 } }] });
  h.start();
  await settle();
  assert.match(h.text(), /This link has expired/);
  assert.match(h.text(), /only work for 10 minutes/);
  assert.equal(h.pollTimers().length, 0);
  assert.equal(h.storage.has(`agenpas:t:${PID}`), false);
});

test('completed: polling stops, the token is forgotten; an unparsed total says to see the email receipt', async () => {
  const done = view({
    state: 'completed', screen: 'done', terminal: true, action: null, poll_after_seconds: null,
    order: { reference: '#1001', status_url: null, total_unparsed: true },
  });
  const h = harness({ answers: [{ status: 200, body: done }] });
  h.start();
  await settle();
  assert.match(h.text(), /Your order is placed/);
  assert.match(h.text(), /See your email receipt/);
  assert.equal(h.pollTimers().length, 0);
  assert.equal(h.storage.has(`agenpas:t:${PID}`), false);
});

test('embed mode: the frame is not recreated by an unchanged answer, an error, or the recovery', async () => {
  const embedded = view({ action: { ...view().action, open_mode: 'embed' } });
  const h = harness({ answers: [{ status: 200, body: embedded }] });
  h.start();
  await settle();
  const frames = () => h.app.all((n) => n.tagName === 'IFRAME');
  const [frame] = frames();
  assert.ok(frame);
  assert.equal(frame.src, embedded.action.url);
  h.answer({ status: 200, body: embedded });
  h.runNext();
  await settle();
  assert.equal(frames()[0], frame, 'unchanged answer');
  h.answer({ status: 503, body: { error: 'unavailable' } });
  h.runNext();
  await settle();
  assert.equal(frames()[0], frame, 'error');
  assert.match(h.text(), /Reconnecting…/);
  h.answer({ status: 200, body: embedded });
  h.runNext();
  await settle();
  assert.equal(frames()[0], frame, 'recovery');
  assert.equal(/Reconnecting/.test(h.text()), false);
});

test('an action URL that is not https never reaches the DOM, and rendering does not fail', async () => {
  const h = harness({ answers: [{ status: 200, body: view({ action: { ...view().action, url: 'http://pay.partner.example/bind' } }) }] });
  h.start();
  await settle();
  assert.match(h.text(), /Add a card/);
  assert.equal(h.app.all((n) => n.tagName === 'A').length, 0);
  const embed = harness({ answers: [{ status: 200, body: view({ action: { ...view().action, url: 'javascript:alert(1)', open_mode: 'embed' } }) }] });
  embed.start();
  await settle();
  assert.equal(embed.app.all((n) => n.tagName === 'IFRAME').length, 0);
});

test('a purchase held while placing: the checking screen, no "under a minute", no retry, and polling goes on', async () => {
  const held = view({
    state: 'placing', screen: 'outcome_unknown', terminal: false, action: null, poll_after_seconds: 15,
    outcome: { kind: 'held', title: "We're checking with the store", message: "We're checking with the store — don't try again. This can take a while; we'll confirm what happened in the chat.", retry_hint: false, outcome_unknown: true },
  });
  const h = harness({ answers: [{ status: 200, body: held }] });
  h.start();
  await settle();
  assert.match(h.text(), /don't try again/);
  assert.equal(/under a minute/.test(h.text()), false);
  assert.equal(/try again from|go back to the chat to try again/i.test(h.text()), false);
  assert.equal(h.pollTimers()[0].ms, 15000, 'still polling');
  assert.equal(h.storage.has(`agenpas:t:${PID}`), true, 'not final: the token is kept');
});

test('embed: the frame sandbox carries no top-navigation permission', async () => {
  const h = harness({ answers: [{ status: 200, body: view({ action: { ...view().action, open_mode: 'embed' } }) }] });
  h.start();
  await settle();
  const [frame] = h.app.all((n) => n.tagName === 'IFRAME');
  assert.equal(/allow-top-navigation/.test(frame.getAttribute('sandbox')), false);
});

test('a parked purchase: "Getting things ready…", polling goes on, the token is kept', async () => {
  const parked = view({
    state: 'locking', screen: 'parked', terminal: false, action: null, poll_after_seconds: 15,
    outcome: { kind: 'parked', title: 'Getting things ready…', message: 'This is taking a little longer than usual. This page updates on its own.', retry_hint: false, outcome_unknown: false },
  });
  const h = harness({ answers: [{ status: 200, body: parked }] });
  h.start();
  await settle();
  assert.match(h.text(), /Getting things ready…/);
  assert.equal(/try again/i.test(h.text()), false);
  assert.equal(h.pollTimers()[0].ms, 15000);
  assert.equal(h.storage.has(`agenpas:t:${PID}`), true);
});

test('a held purchase still in approval: no approve button, the checking copy, polling goes on', async () => {
  const held = view({
    state: 'awaiting_buyer_authorization', screen: 'outcome_unknown', terminal: false, action: null, poll_after_seconds: 15,
    amounts: { ...view().amounts, quoted_total_minor: 2300 },
    outcome: { kind: 'held', title: "We're checking with the store", message: "We're checking with the store — don't try again. This can take a while; we'll confirm what happened in the chat.", retry_hint: false, outcome_unknown: true },
  });
  const h = harness({ answers: [{ status: 200, body: held }] });
  h.start();
  await settle();
  assert.equal(/Approve \$|Approve your purchase|Face ID/.test(h.text()), false);
  assert.equal(h.app.all((n) => n.tagName === 'A' && /btn/.test(n.className)).length, 0);
  assert.match(h.text(), /don't try again/);
  assert.equal(h.pollTimers()[0].ms, 15000);
});

test('operator_confirmed_not_charged: the operator wording once, no second "try again" line, polling stops', async () => {
  const done = view({
    state: 'failed', screen: 'failed', terminal: true, action: null, poll_after_seconds: null,
    outcome: { kind: 'not_charged', title: "This purchase didn't go through", message: "This purchase didn't go through and you weren't charged. You can start again from the chat.", retry_hint: true, outcome_unknown: false },
  });
  const h = harness({ answers: [{ status: 200, body: done }] });
  h.start();
  await settle();
  assert.match(h.text(), /you weren't charged/);
  assert.equal(/try again/i.test(h.text()), false);
  assert.equal((h.text().match(/start again from the chat/g) || []).length, 1);
  assert.equal(h.pollTimers().length, 0);
});

// ---- the shipping address form (AGENPAS_COLLECT_SHIPPING) -----------------------------------------------------

function addressView(fields, prefill = {}) {
  return view({
    state: 'routing', screen: 'shipping_address', action: null, poll_after_seconds: 15,
    address_request: { fields_missing: fields, expires_at: '2026-11-17T12:30:00.000Z', prefill },
  });
}
const byName = (h, name) => h.app.all((n) => n.name === name)[0];
const formOf = (h) => h.app.all((n) => n.tagName === 'FORM')[0];
function type(input, value) {
  input.value = value;
  (input.listeners.input || []).forEach((f) => f({}));
}
function submit(h) {
  const ev = { prevented: false, preventDefault() { this.prevented = true; } };
  (formOf(h).listeners.submit || []).forEach((f) => f(ev));
  return ev;
}

test('address screen: only the missing fields, with autocomplete / inputmode, prefilled, and no card field', async () => {
  const h = harness({ answers: [{ status: 200, body: addressView(['email', 'phone', 'region', 'postalCode', 'country'], { country: 'US' }) }] });
  h.start();
  await settle();
  assert.match(h.text(), /Where should we send it\?/);
  assert.match(h.text(), /goes to merchant\.example so they can ship your order/);
  const names = h.app.all((n) => n.tagName === 'INPUT' || n.tagName === 'SELECT').map((n) => n.name);
  assert.deepEqual(names, ['email', 'phone', 'region', 'postalCode', 'country']);
  assert.equal(byName(h, 'email').getAttribute('autocomplete'), 'email');
  assert.equal(byName(h, 'phone').getAttribute('autocomplete'), 'shipping tel');
  assert.equal(byName(h, 'phone').getAttribute('inputmode'), 'tel');
  assert.equal(byName(h, 'postalCode').getAttribute('autocomplete'), 'shipping postal-code');
  assert.equal(byName(h, 'postalCode').getAttribute('inputmode'), 'numeric');
  assert.equal(byName(h, 'region').tagName, 'SELECT');
  assert.equal(byName(h, 'region').children.length, 52); // "Choose…" + 50 states + DC
  assert.equal(byName(h, 'country').value, 'US');
  for (const n of h.app.all((x) => x.tagName === 'INPUT')) assert.equal(/cc-/.test(n.getAttribute('autocomplete') || ''), false);
});

test('address screen: the full set uses the shipping autocomplete tokens', async () => {
  const all = ['email', 'firstName', 'lastName', 'phone', 'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'country'];
  const h = harness({ answers: [{ status: 200, body: addressView(all) }] });
  h.start();
  await settle();
  const ac = Object.fromEntries(all.map((f) => [f, byName(h, f).getAttribute('autocomplete')]));
  assert.deepEqual(ac, {
    email: 'email', firstName: 'shipping given-name', lastName: 'shipping family-name', phone: 'shipping tel',
    addressLine1: 'shipping address-line1', addressLine2: 'shipping address-line2', city: 'shipping address-level2',
    region: 'shipping address-level1', postalCode: 'shipping postal-code', country: 'shipping country',
  });
});

test('address form: client checks stop an incomplete submit with inline messages (nothing sent)', async () => {
  const h = harness({ answers: [{ status: 200, body: addressView(['email', 'postalCode']) }] });
  h.start();
  await settle();
  type(byName(h, 'email'), 'not-an-email');
  type(byName(h, 'postalCode'), '941');
  const ev = submit(h);
  await settle();
  assert.equal(ev.prevented, true);
  assert.equal(h.fetches.length, 1, 'only the first read');
  assert.match(h.text(), /Enter a valid email address\./);
  assert.match(h.text(), /Enter a 5-digit ZIP code\./);
  assert.equal(byName(h, 'email').getAttribute('aria-invalid'), 'true');
});

test('address form: submits JSON to its own route with the link header, then shows the next step', async () => {
  const next = view({ state: 'needs_payment_method', screen: 'add_card' });
  const h = harness({ answers: [{ status: 200, body: addressView(['email', 'postalCode']) }, { status: 200, body: next }] });
  h.start();
  await settle();
  type(byName(h, 'email'), ' buyer@example.test ');
  type(byName(h, 'postalCode'), '94107');
  submit(h);
  await settle();
  const sent = h.fetches[1];
  assert.equal(sent.url, `/agenpas/api/p/${PID}/shipping-address`);
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.headers['Content-Type'], 'application/json');
  assert.equal(sent.init.headers['X-Agenpas-Link'], TOKEN);
  assert.equal(sent.init.credentials, 'omit');
  assert.deepEqual(JSON.parse(sent.init.body), { email: 'buyer@example.test', postalCode: '94107' });
  assert.match(h.text(), /Add a card securely/);
  assert.equal(h.storage.get(`agenpas:t:${PID}`), TOKEN, 'the address is never stored, the token still is');
  assert.equal([...h.storage.values()].some((v) => v.includes('buyer@example.test')), false);
});

test('address form: a 422 shows the server\'s field errors inline; a 409 says "We already have your address"', async () => {
  const h = harness({ answers: [
    { status: 200, body: addressView(['postalCode']) },
    { status: 422, body: { error: 'invalid_address', field_errors: { postalCode: 'invalid_postal_code' } } },
  ] });
  h.start();
  await settle();
  type(byName(h, 'postalCode'), '94107');
  submit(h);
  await settle();
  assert.match(h.text(), /Enter a 5-digit ZIP code\./);
  assert.equal(byName(h, 'postalCode').value, '94107', 'what the buyer typed is kept');
  const h2 = harness({ answers: [{ status: 200, body: addressView(['postalCode']) }, { status: 409, body: { error: 'address_already_set' } }] });
  h2.start();
  await settle();
  type(byName(h2, 'postalCode'), '94107');
  submit(h2);
  await settle();
  assert.match(h2.text(), /We already have your address\./);
});

test('collection off: the "add it in the chat" screen, no form', async () => {
  const h = harness({ answers: [{ status: 200, body: view({ state: 'routing', screen: 'shipping_address_elsewhere', action: null }) }] });
  h.start();
  await settle();
  assert.match(h.text(), /Go back to the chat to add your address/);
  assert.equal(h.app.all((n) => n.tagName === 'FORM' || n.tagName === 'INPUT').length, 0);
});

test('completed with the order number withheld: "Your order is placed", the total, and the confirmation-email line', async () => {
  const done = view({
    state: 'completed', screen: 'done', terminal: true, action: null, poll_after_seconds: null,
    amounts: { ...view().amounts, final_total_minor: 2297 },
    order: { reference: null, status_url: null, total_unparsed: false, reference_withheld: true },
  });
  const h = harness({ answers: [{ status: 200, body: done }] });
  h.start();
  await settle();
  assert.match(h.text(), /Your order is placed/);
  assert.match(h.text(), /Your order number is in the store's confirmation email\./);
  assert.match(h.text(), /\$22\.97/);
  assert.equal(h.pollTimers().length, 0);
});
