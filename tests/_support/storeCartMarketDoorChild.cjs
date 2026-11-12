'use strict';

// One process = one boot of the real doors over the fixture (storeCartMarketDoor.cjs), running THE REQUEST SET once
// per phase: with AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET unset ("off"), then set ("on"). The flag is read per
// call, so both phases share the process. Prints ONE line: `DOOR_RESULT {off, on}`.
//
// Usage: node tests/_support/storeCartMarketDoorChild.cjs <port>
// Env:   DOOR_TREE_ROOT   serve another checkout of this repo (a differential's base tree)
//        DOOR_PHASES      'off' | 'on' | 'off,on' (default)

const support = require('./storeCartMarketDoor.cjs');

const door = support.bootDoor({
  ...(process.env.DOOR_TREE_ROOT ? { root: process.env.DOOR_TREE_ROOT } : {}),
  port: Number(process.argv[2]) || 4472,
});

(async () => {
  const out = {};
  await door.listen();
  try {
    for (const phase of String(process.env.DOOR_PHASES || 'off,on').split(',')) {
      door.reset();
      out[phase] = await door.withFlag(phase === 'on', () => support.runRequests(door));
    }
  } finally {
    await door.close();
  }
  process.stdout.write(`DOOR_RESULT ${JSON.stringify(out)}\n`, () => process.exit(0));
})().catch((e) => {
  process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
