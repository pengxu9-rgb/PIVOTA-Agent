'use strict';

// EVERY PRODUCTION CALL OF THE PURCHASABILITY GATE NAMES ITS RAIL (client rule 7, pivota-backend #2411).
//
// The rule is cheap to break silently: a new seam that calls `shouldOfferPurchase({ domain, market })`
// gets the card rail by default (the stricter answer), which is correct for a headless charge and an
// over-decline for a cart handed to a human. So this test reads the source and pins, per seam, the
// literal rail it names — and that no seam exists that this file does not know about.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

/** The seams, and the question each one asks. */
const SEAMS = [
  // seam 3: a stamped checkout link / a seed cart, followed by a person
  { file: 'src/offers/offersPriority.js', call: /decision = await gate\(\{[\s\S]*?\}\);/, rail: 'RAIL.human' },
  // seam 1: a warm cart on the merchant's own checkout, paid by a person
  { file: 'src/services/ucpWarmHandoff.js', call: /await shouldOfferPurchaseFn\(\{[\s\S]*?\}\);/, rail: 'PURCHASABILITY_RAIL.human' },
  // seam 2: the escalation continue_url, a person on the storefront
  { file: 'mcp-server/src/ucpCheckoutEscalation.js', call: /return mayOfferPurchaseForDomain\(sellerHostOf\(continueUrl\)[^;]*\);/, rail: 'merchantPurchasability.RAIL.human' },
  // the Reap agentic lane: Pivota charges the card headlessly
  { file: 'mcp-server/src/ucpReapAgenticLane.js', call: /const offer = await mayOfferPurchaseForDomain\([\s\S]*?\);/, rail: 'merchantPurchasability.RAIL.card' },
];

test('each seam names its rail, literally, inside the gate call', () => {
  for (const seam of SEAMS) {
    const src = read(seam.file);
    const m = src.match(seam.call);
    assert.ok(m, `${seam.file}: the gate call was not found (the seam moved: update this pin)`);
    assert.ok(m[0].includes(seam.rail), `${seam.file}: the gate call must name ${seam.rail}:\n${m[0]}`);
  }
});

test('the shared mcp-server helper forwards the rail it was handed, normalised, and nothing else decides it', () => {
  const src = read('mcp-server/src/ucpCheckoutEscalation.js');
  assert.match(src, /export async function mayOfferPurchaseForDomain\(domain, market, gate, gateEnabled, budgetMs, rail\)/);
  const call = src.match(/decision = await gate\(\{[\s\S]*?\}\);/);
  assert.ok(call);
  assert.ok(call[0].includes('rail: merchantPurchasability.normalizeRail(rail)'), call[0]);
});

test('no production gate call site exists that this file does not pin', () => {
  // Every place a seam reaches the client's decision: a `shouldOfferPurchase(` call on a client or module,
  // or an injected gate function being invoked. The client's own definition and its module-level
  // convenience wrapper are not seams.
  const roots = ['src', 'mcp-server/src'];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(js|cjs|mjs)$/.test(entry.name)) files.push(rel);
    }
  };
  roots.forEach(walk);
  const callers = new Set();
  for (const rel of files) {
    const src = read(rel);
    if (rel === 'src/services/merchantPurchasabilityClient.js') continue;
    if (/\.shouldOfferPurchase\(|await gate\(\{|await shouldOfferPurchaseFn\(\{|mayOfferPurchaseForDomain\(/.test(src)) callers.add(rel);
  }
  assert.deepEqual([...callers].sort(), SEAMS.map((s) => s.file).sort(),
    'a new seam reaches the gate: name its rail and pin it above');
});
