'use strict';

// A WITHHELD ITEM MUST STILL BE NAMED.
//
// #2430 made makeup and fragrance never rebound: when the catalog does not carry the product the model
// chose, the item is withheld and -- the tool description promises -- its name appears in
// metadata.unresolved_archetypes. Live on gateway-00663-tis (2026-10-14) that promise failed on every
// makeup need: "a bronzer for fair skin" came back with zero items and NO unresolved_archetypes. The
// need resolves a step-aware target, and groundRecoRecommendationsFromCatalog drops ungrounded rows
// from a step-aware answer before the door ever sees them, so the partner got a bare empty list.
//
// Driven through the REAL lane and the REAL agent bridge: the model answer is stubbed at the decision
// client, and the catalog is the durable recall pool read through the real cache.

process.env.AURORA_BFF_USE_MOCK = 'false';
process.env.AURORA_DECISION_BASE_URL = 'https://decision.test';
process.env.RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID = 'reco_main_v1_3';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const CLIENT_ID = require.resolve('../src/auroraBff/auroraDecisionClient');
const ROUTES_ID = require.resolve('../src/auroraBff/routes');
const dbModule = require('../src/db');

const url = (id) => `https://agent.pivota.cc/products/${id}`;
const row = ({ id, title, brand, price, label, path }) => ({
  product_id: id, merchant_id: 'external_seed', name: title, brand, price_amount: price, currency: 'USD',
  url: url(id), category: label, product_type: label, catalog_category_path: path,
});

const LIP_BALM = row({ id: 'sig_3388a5e139e21623163e558d86e66741', title: 'Lip Moisturising Stick', brand: 'NUXE', price: 9.2, label: 'Bronzer', path: 'beauty/makeup/lip/balm' });
const TONER = row({ id: 'sig_4ae2f3eb519adb37a98c4b39cfe1aa7e', title: 'Black Rice Probiotics Barrier Serum Mist', brand: 'Example', price: 24, label: 'toner', path: 'beauty/skincare/tone/toner' });

async function askAgentDoor({ need, answer, pool, constraints }) {
  delete require.cache[ROUTES_ID];
  delete require.cache[CLIENT_ID];
  const client = require('../src/auroraBff/auroraDecisionClient');
  const originalChat = client.auroraChat;
  const originalQuery = dbModule.query;
  client.auroraChat = async () => ({ answer: JSON.stringify(answer) });
  dbModule.query = async (sql) => (/SELECT payload/.test(sql)
    ? { rows: [{ payload: pool, refreshed_at: new Date().toISOString() }] }
    : { rows: [], rowCount: 0 });
  try {
    const { makeRecommendProducts } = require('../src/agentSignals/recommendProducts');
    const { __internal } = require('../src/auroraBff/routes');
    const handler = makeRecommendProducts({
      generate: __internal.generateProductRecommendations,
      isEnabled: () => true,
      budgetMs: 6000,
    });
    return await handler({ payload: { need, ...(constraints ? { constraints } : {}) } }, { agent_id: 'partner_test' });
  } finally {
    client.auroraChat = originalChat;
    dbModule.query = originalQuery;
    delete require.cache[ROUTES_ID];
    delete require.cache[CLIENT_ID];
  }
}

const answer = (items) => ({ recommendations: items, confidence: 0.9, warnings: [], missing_info: [] });

test('live repro: a step-aware bronzer need whose pick is withheld still names it', async () => {
  const out = await askAgentDoor({
    need: "a bronzer for fair skin that isn't too orange",
    answer: answer([{ name: 'Hoola Matte Bronzer', brand: 'Benefit', product_type: 'bronzer', score: 90 }]),
    pool: [LIP_BALM],
  });
  assert.deepEqual(out.signals, [], 'the lip balm is still not served');
  assert.ok(!JSON.stringify(out).includes(LIP_BALM.product_id));
  assert.deepEqual(out.metadata.unresolved_archetypes, ['Hoola Matte Bronzer'],
    `the withheld pick must be named; metadata was ${JSON.stringify(out.metadata)}`);
  // And the reason says the lane answered with nothing buyable -- not that the catalog pool was empty,
  // which is what the step-aware reason computed over the already-emptied list would claim.
  assert.equal(out.metadata.products_empty_reason, 'no_grounded_recommendations');
  assert.equal(out.metadata.ungrounded_suppressed, 1);
});

