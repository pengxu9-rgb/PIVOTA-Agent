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
    return Promise.resolve({
      status: next.status,
      headers: { get: (k) => ((next.headers || {})[String(k).toLowerCase()] ?? null) },
      // `text`: a non-JSON answer (a guard's plain-text 404), whose json() rejects.
      json: () => (next.text !== undefined ? Promise.reject(new SyntaxError('not json')) : Promise.resolve(next.body)),
    });
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

// ---- terms and privacy consent (AGENPAS_CONSENT_ENABLED; the API sends `consent`) ------------------------------

const OFFER = Object.freeze({ id: 'offer0123456789abcdef0123456789ab', issued_at: '2026-11-17T11:59:58Z' });
function consentView(over = {}) {
  return view({
    action: null,
    consent: { step: 'card_binding', terms_url: 'https://legal.example/terms', privacy_url: 'https://legal.example/privacy', offer: { ...OFFER } },
    ...over,
  });
}
const findAll = (h, pred) => h.app.all(pred);
const checkbox = (h) => findAll(h, (n) => n.tagName === 'INPUT')[0];
const agree = (h) => findAll(h, (n) => n.tagName === 'BUTTON' && /Agree and continue|Saving/.test(n.textContent))[0];
const hostedLinks = (h) => findAll(h, (n) => n.tagName === 'A' && /btn/.test(n.className));
function tick(h, input) {
  input.checked = true;
  for (const fn of input.listeners.change || []) fn();
}
// Run the one-shot timers due by `ms` from now (the dwell re-check among them), advancing the clock.
function advance(h, ms) {
  h.clock.t += ms;
  for (const timer of h.timers.filter((x) => !x.repeat && x.at <= h.clock.t && x.ms > 4000 && x.ms < 5000)) {
    h.timers.splice(h.timers.indexOf(timer), 1);
    timer.fn();
  }
}

