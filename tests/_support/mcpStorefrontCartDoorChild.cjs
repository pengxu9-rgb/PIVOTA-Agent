'use strict';

// One process per LOAD-TIME flag combination (PARTNER_DOOR_ONE_PRODUCT_ID and GET_OFFERS_EMPTY_REASON are read
// when the `/mcp` views load). It serves the real doors over the fixture (mcpStorefrontCartDoor.cjs) and runs
// THE REQUEST SET twice in one process: first with AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED unset, then
// with it on (that flag is read per call). Prints ONE line: `DOOR_RESULT {off, on}`.
//
// Usage: node tests/_support/mcpStorefrontCartDoorChild.cjs <port>
// Env:   COMBO_PARTNER_DOOR, COMBO_EMPTY_REASON   '1' to turn that view on
//        DOOR_TREE_ROOT                           serve another checkout of this repo (the differential's base tree)
//        DOOR_PHASES                              'off' | 'on' | 'off,on' (default)

const support = require('./mcpStorefrontCartDoor.cjs');

const FLAG = 'AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED';
const door = support.bootDoor({
  ...(process.env.DOOR_TREE_ROOT ? { root: process.env.DOOR_TREE_ROOT } : {}),
  port: Number(process.argv[2]) || 4396,
  env: {
    PARTNER_DOOR_ONE_PRODUCT_ID: process.env.COMBO_PARTNER_DOOR,
    GET_OFFERS_EMPTY_REASON: process.env.COMBO_EMPTY_REASON,
  },
});

(async () => {
  const out = {};
  await door.listen();
  try {
    for (const phase of String(process.env.DOOR_PHASES || 'off,on').split(',')) {
      if (phase === 'on') process.env[FLAG] = '1';
      else delete process.env[FLAG];
      door.reset();
      out[phase] = await support.runRequests(door);
    }
  } finally {
    delete process.env[FLAG];
    await door.close();
  }
  process.stdout.write(`DOOR_RESULT ${JSON.stringify(out)}\n`, () => process.exit(0));
})().catch((e) => {
  process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
