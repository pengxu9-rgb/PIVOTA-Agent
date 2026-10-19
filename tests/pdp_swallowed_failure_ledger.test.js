const {
  beginPdpFailureLedger,
  noteSwallowedPdpFailure,
  pdpFailureLedgerIsClean,
  pdpFailureLedgerLabels,
  swallowPdpFailure,
} = require('../src/services/pdpSwallowedFailureLedger');

// The ledger decides whether get_pdp_v2 may call a miss settled. Its failure mode
// must be "not clean", never "clean".

const inFreshContext = (fn) =>
  new Promise((resolve, reject) => {
    setImmediate(() => {
      Promise.resolve().then(fn).then(resolve, reject);
    });
  });

describe('pdpSwallowedFailureLedger', () => {
  test('fails closed with no ledger active', async () => {
    await inFreshContext(() => {
      noteSwallowedPdpFailure('ignored');
      expect(pdpFailureLedgerIsClean()).toBe(false);
    });
  });

  test('a fresh ledger is clean until something is swallowed', async () => {
    await inFreshContext(async () => {
      beginPdpFailureLedger();
      expect(pdpFailureLedgerIsClean()).toBe(true);
      const value = await Promise.reject(new Error('boom')).catch(swallowPdpFailure('lookup'));
      expect(value).toBeNull();
      expect(pdpFailureLedgerIsClean()).toBe(false);
      expect(pdpFailureLedgerLabels()).toEqual(['lookup']);
    });
  });

  test("one request's failures never reach another request's ledger", async () => {
    let releaseA;
    const gateA = new Promise((resolve) => {
      releaseA = resolve;
    });
    const a = inFreshContext(async () => {
      beginPdpFailureLedger();
      await gateA;
      noteSwallowedPdpFailure('a');
      return pdpFailureLedgerIsClean();
    });
    const b = inFreshContext(async () => {
      beginPdpFailureLedger();
      releaseA();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return pdpFailureLedgerIsClean();
    });
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(true);
  });

  test('src/db records a failed query on the ledger and rethrows it unchanged', async () => {
    jest.resetModules();
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const db = require('../src/db');
      const ledger = require('../src/services/pdpSwallowedFailureLedger');
      await inFreshContext(async () => {
        ledger.beginPdpFailureLedger();
        await expect(db.query('SELECT 1')).rejects.toBeTruthy();
        expect(ledger.pdpFailureLedgerIsClean()).toBe(false);
        expect(ledger.pdpFailureLedgerLabels()).toEqual(['db_query']);
      });
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});
