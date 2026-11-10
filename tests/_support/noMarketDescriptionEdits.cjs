'use strict';

// DECISION D-10 (2026-11-08) changed what the tool descriptions may truthfully say about a call that names no
// market: it is now answered for a US buyer and says so in `market_assumed`. These are the ONLY description edits it
// made, as [now, before] pairs, in the text tools/list publishes. A golden test that pins a tools/list body captured
// before D-10 reverses exactly these and compares the rest byte for byte, so any OTHER change still fails it.
const NO_MARKET_DESCRIPTION_EDITS = Object.freeze([
  ["whenever you know it: without it the product is answered for a US buyer, and the answer says so in `market_assumed`.",
    "whenever you know it: without it nothing is read live and the price is Pivota's stored one."],
  ["Without it the product is answered, and read live, for a US buyer, and the answer carries `market_assumed`; a market is never inferred",
    "Without it nothing is read live (`product.live_read.reason: no_market`); a market is never inferred"],
  ["Absent, the offers are decided for a US buyer (USD offers, US cart links), and the answer carries `market_assumed`.",
    "Absent, no market is claimed and offers come back referral-only, in whatever currency each is priced."],
  ["Buyer country (ISO 3166-1 alpha-2). Absent, the search is answered for a US buyer and the answer carries `market_assumed`.",
    "Buyer country (ISO 3166-1 alpha-2)."],
  ["Without it the product is answered for a US buyer, and the answer says so in `market_assumed`. A price here is for",
    "Without it the price is Pivota's stored one. A price here is for"],
  ["absent, they are decided for a US buyer and the answer carries `market_assumed`), `insights.limit`",
    "absent, no market is claimed), `insights.limit`"],
  ["It is never inferred; without it the product is answered for a US buyer (`market_assumed` says so); `messages` says",
    "It is never inferred, and without it the price is Pivota's stored one; `messages` says"],
  ["Buyer market, ISO 3166-1 alpha-2. Read. Absent, the search is answered for a US buyer and the answer carries `market_assumed`.",
    "Buyer market, ISO 3166-1 alpha-2. Read."],
]);

/** The text with every D-10 description edit reversed (each occurrence). */
function revertNoMarketDescriptionEdits(text) {
  let out = String(text);
  for (const [now, before] of NO_MARKET_DESCRIPTION_EDITS) out = out.split(now).join(before);
  return out;
}

module.exports = { NO_MARKET_DESCRIPTION_EDITS, revertNoMarketDescriptionEdits };
