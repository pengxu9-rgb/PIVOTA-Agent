// THE ACP CREATE DOOR, OVER REAL HTTP, WITH EVERYTHING AROUND IT CONTROLLABLE.
//
// REAL: an HTTP listener on loopback, the ACP route table (acpRestRoutes.js), the ACP adapter (its signature
// check, its intake, its create claim), the canonical executor, the kernel and its quote registry, and the session
// store under test: the in-process store, or the Postgres store over the shared SQL-semantics fake (fakePgDb.js).
//
// CONTROLLED BY THE TEST, so that an interleaving is a sequence of statements and never a sleep:
//   - the CLOCK (`clock.advance(ms)`): the adapter, the kernel and both stores read this one clock;
//   - the PRICER (`pricer.script(...)`): what each `preview_quote` call does, in order. A step may be a GATE: the
//     call waits inside the pricer until the test lets it go, with the outcome the test chooses;
//   - the SESSION STORE (`store.before[name]`, `store.after[name]`): a function run before, or after, one kind of
//     store call, which may wait or throw.
//
// `root` is the directory whose `src/` is loaded, so a private differential harness can boot this file's door
// over two trees. Every name is a placeholder.

import http from 'node:http';
import { createHmac } from 'node:crypto';
import { makeFakePgDb } from './fakePgDb.js';

export const SECRET = 'acp-signing-secret-0123456789abcdef';
const KERNEL_SECRET = 'acp-kernel-secret-0123456789abcdef';
export const T0 = 1_900_000_000_000;
export const UNIT_MINOR = 1800;
// The stub pricer's own table: the currency it prices a ship-to country in. A country it has no currency for is
// refused by name. A cart that names no destination is priced in the merchant's own currency.
export const PRICER_CURRENCY = Object.freeze({ US: 'USD', SG: 'SGD', GB: 'GBP' });
export const PRICER_MERCHANT_CURRENCY = 'USD';
export const MARKET_NOT_PRICED = 'market_not_priced';

const quiet = { info() {}, warn() {}, error() {} };

/** A cart for the placeholder merchant. `country` null = the cart names no destination. */
export function cart(quantity = 1, country = 'US', { variant = 'v1' } = {}) {
  return {
    merchant_id: 'merch_A',
    buyer: { email: 'buyer@example.test' },
    items: [{ product_id: 'p1', variant_id: variant, quantity }],
    ...(country === null ? {} : {
      fulfillment_address: { name: 'Example Buyer', address_line1: '1 Example Street', city: 'Springfield', postal_code: '00000', country },
    }),
  };
}

/** A gate: a pricer step that waits. `entered` resolves when the pricer is inside it; `open(step)` lets it go. */
export function gate() {
  let enter;
  let open;
  const entered = new Promise((resolve) => { enter = resolve; });
  const opened = new Promise((resolve) => { open = resolve; });
  return { entered, open: (step) => open(step), _enter: enter, _opened: opened };
}

/**
 * @param {{ root?: URL|string, port: number, storeKind?: 'memory'|'postgres', conditionalStore?: boolean }} o
 *   conditionalStore false = the session store offers get/set/putIfAbsent only.
 */