test('an item the model gave no name is not reported under a placeholder', async () => {
  // Normalization fills a blank name from the use case or a humanized type ("skincare product") --
  // text no partner should read as a product the model chose, least of all on a bronzer need.
  const out = await askAgentDoor({
    need: "a bronzer for fair skin that isn't too orange",
    answer: answer([{ product_type: 'bronzer', use_case: 'warm undertone', score: 80 }]),
    pool: [LIP_BALM],
  });
  assert.deepEqual(out.signals, []);
  assert.equal(out.metadata.unresolved_archetypes, undefined, JSON.stringify(out.metadata));
  // Unnamed, but still withheld: the answer says nothing buyable, not "the catalog pool was empty".
  assert.equal(out.metadata.products_empty_reason, 'no_grounded_recommendations');
  assert.equal(out.metadata.ungrounded_suppressed, 1);
});

test('a price ceiling\'s catalog top-up never surfaces as a withheld archetype', async () => {
  // applyStrictConformingTopUp appends catalog rows to the model's answer BEFORE grounding. Their titles
  // name buyable products -- here the very toner the gate refused for this need. Reported as withheld
  // archetypes, a partner could search_catalog the name and serve what the gate blocked.
  const out = await askAgentDoor({
    need: 'a setting mist that keeps makeup in place',
    constraints: { price_max: 30 },
    answer: answer([{ name: 'All Nighter Setting Spray', brand: 'Urban Decay', product_type: 'setting spray', score: 88 }]),
    pool: [TONER],
  });
  assert.ok(!JSON.stringify(out).includes(TONER.name), JSON.stringify(out.metadata));
  assert.deepEqual(out.metadata.unresolved_archetypes, ['All Nighter Setting Spray']);
  assert.equal(out.metadata.ungrounded_suppressed, 1);
});

test('a non-step-aware answer counts its ungrounded item once', async () => {
  // Without a step-aware target the ungrounded row is NOT dropped by grounding: it reaches the door and
  // is counted there. Mutant killed: computing withheld names on every answer -- the same item would be
  // counted twice and named twice before dedupe.
  const out = await askAgentDoor({
    need: 'something to make my face look glowy for a party',
    answer: answer([{ name: 'Radiance Glow Drops', brand: 'Example', score: 80 }]),
    pool: [],
  });
  assert.deepEqual(out.signals, []);
  assert.deepEqual(out.metadata.unresolved_archetypes, ['Radiance Glow Drops']);
  assert.equal(out.metadata.ungrounded_suppressed, 1);
});

test('the setting-mist NEED is not answered with a skincare toner, whatever the model typed', async () => {
  // Live: "a setting mist that keeps makeup in place all day" grounded to a skincare serum mist. The
  // model's own item carried no makeup word (a "Facial Mist" typed toner), so a gate that reads only
  // the item let the toner through. The buyer's need is what the substitute must answer.
  const out = await askAgentDoor({
    need: 'a setting mist that keeps makeup in place all day',
    answer: answer([{ name: 'All Day Hydrating Facial Mist', brand: 'Example Mist Co', product_type: 'toner', score: 85 }]),
    pool: [TONER],
  });
  assert.ok(!JSON.stringify(out.signals).includes(TONER.product_id), 'the toner must not stand in for a setting mist');
  assert.ok((out.metadata.unresolved_archetypes || []).includes('All Day Hydrating Facial Mist'),
    `and the withheld pick is named; metadata was ${JSON.stringify(out.metadata)}`);
});

test('a need that only DESCRIBES makeup is still a skincare need, and keeps its substitute', async () => {
  // End-to-end control for the need rule: "under makeup" is context, not an ask. (The unmasked-need
  // mutant is killed by the gate's unit test on "a toner to wear under foundation".)
  const out = await askAgentDoor({
    need: 'a hydrating toner that sits well under makeup',
    answer: answer([{ name: 'Supple Preparation Facial Toner', brand: 'Dear, Klairs', product_type: 'toner', score: 85 }]),
    pool: [TONER],
  });
  assert.equal(out.signals.length, 1);
  assert.equal(out.signals[0].value.product.product_id, TONER.product_id);
});

test('control: a skincare need still gets its compatible substitute', async () => {
  const out = await askAgentDoor({
    need: 'a hydrating toner for dry skin',
    answer: answer([{ name: 'Supple Preparation Facial Toner', brand: 'Dear, Klairs', product_type: 'toner', score: 85 }]),
    pool: [TONER],
  });
  assert.equal(out.signals.length, 1);
  assert.equal(out.signals[0].value.product.product_id, TONER.product_id);
  assert.equal(out.signals[0].value.lane_confidence.basis, 'catalog_rebound');
});

