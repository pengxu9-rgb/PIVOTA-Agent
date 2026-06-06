#!/usr/bin/env node
// Staging validation — exercises the durable store + Safety Kernel money path against a REAL Postgres.
// This is the step that retires the "never run against real SQL" risk BEFORE any prod money op.
//
// SAFETY: uses a STUB upstream (no real merchant, no PSP, no charge) and a throwaway namespace prefix;
// it only touches the `commerce_kv` table and cleans up after itself. No real money or orders.
//
// Usage:
//   DATABASE_URL=postgres://user:pass@staging-host:5432/db \
//     node safety-kernel/scripts/validate-commerce-kv-staging.mjs
//
// Optional: COMMERCE_KV_VALIDATE_NS_PREFIX (default: a unique 'validate_<ts>' prefix).

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { PostgresKvStore } from '../src/stores/postgresKvStore.js';
import { createCommerceMount } from '../src/mount.js';

const require = createRequire(import.meta.url);

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('FAIL: set DATABASE_URL to a staging Postgres (NOT prod).');
  process.exit(2);
}
// Guard rail: refuse a production-looking URL unless explicitly forced. (Defense-in-depth — the real
// safety is that EVERY row this script writes is under a unique throwaway `validate_<ts>` namespace,
// so even a misfire only creates+deletes its own rows; see NS below.) `live` is intentionally NOT in
// the list — it false-matches hosts like `delivery-*`; rely on namespace isolation + the override.
if (/prod|production|prd/i.test(DATABASE_URL) && process.env.ALLOW_PROD_VALIDATION !== '1') {
  console.error('REFUSING: DATABASE_URL looks like production (matched prod/production/prd). Use staging, or set ALLOW_PROD_VALIDATION=1 to override.');
  process.exit(2);
}

const NS = `${process.env.COMMERCE_KV_VALIDATE_NS_PREFIX || 'validate'}_${Date.now()}`;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m, e) => { console.error(`  ✗ ${m}${e ? ': ' + (e.stack || e) : ''}`); process.exitCode = 1; };

const { Pool } = require('pg');
const pool = new Pool({ connectionString: DATABASE_URL });
const db = { query: (text, params) => pool.query(text, params) };

async function migrate() {
  await db.query(`CREATE TABLE IF NOT EXISTS commerce_kv (
    ns text NOT NULL, k text NOT NULL, v jsonb NOT NULL,
    expires_at timestamptz NULL, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (ns, k))`, []);
  await db.query(`CREATE INDEX IF NOT EXISTS commerce_kv_expires_idx ON commerce_kv (expires_at) WHERE expires_at IS NOT NULL`, []);
}

async function cleanup() {
  // Delete every namespace this run created (the store namespaces are NS-prefixed).
  await db.query(`DELETE FROM commerce_kv WHERE ns LIKE $1`, [`${NS}%`]);
}