export async function bootAcpCreateDoor({ root = new URL('../../', import.meta.url), port, storeKind = 'memory', conditionalStore = true } = {}) {
  const from = (p) => import(new URL(p, root).href);
  const { SafetyKernel } = await from('src/kernel.js');
  const { InMemoryKvStore } = await from('src/stores.js');
  const { PostgresKvStore } = await from('src/stores/postgresKvStore.js');
  const { PivotaCommerceError } = await from('src/errors.js');
  const { createCanonicalExecutor } = await from('src/protocol/canonicalExecutor.js');
  const { createAcpRestAdapter } = await from('src/protocol/acpRestAdapter.js');
  const { createAcpRouteHandlers } = await from('src/protocol/acpRestRoutes.js');

  let t = T0;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };

  // ---- the pricer ---------------------------------------------------------------------------------------------
  const refusal = (code, detail) => new PivotaCommerceError(code, detail);
  // The errors the gateway's transport raises for a pricer call (src/server.js throwCommerceKernelUpstreamError).
  const answered = (status, code = 'MERCHANT_UNAVAILABLE', upstreamCode = null) =>
    refusal(code, { operation: 'preview_quote', upstream_status: status, upstream_code: upstreamCode });
  const timedOut = () => refusal('MERCHANT_UNAVAILABLE', { operation: 'preview_quote', upstream_status: null, upstream_code: null, upstream_timeout: true });
  const connectionLost = () => refusal('MERCHANT_UNAVAILABLE', { operation: 'preview_quote', upstream_status: null, upstream_code: null });

  const pricer = { calls: [], quotes: [], steps: [] };
  /** Queue what the next pricer calls do. A step: 'price', a gate(), or a function of the payload. */
  pricer.script = (...steps) => { pricer.steps.push(...steps); };
  const price = (payload) => {
    const quote = payload?.quote ?? {};
    const country = quote.shipping_address?.country;
    const currency = country === undefined ? PRICER_MERCHANT_CURRENCY : PRICER_CURRENCY[country];
    if (!currency) throw answered(422, 'MERCHANT_UNAVAILABLE', MARKET_NOT_PRICED);
    const subtotal = (quote.items ?? []).reduce((n, item) => n + UNIT_MINOR * Number(item.quantity), 0);
    const quoteId = `uq_${String(pricer.quotes.length + 1).padStart(4, '0')}`;
    pricer.quotes.push({ quote_id: quoteId, currency, country: country ?? null });
    return {
      quote_id: quoteId, merchant_of_record: quote.merchant_id, currency,
      locked_totals: { subtotal, tax: 0, shipping: 0, total: subtotal },
      line_items: (quote.items ?? []).map((item) => ({ product_id: item.product_id, variant_id: item.variant_id, quantity: item.quantity })),
      acp_state: {},
    };
  };
  const runStep = async (step, payload) => {
    if (step === undefined || step === 'price') return price(payload);
    if (typeof step === 'function') return step(payload);
    if (step && step._opened) {
      step._enter();
      return runStep(await step._opened, payload);
    }
    throw new Error('unknown pricer step');
  };
  const kernelUpstream = async (op, payload) => {
    if (op !== 'preview_quote') return {};
    pricer.calls.push(payload);
    return runStep(pricer.steps.shift(), payload);
  };

  // ---- the stores ---------------------------------------------------------------------------------------------
  const kernelStores = new Map();
  const quoteStore = { before: {} };
  const storeFactory = (namespace) => {
    if (!kernelStores.has(namespace)) {
      const inner = new InMemoryKvStore({ now: clock.now });
      if (namespace === 'quotes') {
        const real = inner.set.bind(inner);
        inner.set = async (...args) => { if (quoteStore.before.set) await quoteStore.before.set(...args); return real(...args); };
      }
      kernelStores.set(namespace, inner);
    }
    return kernelStores.get(namespace);
  };
  const pg = makeFakePgDb(clock.now);
  const inner = storeKind === 'postgres'
    ? new PostgresKvStore({ db: pg, namespace: 'acp_sessions', now: clock.now })
    : new InMemoryKvStore({ now: clock.now });
  const store = { before: {}, after: {}, calls: [], inner };
  const through = (name) => async (...args) => {
    store.calls.push({ name, key: args[0] });
    if (store.before[name]) await store.before[name](...args);
    const result = await inner[name](...args);
    if (store.after[name]) await store.after[name](...args);
    return result;
  };
  const sessionStore = { get: through('get'), set: through('set'), putIfAbsent: through('putIfAbsent') };
  if (conditionalStore) Object.assign(sessionStore, { compareAndSet: through('compareAndSet'), compareAndDelete: through('compareAndDelete'), delete: through('delete') });
  /** Every key the store holds a live value for, with the value. */
  store.live = async () => {
    const keys = storeKind === 'postgres'
      ? [...pg.rows.keys()].map((k) => k.slice('acp_sessions '.length))
      : [...inner._m.keys()];
    const out = [];
    for (const key of keys) {
      const value = await inner.get(key);
      if (value !== undefined) out.push({ key, value });
    }
    return out;
  };
  const isClaimKey = (key) => key.startsWith('["acpcreate"');
  store.claims = async () => (await store.live()).filter((row) => isClaimKey(row.key));
  store.sessions = async () => (await store.live()).filter((row) => !isClaimKey(row.key));
  store.claimKey = (buyer, key) => JSON.stringify(['acpcreate', buyer, key]);

  // ---- the door -----------------------------------------------------------------------------------------------
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: KERNEL_SECRET, log: quiet, now: clock.now, storeFactory });
  const executor = createCanonicalExecutor({ kernel, upstream: async () => ({}), verifyPaymentAuthorization: async () => ({ ok: false }) });
  const adapter = createAcpRestAdapter({
    executor, sessionStore, signingSecret: SECRET, now: clock.now,
    resolveUserRef: async (req) => req.headers['x-test-buyer'],
  });
  const routes = createAcpRouteHandlers(adapter, { basePath: '/acp' }).map((route) => ({
    ...route,
    names: [...route.path.matchAll(/:([a-z_]+)/g)].map((m) => m[1]),
    pattern: new RegExp(`^${route.path.replace(/:[a-z_]+/g, '([^/]+)')}$`),
  }));
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      let out = { status: 404, headers: {}, body: { type: 'error', code: 'NOT_FOUND' } };
      for (const route of routes) {
        const match = route.method === req.method ? route.pattern.exec(path) : null;
        if (!match) continue;
        const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
        out = await route.handler({ headers: req.headers, rawBody: Buffer.concat(chunks), params });
        break;
      }
      res.writeHead(out.status, out.headers);
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((resolve) => { server.listen(port, '127.0.0.1', resolve); });

  /** One signed request on a fresh connection. `key` undefined = no Idempotency-Key header. */
  function send(method, subPath, bodyObj, { key, buyer = 'buyer_1' } = {}) {
    const rawBody = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const ts = String(clock.now());
    const headers = {
      timestamp: ts,
      signature: createHmac('sha256', SECRET).update(`${ts}.${rawBody}`).digest('hex'),
      connection: 'close',
      ...(buyer ? { 'x-test-buyer': buyer } : {}),
      ...(key !== undefined ? { 'idempotency-key': key } : {}),
      ...(rawBody ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(rawBody) } : {}),
    };
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: `/acp${subPath}`, agent: false, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, text, body: JSON.parse(text) });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(rawBody || undefined);
    });
  }
  const create = (body, opts) => send('POST', '/checkout_sessions', body, opts);
  const read = (id, opts) => send('GET', `/checkout_sessions/${id}`, undefined, opts);
  // A failed test can leave a request waiting in a gate that nobody will open: its connection is dropped, so the
  // listener closes and the failure is reported, instead of the file waiting for ever.
  const close = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });

  return { send, create, read, close, clock, pricer, store, quoteStore, kernelStores, refusal, answered, timedOut, connectionLost };
}