test('the door keeps every withheld name, up to its own cap -- not the 6-item default', async () => {
  const { makeRecommendProducts } = require('../src/agentSignals/recommendProducts');
  const names = Array.from({ length: 9 }, (_, i) => `Withheld Pick ${i + 1}`);
  const out = await makeRecommendProducts({
    isEnabled: () => true,
    generate: async () => ({ norm: { payload: { recommendations: [], unresolved_archetypes: names } } }),
  })({ need: 'a bronzer' });
  // Mutant killed: asStringArray(payload.unresolved_archetypes) with its default max of 6.
  assert.deepEqual(out.metadata.unresolved_archetypes, names);
  assert.equal(out.metadata.ungrounded_suppressed, 9);
});

test('withheld names reach the lane payload on the agent door only; typed and chat gain no field', async () => {
  // The REAL lane, called the way each door calls it. Mutant killed: setting the field whatever the door.
  const runLane = async (doorArgs) => {
    delete require.cache[ROUTES_ID];
    delete require.cache[CLIENT_ID];
    const client = require('../src/auroraBff/auroraDecisionClient');
    const originalChat = client.auroraChat;
    const originalQuery = dbModule.query;
    client.auroraChat = async () => ({ answer: JSON.stringify(answer([{ name: 'Hoola Matte Bronzer', brand: 'Benefit', product_type: 'bronzer', score: 90 }])) });
    dbModule.query = async (sql) => (/SELECT payload/.test(sql)
      ? { rows: [{ payload: [LIP_BALM], refreshed_at: new Date().toISOString() }] }
      : { rows: [], rowCount: 0 });
    try {
      const { __internal } = require('../src/auroraBff/routes');
      const need = "a bronzer for fair skin that isn't too orange";
      const out = await __internal.generateProductRecommendations({
        ctx: { request_id: 'r', lang: 'EN' }, profile: null, recentLogs: [], message: need, focus: need,
        includeAlternatives: false, debug: false, logger: null, promptDomainScope: 'beauty', ...doorArgs,
      });
      return out && out.norm && out.norm.payload;
    } finally {
      client.auroraChat = originalChat;
      dbModule.query = originalQuery;
      delete require.cache[ROUTES_ID];
      delete require.cache[CLIENT_ID];
    }
  };
  const agent = await runLane({ recoTriggerSource: 'agent_tool', entryType: 'direct' });
  assert.deepEqual(agent.unresolved_archetypes, ['Hoola Matte Bronzer']);
  const typed = await runLane({ recoTriggerSource: 'typed_reco', entryType: 'direct' });
  assert.equal(typed.unresolved_archetypes, undefined);
  const chat = await runLane({ recoTriggerSource: null, entryType: 'chat' });
  assert.equal(chat.unresolved_archetypes, undefined);
});

const TONER_2 = row({ id: 'sig_8888888888888888888888888888bbbb', title: 'Rose Water Hydrating Toner', brand: 'Example Two', price: 18, label: 'toner', path: 'beauty/skincare/tone/toner' });

test('a price ceiling does not top up a setting-mist need with skincare toners', async () => {
  // Live on gateway-00669-wof (2026-10-14), {price_max: 30} on "a setting mist that keeps makeup in
  // place" served a toner as item 1, basis 'positional': applyStrictConformingTopUp filled the
  // shortlist with catalog rows of the resolved step (toner -- the resolver reads "mist" as toner), and
  // filler grounds as itself, so the rebound gate never saw it.
  const out = await askAgentDoor({
    need: 'a setting mist that keeps makeup in place',
    constraints: { price_max: 30 },
    answer: answer([{ name: 'All Nighter Setting Spray', brand: 'Urban Decay', product_type: 'setting spray', score: 88 }]),
    pool: [TONER, TONER_2],
  });
  const served = JSON.stringify(out.signals);
  assert.ok(!served.includes(TONER.product_id) && !served.includes(TONER_2.product_id),
    `no toner may be served for a setting-mist need; signals were ${served}`);
  assert.ok(!JSON.stringify(out).includes(TONER.name) && !JSON.stringify(out).includes(TONER_2.name));
});

test('control: a skincare need under a price ceiling still gets its top-up', async () => {
  const out = await askAgentDoor({
    need: 'a hydrating toner for dry skin',
    constraints: { price_max: 30 },
    answer: answer([{ name: 'Supple Preparation Facial Toner', brand: 'Dear, Klairs', product_type: 'toner', score: 85 }]),
    pool: [TONER, TONER_2],
  });
  const bases = out.signals.map((signal) => signal.value.lane_confidence.basis);
  // Mutant killed: skipping the top-up on every agent-door call.
  assert.ok(bases.includes('positional'), `the ceiling's filler must still be appended; bases were ${JSON.stringify(bases)}`);
});