async function testStoreDirect() {
  const s = new PostgresKvStore({ db, namespace: `${NS}_kv` });

  // The JSONB-decode check against REAL pg: store an object, read it back, must be an OBJECT.
  await s.set('obj', { fp: 'x', status: 'done', n: 7 });
  const got = await s.get('obj');
  if (got && typeof got === 'object' && got.status === 'done' && got.n === 7) ok('JSONB round-trips as an object (real pg)');
  else fail(`JSONB decode wrong: got ${JSON.stringify(got)} (type ${typeof got})`);

  // Atomic putIfAbsent.
  const k = `idem_${randomUUID()}`;
  const first = await s.putIfAbsent(k, { owner: 'A' });
  const second = await s.putIfAbsent(k, { owner: 'B' });
  if (first === true && second === false) ok('putIfAbsent atomic (first wins, second loses)');
  else fail(`putIfAbsent wrong: first=${first} second=${second}`);

  // compareAndSet / compareAndDelete by owner.
  const setOwn = await s.compareAndSet(k, 'owner', 'A', { owner: 'A', status: 'done' });
  const setWrong = await s.compareAndSet(k, 'owner', 'Z', { owner: 'Z' });
  if (setOwn === true && setWrong === false) ok('compareAndSet is owner-scoped');
  else fail(`compareAndSet wrong: own=${setOwn} wrong=${setWrong}`);
  const delWrong = await s.compareAndDelete(k, 'owner', 'Z');
  const delOwn = await s.compareAndDelete(k, 'owner', 'A');
  if (delWrong === false && delOwn === true) ok('compareAndDelete is owner-scoped');
  else fail(`compareAndDelete wrong: wrong=${delWrong} own=${delOwn}`);

  // TTL: a short-lived key expires.
  let now = Date.now();
  const ttlStore = new PostgresKvStore({ db, namespace: `${NS}_ttl`, now: () => now });
  await ttlStore.set('exp', 'v', { ttlMs: 1000 });
  if ((await ttlStore.get('exp')) === 'v') ok('TTL: value visible before expiry');
  else fail('TTL: value not visible before expiry');
  now += 2000;
  if ((await ttlStore.get('exp')) === undefined) ok('TTL: value gone after expiry');
  else fail('TTL: value still visible after expiry');
}

async function testMoneyPathThroughMount() {
  // STUB upstream — no real merchant/PSP. Validates the kernel money path against real Postgres.
  const QUOTE = { merchant_of_record: 'validate_merch', currency: 'USD',
    locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
    line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: { acp_session_id: 'acp_v' } };
  const upstream = async (op) => (
    op === 'preview_quote' ? QUOTE
    : op === 'create_order' ? { order_id: `o_${randomUUID()}`, acp_state: {} }
    : op === 'submit_payment' ? { order_id: 'o', payment_id: 'pay_stub', payment_status: 'succeeded' }
    : {});
  const CTX = { user_ref: 'validate_user', acp_session_id: 'acp_v' };
  // Codex P1 fix: prefix ALL kernel store namespaces with this run's throwaway NS, so every row the
  // mount writes (quotes/orders/idempotency/confirmations) is under `${NS}_mount_*` and is covered by
  // the single `finally` cleanup (`ns LIKE '${NS}%'`). No broad delete of real default namespaces.
  const m = createCommerceMount({
    upstream, db, strict: true, secret: 'validate-secret-0123456789abcdef',
    namespacePrefix: `${NS}_mount_`,
    log: { info() {}, warn() {}, error() {} },
  });

  const q = await m.handle('preview_quote', { quote: { merchant_id: 'validate_merch', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  if (!q.ok) return fail(`preview_quote failed: ${q.error?.code}`);
  const o = await m.handle('create_order', { idempotency_key: `idem_${randomUUID()}`, order: { quote_id: q.data.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  if (!o.ok) return fail(`create_order failed: ${o.error?.code}`);
  const token = await m.mintConfirmation({ order_id: o.data.order_id }, CTX);
  const pay = await m.handle('submit_payment', { idempotency_key: `idem_${randomUUID()}`, confirmation_token: token, payment: { order_id: o.data.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  if (pay.ok && pay.data.payment_status === 'succeeded') ok('full quote→order→confirm→pay through the mount on real Postgres');
  else fail(`submit_payment failed: ${pay.error?.code || pay.data?.payment_status}`);
  // All rows are under `${NS}_mount_*` → the single finally cleanup covers them, even on early failure.
}

(async () => {
  console.log(`Commerce-KV staging validation against ${DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@')} (ns=${NS})`);
  try {
    await migrate(); ok('migration applied (commerce_kv)');
    await testStoreDirect();
    await testMoneyPathThroughMount();
  } catch (e) {
    fail('unexpected error', e);
  } finally {
    try { await cleanup(); ok('cleaned validation namespaces'); } catch (e) { fail('cleanup failed', e); }
    await pool.end();
  }
  console.log(process.exitCode ? '\nVALIDATION FAILED.' : '\nVALIDATION PASSED — durable store + money path verified against real Postgres.');
})();