test('consent: unchecked box, "Agree and continue" disabled until checked AND the dwell has passed; no hosted page button', async () => {
  const h = harness({ answers: [{ status: 200, body: consentView() }] });
  h.start();
  await settle();
  assert.match(h.text(), /Before you add your card, read Pivota's/);
  const links = findAll(h, (n) => n.tagName === 'A');
  assert.deepEqual(links.map((a) => [a.textContent, a.href, a.target, a.rel]), [
    ['Terms of Service', 'https://legal.example/terms', '_blank', 'noopener noreferrer'],
    ['Privacy Policy', 'https://legal.example/privacy', '_blank', 'noopener noreferrer'],
  ]);
  assert.equal(hostedLinks(h).length, 0, 'no hosted page button before the URL');
  const box = checkbox(h);
  assert.equal(box.type, 'checkbox');
  assert.equal(box.checked, false);
  assert.equal(agree(h).disabled, true);
  tick(h, box);
  assert.equal(agree(h).disabled, true, 'checked, but the offer has only just been shown');
  advance(h, 4100);
  assert.equal(agree(h).disabled, false);
  // No input of any other kind anywhere: no card fields.
  assert.deepEqual(findAll(h, (n) => n.tagName === 'INPUT').map((n) => n.type), ['checkbox']);
});

test('consent: the click POSTs {step, offer_id, issued_at} as JSON with the link header; the hosted button comes only from a later read', async () => {
  const h = harness({ answers: [{ status: 200, body: consentView() }] });
  h.start();
  await settle();
  tick(h, checkbox(h));
  advance(h, 4100);
  // The POST's answer; the follow-up read then finds the backend still settling (503), and only the read after it
  // carries the hosted page.
  h.answer({ status: 200, body: { recorded: true } }, { status: 503, body: { error: 'unavailable' } });
  for (const fn of agree(h).listeners.click) fn();
  await settle();
  const post = h.fetches.find((f) => f.init.method === 'POST');
  assert.equal(post.url, `/agenpas/api/p/${PID}/consent`);
  assert.equal(post.init.headers['Content-Type'], 'application/json');
  assert.equal(post.init.headers['X-Agenpas-Link'], TOKEN);
  assert.equal(post.init.credentials, 'omit');
  assert.deepEqual(JSON.parse(post.init.body), { step: 'card_binding', offer_id: OFFER.id, issued_at: OFFER.issued_at });
  assert.equal(post.url.includes(TOKEN) || post.init.body.includes(TOKEN), false);
  assert.match(h.text(), /Thanks\. Getting the secure card page ready/);
  assert.equal(hostedLinks(h).length, 0);
  assert.equal(h.fetches.filter((f) => f.init.method === 'GET').length, 2, 'the page read again at once');
  h.answer({ status: 200, body: view() });
  for (let i = 0; i < 3 && hostedLinks(h).length === 0; i += 1) {
    h.runNext();
    await settle();
  }
  assert.equal(hostedLinks(h).length, 1);
  assert.equal(hostedLinks(h)[0].href, view().action.url);
});

test('consent: a 429 keeps the tick and says to wait; a 409 clears it and asks to read again', async () => {
  const h = harness({ answers: [{ status: 200, body: consentView() }] });
  h.start();
  await settle();
  tick(h, checkbox(h));
  advance(h, 4100);
  h.answer({ status: 429, body: { error: 'rate_limited', retry_after_seconds: 2 } });
  for (const fn of agree(h).listeners.click) fn();
  await settle();
  assert.equal(checkbox(h).checked, true, 'the tick survives the 429');
  assert.match(h.text(), /Too many tries/);
  assert.equal(agree(h).disabled, true, 'not before the wait');
  h.clock.t += 2100;
  for (const fn of checkbox(h).listeners.change) fn();
  assert.equal(agree(h).disabled, false);
  h.answer({ status: 409, body: { error: 'consent_stale' } });
  for (const fn of agree(h).listeners.click) fn();
  await settle();
  assert.equal(checkbox(h).checked, false);
  assert.match(h.text(), /read the terms again/);
});

test('consent: the approval terms ride on "Confirming your total" too', async () => {
  const h = harness({ answers: [{ status: 200, body: consentView({ state: 'locking', screen: 'confirming_total', consent: { ...consentView().consent, step: 'approval' } }) }] });
  h.start();
  await settle();
  assert.match(h.text(), /Confirming your total/);
  assert.match(h.text(), /Before you approve, read Pivota's/);
  assert.ok(checkbox(h));
});

test('consent: a new offer id on every read does not re-render (the tick and focus stay)', async () => {
  const h = harness({ answers: [{ status: 200, body: consentView() }] });
  h.start();
  await settle();
  const box = checkbox(h);
  tick(h, box);
  h.answer({ status: 200, body: consentView({ consent: { ...consentView().consent, offer: { id: 'offerffffffffffffffffffffffffffff', issued_at: '2026-11-17T12:00:03Z' } } }) });
  h.runNext();
  await settle();
  assert.equal(checkbox(h), box, 'same element');
  assert.equal(checkbox(h).checked, true);
});

test('"not available right now": no button of any kind, polling goes on, the token is kept', async () => {
  const h = harness({ answers: [{ status: 200, body: view({ screen: 'unavailable', action: null, poll_after_seconds: 15 }) }] });
  h.start();
  await settle();
  assert.match(h.text(), /This step isn't available right now/);
  assert.equal(findAll(h, (n) => n.tagName === 'A' || n.tagName === 'IFRAME' || n.tagName === 'INPUT').length, 0);
  assert.equal(h.pollTimers()[0].ms, 15000);
  assert.equal(h.storage.has(`agenpas:t:${PID}`), true);
});

test('details needed (contact re-entry): go back to the chat, no card button, polling goes on', async () => {
  const h = harness({ answers: [{ status: 200, body: view({
    screen: 'details_needed', action: null, poll_after_seconds: 15,
    outcome: { kind: 'details_needed', title: 'Some details are needed', message: 'Your contact details need to be entered again before this purchase can go on. Go back to the chat to continue.', retry_hint: false, outcome_unknown: false },
  }) }] });
  h.start();
  await settle();
  assert.match(h.text(), /Go back to the chat to continue/);
  assert.equal(findAll(h, (n) => n.tagName === 'A' || n.tagName === 'INPUT').length, 0);
  assert.equal(h.pollTimers()[0].ms, 15000);
});

// ---- review round 2 ----------------------------------------------------------------------------------------------

function clickAgree(h) { for (const fn of agree(h).listeners.click) fn(); }
// Run one-shot timers (the dwell re-check among them) until the page has made one more read.
async function nextRead(h) {
  const before = h.fetches.length;
  for (let i = 0; i < 5 && h.fetches.length === before; i += 1) {
    if (h.runNext() === null) break;
    await settle();
  }
  await settle();
}
async function readyToAgree(h) {
  tick(h, checkbox(h));
  advance(h, 4100);
  assert.equal(agree(h).disabled, false);
}

test('a client clock 30 min fast: the offer is kept (its age is the page\'s own, not issued_at), and the dwell ends', async () => {
  // The link itself is still good on the page's clock (its expiry is on the same clock as the API's answers).
  const fast = (over = {}) => consentView({ link_expires_at: '2026-11-17T13:30:00.000Z', ...over });
  const h = harness({ answers: [{ status: 200, body: fast() }] });
  h.clock.t = T0 + 30 * 60 * 1000;
  h.start();
  await settle();
  const box = checkbox(h);
  tick(h, box);
  // Two more reads, each with a new offer: same element, tick kept, the FIRST offer is the one sent.
  for (const n of [1, 2]) {
    h.answer({ status: 200, body: fast({ consent: { ...consentView().consent, offer: { id: `offer${n}aaaaaaaaaaaaaaaaaaaaaaaaaaa`, issued_at: '2026-11-17T12:00:0' + n + 'Z' } } }) });
    await nextRead(h);
  }
  assert.equal(checkbox(h), box);
  assert.equal(checkbox(h).checked, true);
  advance(h, 4100);
  assert.equal(agree(h).disabled, false, 'the dwell is over even though issued_at is 30 min "old"');
  h.answer({ status: 200, body: { recorded: true } });
  clickAgree(h);
  await settle();
  assert.equal(JSON.parse(h.fetches.find((f) => f.init.method === 'POST').init.body).offer_id, OFFER.id);
});

test('an offer the page has held 25+ minutes is replaced by the newest one AND re-drawn (tick cleared, dwell restarted)', async () => {
  const h = harness({ answers: [{ status: 200, body: consentView() }] });
  h.start();
  await settle();
  const box = checkbox(h);
  tick(h, box);
  h.clock.t += 26 * 60 * 1000;
  const newer = { id: 'offernewnewnewnewnewnewnewnewnewn', issued_at: '2026-11-17T12:26:00Z' };
  h.answer({ status: 200, body: consentView({ consent: { ...consentView().consent, offer: newer } }) });
  await nextRead(h);
  assert.notEqual(checkbox(h), box, 're-rendered');
  assert.equal(checkbox(h).checked, false);
  tick(h, checkbox(h));
  assert.equal(agree(h).disabled, true, 'the dwell restarted');
  advance(h, 4100);
  h.answer({ status: 200, body: { recorded: true } });
  clickAgree(h);
  await settle();
  assert.equal(JSON.parse(h.fetches.filter((f) => f.init.method === 'POST').pop().init.body).offer_id, newer.id);
});

test('the backend\'s dwell (min_dwell_seconds) is waited out plus a second; without it, 4 s', async () => {
  const h = harness({ answers: [{ status: 200, body: consentView({ consent: { ...consentView().consent, min_dwell_seconds: 6 } }) }] });
  h.start();
  await settle();
  tick(h, checkbox(h));
  h.clock.t += 6500;
  for (const fn of checkbox(h).listeners.change) fn();
  assert.equal(agree(h).disabled, true, '6 s is not yet 6 + 1');
  h.clock.t += 600;
  for (const fn of checkbox(h).listeners.change) fn();
  assert.equal(agree(h).disabled, false);
});

test('400 consent_refused: the newest offer is adopted and the dwell restarts, like a 409', async () => {
  const h = harness({ answers: [{ status: 200, body: consentView() }] });
  h.start();
  await settle();
  const newer = { id: 'offer400400400400400400400400400a', issued_at: '2026-11-17T12:00:09Z' };
  h.answer({ status: 200, body: consentView({ consent: { ...consentView().consent, offer: newer } }) });
  await nextRead(h);
  await readyToAgree(h);
  h.answer({ status: 400, body: { error: 'consent_refused' } });
  clickAgree(h);
  await settle();
  assert.equal(checkbox(h).checked, false);
  assert.match(h.text(), /read the terms again/);
  tick(h, checkbox(h));
  assert.equal(agree(h).disabled, true, 'dwell restarted');
  advance(h, 4100);
  h.answer({ status: 200, body: { recorded: true } });
  clickAgree(h);
  await settle();
  assert.equal(JSON.parse(h.fetches.filter((f) => f.init.method === 'POST').pop().init.body).offer_id, newer.id);
});

test('409 consent_too_soon: the tick is kept and the page waits (not "something changed")', async () => {
  const h = harness({ answers: [{ status: 200, body: consentView() }] });
  h.start();
  await settle();
  await readyToAgree(h);
  h.answer({ status: 409, body: { error: 'consent_too_soon' } });
  clickAgree(h);
  await settle();
  assert.equal(checkbox(h).checked, true);
  assert.equal(/Something changed/.test(h.text()), false);
  assert.match(h.text(), /Just a moment/);
  assert.equal(agree(h).disabled, true);
  h.clock.t += 4100;
  for (const fn of checkbox(h).listeners.change) fn();
  assert.equal(agree(h).disabled, false);
  assert.equal(JSON.parse(h.fetches.filter((f) => f.init.method === 'POST').pop().init.body).offer_id, OFFER.id, 'same offer');
});

test('a guard\'s plain-text 404 on the POST is "not available right now": the token is kept and polling goes on', async () => {
  const h = harness({ answers: [{ status: 200, body: consentView() }] });
  h.start();
  await settle();
  await readyToAgree(h);
  h.answer({ status: 404, text: 'Not found', headers: { 'x-agenpas-guard': 'front' } });
  clickAgree(h);
  await settle();
  assert.match(h.text(), /isn't available right now/);
  assert.equal(/This link isn't valid/.test(h.text()), false);
  assert.equal(h.storage.get(`agenpas:t:${PID}`), TOKEN, 'token kept');
  assert.ok(h.pollTimers().length >= 1, 'still polling');
  // The API's own JSON link_invalid still ends it.
  h.answer({ status: 404, body: { error: 'link_invalid' } });
  for (const fn of checkbox(h).listeners.change) fn();
  clickAgree(h);
  await settle();
  assert.match(h.text(), /This link isn't valid/);
  assert.equal(h.storage.has(`agenpas:t:${PID}`), false);
});

// ---- review round 3: the versions recorded are the versions shown ---------------------------------------------

test('the terms and privacy versions are shown next to their links; new versions are a new offer (tick cleared, redrawn)', async () => {
  const versioned = (t, p, over = {}) => consentView({ consent: { ...consentView().consent, terms_version: t, privacy_version: p, ...over } });
  const h = harness({ answers: [{ status: 200, body: versioned('terms-2026-11', 'privacy-2026-11') }] });
  h.start();
  await settle();
  // (the fake DOM joins text nodes with spaces)
  assert.match(h.text().replace(/\s+/g, ' '), /Terms of Service \(version terms-2026-11\) and Privacy Policy \(version privacy-2026-11\)/);
  const box = checkbox(h);
  tick(h, box);
  h.answer({ status: 200, body: versioned('terms-2026-12', 'privacy-2026-11', { offer: { id: 'offerv2v2v2v2v2v2v2v2v2v2v2v2v2v2v', issued_at: '2026-11-17T12:00:05Z' } }) });
  await nextRead(h);
  assert.notEqual(checkbox(h), box);
  assert.equal(checkbox(h).checked, false);
  assert.match(h.text(), /\(version terms-2026-12\)/);
  await readyToAgree(h);
  h.answer({ status: 200, body: { recorded: true } });
  clickAgree(h);
  await settle();
  assert.equal(JSON.parse(h.fetches.filter((f) => f.init.method === 'POST').pop().init.body).offer_id, 'offerv2v2v2v2v2v2v2v2v2v2v2v2v2v2v');
});

// ---- the address step behind the terms (A2A; the owner's decision, 11-20) ---------------------------------------

function shippingConsentView(over = {}) {
  return view({
    state: 'routing', screen: 'shipping_address', action: null, poll_after_seconds: 15,
    consent: { step: 'shipping_address', terms_url: 'https://legal.example/terms', privacy_url: 'https://legal.example/privacy', offer: { ...OFFER } },
    ...over,
  });
}

test('address consent: the terms first on the address screen (no address field), and the form only after agreeing', async () => {
  const h = harness({ answers: [{ status: 200, body: shippingConsentView() }] });
  h.start();
  await settle();
  assert.match(h.text(), /Where should we send it\?/);
  assert.match(h.text(), /Before you give your shipping address, read Pivota's/);
  assert.deepEqual(findAll(h, (n) => n.tagName === 'INPUT' || n.tagName === 'SELECT').map((n) => n.type || n.tagName), ['checkbox']);
  assert.equal(findAll(h, (n) => n.tagName === 'FORM').length, 0, 'no form before the consent');
  await readyToAgree(h);
  h.answer({ status: 200, body: { recorded: true } }, { status: 200, body: addressView(['email', 'postalCode']) });
  clickAgree(h);
  await settle();
  const post = h.fetches.find((f) => f.init.method === 'POST');
  assert.equal(post.url, `/agenpas/api/p/${PID}/consent`);
  assert.deepEqual(JSON.parse(post.init.body), { step: 'shipping_address', offer_id: OFFER.id, issued_at: OFFER.issued_at });
  // The page read again at once and drew the form.
  assert.deepEqual(h.app.all((n) => n.tagName === 'INPUT' || n.tagName === 'SELECT').map((n) => n.name), ['email', 'postalCode']);
  assert.equal(findAll(h, (n) => n.tagName === 'INPUT' && n.type === 'checkbox').length, 0);
});

test('address consent: a 409 consent_required on submit goes back to the terms, keeps what was typed, and fills the form again after agreeing', async () => {
  const h = harness({ answers: [{ status: 200, body: addressView(['email', 'postalCode']) }] });
  h.start();
  await settle();
  type(byName(h, 'email'), 'buyer@example.test');
  type(byName(h, 'postalCode'), '94107');
  h.answer({ status: 409, body: { error: 'consent_required' } }, { status: 200, body: shippingConsentView() });
  submit(h);
  await settle();
  // Never the form again without the terms: a waiting card until the read shows them.
  assert.equal(findAll(h, (n) => n.tagName === 'FORM').length, 0, 'the stale form is not redrawn');
  assert.match(h.text(), /Checking the terms… This page updates on its own\. What you typed is kept\./);
  assert.equal(/couldn't save|We already have your address/.test(h.text()), false, 'no generic error, not "already have it"');
  await nextRead(h);
  assert.match(h.text(), /Before you give your shipping address, read Pivota's/);
  assert.match(h.text(), /Please accept the terms first/);
  assert.equal(findAll(h, (n) => n.tagName === 'FORM').length, 0);
  assert.equal([...h.storage.values()].some((v) => v.includes('buyer@example.test')), false, 'never stored');
  await readyToAgree(h);
  h.answer({ status: 200, body: { recorded: true } }, { status: 200, body: addressView(['email', 'postalCode']) });
  clickAgree(h);
  await settle();
  assert.equal(byName(h, 'email').value, 'buyer@example.test', 'what the buyer typed is back');
  assert.equal(byName(h, 'postalCode').value, '94107');
  assert.equal(/Please accept the terms first/.test(h.text()), false, 'the note is gone once agreed');
});

test('address consent: with the gate off the address screen is the form at once (no terms, no checkbox)', async () => {
  const h = harness({ answers: [{ status: 200, body: addressView(['email']) }] });
  h.start();
  await settle();
  assert.deepEqual(h.app.all((n) => n.tagName === 'INPUT' || n.tagName === 'SELECT').map((n) => n.name), ['email']);
  assert.equal(/Terms of Service/.test(h.text()), false);
});

test('address: a second 409 consent_required after agreeing again closes the step (no loop); the form never shows without the terms', async () => {
  const h = harness({ answers: [{ status: 200, body: addressView(['email']) }] });
  h.start();
  await settle();
  type(byName(h, 'email'), 'buyer@example.test');
  h.answer({ status: 409, body: { error: 'consent_required' } }, { status: 200, body: addressView(['email']) });
  submit(h);
  await settle();
  // The read shows the form again (backend read and write disagree): still no form without the terms.
  await nextRead(h);
  assert.equal(findAll(h, (n) => n.tagName === 'FORM').length, 0);
  assert.match(h.text(), /Checking the terms…/);
  // The terms come; the buyer agrees; the form is back; the write refuses again: closed.
  h.answer({ status: 200, body: shippingConsentView() });
  await nextRead(h);
  await readyToAgree(h);
  h.answer({ status: 200, body: { recorded: true } }, { status: 200, body: addressView(['email']) });
  clickAgree(h);
  await settle();
  assert.equal(byName(h, 'email').value, 'buyer@example.test');
  const posts = () => h.fetches.filter((f) => f.init.method === 'POST' && f.url.endsWith('/shipping-address')).length;
  h.answer({ status: 409, body: { error: 'consent_required' } }, { status: 200, body: addressView(['email']) });
  submit(h);
  await settle();
  assert.equal(posts(), 2);
  assert.match(h.text(), /We can't take your address here any more Go back to the chat\./);
  assert.equal(findAll(h, (n) => n.tagName === 'FORM').length, 0);
  await nextRead(h);
  assert.equal(findAll(h, (n) => n.tagName === 'FORM').length, 0, 'still closed after a read that shows the form');
  assert.equal(posts(), 2, 'never sent again');
});

test('address: any other 409 (address_not_taken) reads "We can\'t take your address here any more", re-reads, never a retry loop', async () => {
  const h = harness({ answers: [{ status: 200, body: addressView(['email']) }] });
  h.start();
  await settle();
  type(byName(h, 'email'), 'buyer@example.test');
  const reads = () => h.fetches.filter((f) => f.init.method === 'GET').length;
  h.answer({ status: 409, body: { error: 'address_not_taken' } }, { status: 200, body: addressView(['email']) });
  submit(h);
  await settle();
  assert.match(h.text(), /We can't take your address here any more Go back to the chat\./);
  assert.equal(/couldn't save|try again in a moment|We already have your address/.test(h.text()), false);
  assert.equal(findAll(h, (n) => n.tagName === 'FORM').length, 0);
  const before = reads();
  await nextRead(h);
  assert.equal(reads(), before + 1, 'the purchase is read again');
  assert.equal(findAll(h, (n) => n.tagName === 'FORM').length, 0);
});

test('address: 409 address_not_requested re-reads; a second one closes the step', async () => {
  const h = harness({ answers: [{ status: 200, body: addressView(['email']) }] });
  h.start();
  await settle();
  type(byName(h, 'email'), 'buyer@example.test');
  h.answer({ status: 409, body: { error: 'address_not_requested' } }, { status: 200, body: view() });
  submit(h);
  await settle();
  await nextRead(h);
  assert.match(h.text(), /Add a card securely/, 'the read shows where the purchase is');
  const h2 = harness({ answers: [{ status: 200, body: addressView(['email']) }] });
  h2.start();
  await settle();
  type(byName(h2, 'email'), 'buyer@example.test');
  h2.answer({ status: 409, body: { error: 'address_not_requested' } }, { status: 200, body: addressView(['email']) });
  submit(h2);
  await settle();
  await nextRead(h2);
  h2.answer({ status: 409, body: { error: 'address_not_requested' } }, { status: 200, body: addressView(['email']) });
  submit(h2);
  await settle();
  assert.match(h2.text(), /We can't take your address here any more/);
  assert.equal(findAll(h2, (n) => n.tagName === 'FORM').length, 0);
});

test('address: sent back to the terms but the reads keep showing the form: after 3 such reads the step closes (no endless wait)', async () => {
  const h = harness({ answers: [{ status: 200, body: addressView(['email']) }] });
  h.start();
  await settle();
  type(byName(h, 'email'), 'buyer@example.test');
  h.answer({ status: 409, body: { error: 'consent_required' } });
  submit(h);
  await settle();
  for (const n of [1, 2]) {
    h.answer({ status: 200, body: addressView(['email']) });
    await nextRead(h);
    assert.match(h.text(), /Checking the terms…/, `read ${n}: still waiting`);
  }
  h.answer({ status: 200, body: addressView(['email']) });
  await nextRead(h);
  assert.match(h.text(), /We can't take your address here any more Go back to the chat\./);
  assert.equal(findAll(h, (n) => n.tagName === 'FORM').length, 0);
  assert.equal(h.fetches.filter((f) => f.init.method === 'POST').length, 1, 'never sent again');
});

test('address: a read that shows a NEW form starts the "not requested" count again (one stale 409 earlier does not close it)', async () => {
  const h = harness({ answers: [{ status: 200, body: addressView(['email']) }] });
  h.start();
  await settle();
  type(byName(h, 'email'), 'buyer@example.test');
  // First 409 address_not_requested; the read then shows no form (the step moved on) ...
  h.answer({ status: 409, body: { error: 'address_not_requested' } }, { status: 200, body: view({ state: 'routing', screen: 'preparing', action: null }) });
  submit(h);
  await settle();
  await nextRead(h);
  assert.match(h.text(), /Getting your order ready/);
  // ... and a later read shows a new form: one more 409 now re-reads instead of closing.
  h.answer({ status: 200, body: addressView(['email']) });
  await nextRead(h);
  assert.ok(byName(h, 'email'));
  h.answer({ status: 409, body: { error: 'address_not_requested' } }, { status: 200, body: addressView(['email']) });
  submit(h);
  await settle();
  assert.equal(/We can't take your address here any more/.test(h.text()), false, 'not closed by the earlier count');
  // A second one in a row (no new form between) closes it.
  await nextRead(h);
  h.answer({ status: 409, body: { error: 'address_not_requested' } });
  submit(h);
  await settle();
  assert.match(h.text(), /We can't take your address here any more/);
});

// ---- the amount panel and the line under the step ---------------------------------------------------------------

const byClass = (h, name) => h.app.all((n) => String(n.className).split(' ').includes(name));
const CEILING_RE = /The final total can't be more than the amount you approve\./;
const TOTAL_FIRST = "You'll see the full total before you approve.";
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'agenpas', 'assets', 'app.css'), 'utf8');

test('panel: before the store prices the cart the number is LABELLED the item price, and the step promises no ceiling', async () => {
  const h = harness({ answers: [{ status: 200, body: view() }] });
  h.start();
  await settle();
  assert.deepEqual(byClass(h, 'hero-amount').map((n) => n.textContent), ['$18.00']);
  assert.equal(byClass(h, 'hero-cap').length, 0);
  assert.deepEqual(byClass(h, 'summary').map((n) => n.className), ['card summary']);
  assert.match(h.text(), /merchant\.example/);
  assert.deepEqual(byClass(h, 'hero-label').map((n) => n.textContent), ['Item price']);
  assert.deepEqual(byClass(h, 'hero-sub').map((n) => n.textContent), ['Shipping and tax are added before you approve.']);
  // The item price is not a ceiling: the ceiling line waits for the quoted total.
  assert.doesNotMatch(h.text(), CEILING_RE);
  assert.deepEqual(byClass(h, 'assure').map((n) => n.textContent), [TOTAL_FIRST]);
});

test('panel: before a quote, every buyer step that shows a line shows the pre-quote one; an approval with no quote shows none', async () => {
  const confirming = view({ state: 'locking', screen: 'confirming_total', action: null });
  const h = harness({ answers: [{ status: 200, body: confirming }] });
  h.start();
  await settle();
  assert.deepEqual(byClass(h, 'assure').map((n) => n.textContent), [TOTAL_FIRST]);
  assert.doesNotMatch(h.text(), CEILING_RE);

  const unquoted = view({
    state: 'awaiting_buyer_authorization', screen: 'approve',
    action: { kind: 'approval', url: 'https://pay.partner.example/approve?s=1', expires_at: '2026-11-17T12:30:00.000Z', open_mode: 'popup' },
  });
  const h2 = harness({ answers: [{ status: 200, body: unquoted }] });
  h2.start();
  await settle();
  assert.deepEqual(hostedLinks(h2).map((n) => n.textContent), ['Approve']);
  assert.equal(byClass(h2, 'assure').length, 0);
  assert.deepEqual(byClass(h2, 'hero-label').map((n) => n.textContent), ['Item price']);
});

test('panel: amounts are drawn in the purchase\'s own currency and its own minor units, never as dollars', async () => {
  const eur = view({
    state: 'awaiting_buyer_authorization', screen: 'approve', currency: 'EUR',
    amounts: { unit_price_minor: 1800, quoted_total_minor: 2349, final_total_minor: null, shipping_minor: 399, tax_minor: 150 },
    action: { kind: 'approval', url: 'https://pay.partner.example/approve?s=1', expires_at: '2026-11-17T12:30:00.000Z', open_mode: 'popup' },
  });
  const h = harness({ answers: [{ status: 200, body: eur }] });
  h.start();
  await settle();
  assert.deepEqual(byClass(h, 'hero-amount').map((n) => n.textContent), ['€23.49']);
  assert.deepEqual(byClass(h, 'hero-cap').map((n) => n.textContent), ["You'll approve up to €23.49"]);
  assert.deepEqual(byClass(h, 'hero-sub').map((n) => n.textContent), ['Items €18.00 · Shipping €3.99 · Tax €1.50']);
  assert.deepEqual(hostedLinks(h).map((n) => n.textContent), ['Approve €23.49']);
  assert.doesNotMatch(h.text(), /\$/);

  // A currency with no minor unit: 1800 is 1,800 yen, not 18.00.
  const jpy = view({ currency: 'JPY', quantity: 2 });
  const h2 = harness({ answers: [{ status: 200, body: jpy }] });
  h2.start();
  await settle();
  assert.deepEqual(byClass(h2, 'hero-amount').map((n) => n.textContent.replace(/^[^0-9]+/, '')), ['3,600']);
  assert.deepEqual(byClass(h2, 'hero-label').map((n) => n.textContent), ['Price for 2 items']);
  assert.match(byClass(h2, 'hero-item-meta')[0].textContent, /^Qty 2 · [^0-9]*1,800 each$/);
  assert.doesNotMatch(h2.text(), /\$|18\.00|36\.00/);
});

test('panel: a HELD purchase that is not final ("checking with the store") shows no "you\'ll approve" and a dimmed amount', async () => {
  const held = view({
    state: 'awaiting_buyer_authorization', screen: 'outcome_unknown', terminal: false, action: null,
    amounts: { unit_price_minor: 1800, quoted_total_minor: 2349, final_total_minor: null, shipping_minor: 399, tax_minor: 150 },
    outcome: { kind: 'checking', title: "We're checking with the store", message: "We're checking with the store — don't try again.", retry_hint: false, outcome_unknown: true },
  });
  const h = harness({ answers: [{ status: 200, body: held }] });
  h.start();
  await settle();
  assert.match(h.text(), /don't try again/);
  assert.equal(byClass(h, 'hero-cap').length, 0);
  assert.doesNotMatch(h.text(), /approve up to|approved up to|can't be more than|before you approve/);
  const amount = byClass(h, 'hero-amount');
  assert.deepEqual(amount.map((n) => n.textContent), ['$23.49']);
  assert.match(amount[0].className, /hero-amount-off/);
  assert.deepEqual(byClass(h, 'hero-label').map((n) => n.textContent), ['Total']);
  assert.equal(byClass(h, 'assure').length, 0);
  assert.equal(h.app.all((n) => n.tagName === 'BUTTON' || (n.tagName === 'A' && /btn/.test(n.className))).length, 0);
});

test('panel: once quoted, the amount is the quoted total, the cap is said once, and the parts are listed without a sum', async () => {
  const quoted = view({
    state: 'awaiting_buyer_authorization', screen: 'approve',
    amounts: { unit_price_minor: 1800, quoted_total_minor: 2349, final_total_minor: null, shipping_minor: 399, tax_minor: 150 },
    action: { kind: 'approval', url: 'https://pay.partner.example/approve?s=1', expires_at: '2026-11-17T12:30:00.000Z', open_mode: 'popup' },
  });
  const h = harness({ answers: [{ status: 200, body: quoted }] });
  h.start();
  await settle();
  assert.deepEqual(byClass(h, 'hero-amount').map((n) => n.textContent), ['$23.49']);
  assert.deepEqual(byClass(h, 'hero-cap').map((n) => n.textContent), ["You'll approve up to $23.49"]);
  assert.deepEqual(byClass(h, 'hero-sub').map((n) => n.textContent), ['Items $18.00 · Shipping $3.99 · Tax $1.50']);
  assert.equal(/\+/.test(byClass(h, 'hero-sub')[0].textContent), false);
  assert.deepEqual(hostedLinks(h).map((n) => n.textContent), ['Approve $23.49']);
  assert.match(h.text(), CEILING_RE);
});

test('panel: while the order is placed the cap reads "You approved up to"; a quantity above one shows the unit price', async () => {
  const placing = view({
    state: 'placing', screen: 'placing', action: null, quantity: 2,
    amounts: { unit_price_minor: 1800, quoted_total_minor: 4149, final_total_minor: null, shipping_minor: 399, tax_minor: 150 },
  });
  const h = harness({ answers: [{ status: 200, body: placing }] });
  h.start();
  await settle();
  assert.deepEqual(byClass(h, 'hero-cap').map((n) => n.textContent), ['You approved up to $41.49']);
  assert.deepEqual(byClass(h, 'hero-item-meta').map((n) => n.textContent), ['Qty 2 · $18.00 each']);
  assert.match(byClass(h, 'hero-sub')[0].textContent, /^Items \$36\.00 · /);
});

test('panel: a placed order shows the total charged and neither the cap nor the ceiling line', async () => {
  const done = view({
    state: 'completed', screen: 'done', terminal: true, action: null, poll_after_seconds: null,
    amounts: { unit_price_minor: 1800, quoted_total_minor: 2349, final_total_minor: 2297, shipping_minor: 399, tax_minor: 150 },
    order: { reference: 'R-1001', status_url: null, total_unparsed: false, reference_withheld: false },
  });
  const h = harness({ answers: [{ status: 200, body: done }] });
  h.start();
  await settle();
  assert.deepEqual(byClass(h, 'hero-amount').map((n) => n.textContent), ['$22.97']);
  assert.deepEqual(byClass(h, 'hero-label').map((n) => n.textContent), ['Total charged']);
  assert.equal(byClass(h, 'hero-cap').length, 0);
  assert.equal(byClass(h, 'hero-sub').length, 0);
  assert.equal(byClass(h, 'assure').length, 0);
  assert.doesNotMatch(h.text(), /approve up to|approved up to/);
});

test('panel: a placed order whose total could not be read shows no amount in the panel (the result card says where to find it)', async () => {
  const done = view({
    state: 'completed', screen: 'done', terminal: true, action: null, poll_after_seconds: null,
    amounts: { unit_price_minor: 1800, quoted_total_minor: 2349, final_total_minor: null, shipping_minor: 399, tax_minor: 150 },
    order: { reference: 'R-1001', status_url: null, total_unparsed: true, reference_withheld: false },
  });
  const h = harness({ answers: [{ status: 200, body: done }] });
  h.start();
  await settle();
  assert.equal(byClass(h, 'hero-amount').length, 0);
  assert.match(h.text(), /See your email receipt/);
});

test('panel: a purchase that stopped keeps its amount, dimmed, and claims nothing: no cap, no ceiling line, no added wording', async () => {
  const stopped = view({
    state: 'failed', screen: 'failed', terminal: true, action: null, poll_after_seconds: null,
    amounts: { unit_price_minor: 1800, quoted_total_minor: 2349, final_total_minor: null, shipping_minor: 399, tax_minor: 150 },
    outcome: { kind: 'declined', title: 'The approval was declined', message: "Your card issuer didn't approve this purchase, so the order wasn't placed.", retry_hint: true, outcome_unknown: false },
  });
  const h = harness({ answers: [{ status: 200, body: stopped }] });
  h.start();
  await settle();
  const amount = byClass(h, 'hero-amount');
  assert.deepEqual(amount.map((n) => n.textContent), ['$23.49']);
  assert.match(amount[0].className, /hero-amount-off/);
  assert.deepEqual(byClass(h, 'hero-label').map((n) => n.textContent), ['Total']);
  assert.equal(byClass(h, 'hero-cap').length, 0);
  assert.equal(byClass(h, 'assure').length, 0);
  assert.deepEqual(byClass(h, 'back-hint').map((n) => n.textContent), ['You can go back to the chat to try again.']);
});

test('address: each field is one box named for its field, and a refused field is marked on its box', async () => {
  const h = harness({ answers: [{ status: 200, body: addressView(['firstName', 'lastName', 'postalCode']) }] });
  h.start();
  await settle();
  assert.deepEqual(byClass(h, 'field').map((n) => n.className), ['field field-firstName', 'field field-lastName', 'field field-postalCode']);
  // The panel above the long form is the small one; every other screen draws the full panel. Small hides nothing:
  // the item price keeps its label and its "shipping and tax are added" line, in the page and in the stylesheet.
  assert.deepEqual(byClass(h, 'summary').map((n) => n.className), ['card summary summary-compact']);
  assert.deepEqual(byClass(h, 'hero-label').map((n) => n.textContent), ['Item price']);
  assert.deepEqual(byClass(h, 'hero-sub').map((n) => n.textContent), ['Shipping and tax are added before you approve.']);
  assert.deepEqual(byClass(h, 'assure').map((n) => n.textContent), [TOTAL_FIRST]);
  for (const rule of CSS.split('}')) {
    if (/display:\s*none/.test(rule)) assert.doesNotMatch(rule, /hero-(label|sub|amount|cap|store)/, rule.trim());
  }
  const inputs = findAll(h, (n) => n.tagName === 'INPUT');
  inputs[0].value = 'Sam';
  inputs[1].value = 'Buyer';
  inputs[2].value = '12';
  for (const input of inputs) for (const fn of input.listeners.input || []) fn();
  const form = findAll(h, (n) => n.tagName === 'FORM')[0];
  for (const fn of form.listeners.submit || []) fn({ preventDefault() {} });
  await settle();
  assert.deepEqual(byClass(h, 'field-bad').map((n) => n.className), ['field field-postalCode field-bad']);
  assert.match(h.text(), /Enter a 5-digit ZIP code\./);
});

test('address: a closed step and the "Checking the terms…" card carry no line about the total', async () => {
  const h = harness({ answers: [{ status: 200, body: addressView(['firstName']) }] });
  h.start();
  await settle();
  const input = findAll(h, (n) => n.tagName === 'INPUT')[0];
  input.value = 'Sam';
  for (const fn of input.listeners.input || []) fn();
  const submitForm = () => {
    const form = findAll(h, (n) => n.tagName === 'FORM')[0];
    for (const fn of form.listeners.submit || []) fn({ preventDefault() {} });
  };
  // Sent back to the terms once: the "Checking the terms…" card, with no line under it.
  h.answer({ status: 409, body: { error: 'consent_required' } });
  submitForm();
  await settle();
  assert.match(h.text(), /Checking the terms…/);
  assert.equal(byClass(h, 'assure').length, 0);
});

test('address: "We can\'t take your address here any more" carries no line about the total', async () => {
  const h = harness({ answers: [{ status: 200, body: addressView(['firstName']) }] });
  h.start();
  await settle();
  const input = findAll(h, (n) => n.tagName === 'INPUT')[0];
  input.value = 'Sam';
  for (const fn of input.listeners.input || []) fn();
  h.answer({ status: 409, body: { error: 'address_not_taken' } });
  const form = findAll(h, (n) => n.tagName === 'FORM')[0];
  for (const fn of form.listeners.submit || []) fn({ preventDefault() {} });
  await settle();
  assert.match(h.text(), /We can't take your address here any more/);
  assert.equal(byClass(h, 'assure').length, 0);
});

test('card: "Pay with Visa ending 4242" on the approval screen and "Paid with" once the order is placed', async () => {
  const approve = view({
    state: 'awaiting_buyer_authorization', screen: 'approve',
    amounts: { unit_price_minor: 1800, quoted_total_minor: 2349, final_total_minor: null, shipping_minor: 399, tax_minor: 150 },
    action: { kind: 'approval', url: 'https://pay.partner.example/approve?s=1', expires_at: '2026-11-17T12:30:00.000Z', open_mode: 'popup' },
    payment_card: { label: 'Visa', last4: '4242' },
  });
  const h = harness({ answers: [{ status: 200, body: approve }] });
  h.start();
  await settle();
  assert.match(h.text(), /Pay with Visa ending 4242/);

  const done = view({
    state: 'completed', screen: 'done', terminal: true, action: null, poll_after_seconds: null,
    amounts: { unit_price_minor: 1800, quoted_total_minor: 2349, final_total_minor: 2349, shipping_minor: 399, tax_minor: 150 },
    order: { reference: '#1001', status_url: null }, payment_card: { label: 'Visa', last4: '4242' },
  });
  const h2 = harness({ answers: [{ status: 200, body: done }] });
  h2.start();
  await settle();
  assert.match(h2.text(), /Paid with Visa ending 4242/);
});

test('card: no card line without one, or with a malformed one', async () => {
  for (const paymentCard of [undefined, { label: 'Visa' }, { label: 'Visa', last4: '42' }, { label: 7, last4: '4242' }]) {
    const approve = view({
      state: 'awaiting_buyer_authorization', screen: 'approve',
      action: { kind: 'approval', url: 'https://pay.partner.example/approve?s=1', expires_at: '2026-11-17T12:30:00.000Z', open_mode: 'popup' },
      ...(paymentCard ? { payment_card: paymentCard } : {}),
    });
    const h = harness({ answers: [{ status: 200, body: approve }] });
    h.start();
    await settle();
    assert.doesNotMatch(h.text(), /Pay with|ending/, JSON.stringify(paymentCard));
    assert.match(h.text(), /Approve your purchase/);
  }
});
