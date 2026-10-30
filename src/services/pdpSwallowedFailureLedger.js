'use strict';

const { AsyncLocalStorage } = require('async_hooks');

// Did anything on this get_pdp_v2 request FAIL and get swallowed?
//
// get_pdp_v2 reaches its final not-found exit through lookups that swallow their
// own failures: the entry precheck's `.catch(() => null)`, the seed-detail read's
// catch-all, both identity-rescue `.catch(() => null)`s, stage-budget timeouts.
// So "nothing built this product" only means "no such product" when NOTHING on
// the way failed. That is the one question a settled not-found reason
// (readSignatureSeedNotActive) must have answered before it may be emitted. A
// settled reason after a swallowed DB error would turn a healthy product into a
// 404 that agent.pivota.cc's ISR caches for an hour.
//
// A ledger, not a set of flags threaded through each catch, because the swallow
// sites are many, nested, and spread across modules. Two kinds of writers mark it:
//   - src/db wraps every exported query entry point, so ANY database failure in
//     the request (in any module, swallowed or not) is recorded;
//   - withStageBudget timeouts and the swallow sites on get_pdp_v2's not-found
//     path record themselves explicitly. This covers failures that are not DB
//     errors, and test doubles that replace src/db.
//
// Fail closed: with no ledger active (a caller outside get_pdp_v2, or a context
// that was lost), `isClean()` is false. "I cannot tell" is never "nothing failed".
//
// NOT THE GUARANTEE. A clean ledger does not prove every lookup was clean: a
// failure inside another request's shared in-flight promise is recorded on THAT
// request, the identity rescue's own budget timeout is not a db error, and a
// negative cached for 10 minutes carries no record of how it was produced. The
// guarantee is settleSignatureSeedNotActive's fresh, uncaught check; this ledger
// only withholds earlier and cheaper when this request already saw a failure.

const LEDGER = new AsyncLocalStorage();

// Called at the top of the get_pdp_v2 branch. A FRESH store per request, so one
// request's failures can never leak into, or be masked by, another's.
function beginPdpFailureLedger() {
  LEDGER.enterWith({ failures: 0, labels: [] });
}

function noteSwallowedPdpFailure(label) {
  try {
    const store = LEDGER.getStore();
    if (!store) return;
    store.failures += 1;
    if (label && store.labels.length < 16) store.labels.push(String(label));
  } catch {
    // Never let bookkeeping change the path it is observing.
  }
}

// `.catch(swallowPdpFailure('label'))`: same null the old `.catch(() => null)`
// returned, but the failure is on the record.
function swallowPdpFailure(label) {
  return () => {
    noteSwallowedPdpFailure(label);
    return null;
  };
}

function pdpFailureLedgerIsClean() {
  const store = LEDGER.getStore();
  return Boolean(store) && store.failures === 0;
}

function pdpFailureLedgerLabels() {
  const store = LEDGER.getStore();
  return store ? store.labels.slice() : null;
}

module.exports = {
  beginPdpFailureLedger,
  noteSwallowedPdpFailure,
  pdpFailureLedgerIsClean,
  pdpFailureLedgerLabels,
  swallowPdpFailure,
};
