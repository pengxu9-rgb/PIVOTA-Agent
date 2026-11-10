'use strict';

// One process per flag combination (both flags are read once at load). Env arrives from the parent; this
// child serves the real `/mcp` door over the recorded backend answers and prints ONE JSON line.

const support = require('./getOffersEmptyReasonDoor.cjs');

const wanted = { GET_OFFERS_EMPTY_REASON: process.env.COMBO_EMPTY_REASON, PARTNER_DOOR_ONE_PRODUCT_ID: process.env.COMBO_PARTNER_DOOR };
support.setDoorEnv();
for (const [k, v] of Object.entries(wanted)) {
  if (v) process.env[k] = v;
  else delete process.env[k];
}

const app = require('../../src/server');
const { FIXTURE, answerOf, callGetOffersRaw, listTools } = support;

(async () => {
  const out = { answers: {} };
  for (const name of ['unknown_signature_no_seed', 'mirror_dead_page', 'seed_lookup_failed', 'minted_stale_flagged', 'minted_fresh_offer']) {
    const answer = answerOf(await callGetOffersRaw(app, '/mcp', FIXTURE[name]));
    out.answers[name] = { offer_count: answer.metadata.offer_count, signals: answer.signals.length, metadata: answer.metadata };
  }
  const gbp = { status: 'success', offers: [{ ...FIXTURE.minted_fresh_offer.offers[0], currency: 'GBP' }] };
  out.answers.gbp_only = { metadata: answerOf(await callGetOffersRaw(app, '/mcp', gbp)).metadata };
  const ucp = await callGetOffersRaw(app, '/ucp/mcp', FIXTURE.unknown_signature_no_seed);
  out.ucp = JSON.stringify(ucp.body);
  const tool = (await listTools(app, '/mcp')).find((t) => t.name === 'get_offers');
  out.description = tool.description;
  out.declares_group_id = Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, 'product_group_id');
  process.stdout.write(`COMBO_RESULT ${JSON.stringify(out)}\n`);
  process.exit(0);
})().catch((e) => {
  process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
