'use strict';

// Single source of truth for the "is this merchant transaction-capable?" serving
// predicate. Historically every serving/discovery query hard-gated on
// `merchant_onboarding.psp_connected = true` (a merchant could only be served if it
// had connected its own PSP). That structurally excluded protocol-lane merchants
// (ACP/UCP/AP2/MCP) who can transact WITHOUT their own PSP integration — see
// docs/fixplan_2026-07-12_A_protocol_checkout_activation.md (founder decision: option
// (ii), capability-based gate relaxation).
//
// This helper centralizes the predicate so the gate lives in ONE place:
//   - flag OFF (default): exactly today's behavior — psp_connected must be true.
//     `COALESCE(<a>.psp_connected, false) = true` is row-set-identical to the legacy
//     `<a>.psp_connected = true` AND to `COALESCE(psp_connected, false) = true`: under
//     Postgres 3-valued logic all three admit ONLY true and exclude both false and NULL.
//   - flag ON (AGENT_CHECKOUT_CAPABILITY_GATE=1): psp_connected OR protocol-capable,
//     where protocol-capable = the merchant has a row in `pcs_merchant_capabilities`
//     (minted by pivota-backend once a protocol/checkout integration is verified).
//
// NOTE ON `merchant_ucp_keys`: the fix plan lists it as a second capability signal,
// but that table does NOT yet exist in pivota-backend. Referencing a non-existent
// relation errors at PARSE time (before the runtime `to_regclass` guard could fire),
// so it is deliberately NOT referenced here. When the table lands, add it to
// CAPABILITY_TABLES below (guarded by its own presence).

// Allowed SQL identifier (table alias / column-qualifier). Anything else falls back to
// the default so a caller can never inject SQL through the alias parameter.
function normalizeAlias(alias, fallback) {
  const text = String(alias || '').trim();
  return /^[a-z_][a-z0-9_]*$/i.test(text) ? text : fallback;
}

function isCapabilityGateEnabled() {
  return String(process.env.AGENT_CHECKOUT_CAPABILITY_GATE || '').trim() === '1';
}

// The capability tables that mark a merchant protocol-capable. Existence of a row keyed
// by merchant_id is the signal (pivota-backend only writes a row after a successful
// integration verify). Kept as a list so `merchant_ucp_keys` can be added when it exists.
const CAPABILITY_TABLES = [
  { table: 'pcs_merchant_capabilities', alias: 'pmc_cap' },
];

// Serving/discovery WHERE fragment for "transaction-capable merchant", parameterized by
// the merchant_onboarding alias used in the surrounding query (e.g. 'mo'; pass the bare
// table name 'merchant_onboarding' for un-aliased queries).
//
// @param {string} onboardingAlias  merchant_onboarding alias/qualifier (default 'mo')
// @param {object} [opts]
// @param {boolean} [opts.capabilityGate]  force gate on/off (defaults to the env flag)
// @returns {string} a boolean SQL fragment safe to drop into a WHERE/AND context
function transactionCapableMerchantWhere(onboardingAlias = 'mo', opts = {}) {
  const a = normalizeAlias(onboardingAlias, 'mo');
  const pspPredicate = `COALESCE(${a}.psp_connected, false) = true`;

  const gateOn = opts.capabilityGate === undefined
    ? isCapabilityGateEnabled()
    : Boolean(opts.capabilityGate);

  if (!gateOn) {
    return pspPredicate;
  }

  // Non-correlated `IN (subquery)` (not a correlated EXISTS): merchant_id is a non-null
  // PK on every capability table, and the `IS NOT NULL` guard keeps the IN list NULL-free,
  // so `<a>.merchant_id IN (...)` is false (never NULL) for a non-matching merchant. The
  // non-correlated form is also simpler for the planner and directly executable in tests.
  const capabilityInLists = CAPABILITY_TABLES.map(({ table }) => {
    const t = normalizeAlias(table, 'pcs_merchant_capabilities');
    return `${a}.merchant_id IN (
        SELECT ${t}.merchant_id FROM ${t} WHERE ${t}.merchant_id IS NOT NULL
      )`;
  }).join('\n      OR ');

  return `(
      ${pspPredicate}
      OR ${capabilityInLists}
    )`;
}

module.exports = {
  CAPABILITY_TABLES,
  isCapabilityGateEnabled,
  transactionCapableMerchantWhere,
};
