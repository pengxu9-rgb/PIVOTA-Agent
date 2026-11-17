// The shapes of an answer that says the request had no effect ("nothing was done", "nothing was ordered", "no order was
// created", "nothing was charged", "without creating a purchase"). Broad on purpose: a false match only asks for a flag.
// Used by safety-kernel/test/noEffectWordsGated.test.js and tests/checkout_named_refusal_delisted_door.node.test.cjs.
export const NO_EFFECT = /\b(?:nothing\s+(?:was|has\s+been|is)\s+(?:done|written|ordered|charged|created|placed|made|sent|bought)|no\s+order\s+(?:was|has\s+been|is)\s+(?:created|placed|made|written)|nothing\s+was\s+\w+\s+and\s+nothing|without\s+(?:creating|placing|making)\s+(?:a|an|any)\s+(?:order|purchase)|no\s+(?:charge|purchase)\s+(?:was|has\s+been)\s+made)\b/i;
