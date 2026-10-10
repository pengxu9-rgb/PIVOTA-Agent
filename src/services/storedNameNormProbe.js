'use strict';

// THE FOLD-DRIFT FAIL-SAFE (PIVOTA-Agent #2404 / #2406 review P2-3).
//
// With CANONICAL_CATALOG_STORED_NAME_NORM on, the canonical search reads catalog_products.own_name_norm
// / name_norm, which pivota-backend migration 260 stamps with `catalog_products_identity_fold(text)`:
// a database function that is this repository's `identitySql` character for character. Nothing in
// either repository's tests can see the other, so a later edit to `identitySql` (it has changed
// before) or to the function would silently make the stored column disagree with the live fold.
//
// This module asks the database, ONCE per process and again every RECHECK interval, one cheap
// question: over a fixed sample set (middle dots and bullets, every accent the fold maps, punctuation
// runs, an empty value, mixed case, compatibility numerals), does the stored function return the same
// text as `identitySql` applied live to the same input? If every sample agrees, the stored read is
// allowed. If any sample differs, or the function is missing, or the probe errors, the read behaves
// exactly as with the flag OFF (today's expression) and one ERROR is logged per transition -- and the
// probe is tried again at the next interval, so a repaired function is picked up without a restart.
//
// The probe never runs with the flag off, and callers that race on a cold cache share one query.

const logger = require('../logger');
const { identitySql } = require('./canonicalSearchQualitySql');

const FUNCTION_NAME = 'catalog_products_identity_fold';
const RECHECK_FLAG = 'CANONICAL_CATALOG_STORED_NAME_NORM_RECHECK_MS';

// Each sample exercises one thing the fold does. The full accent table is one sample so a mapping
// slipping by one position is caught; the last two are PostgreSQL's [:alnum:] edge (² and ½ are
// dropped by the fold, and the JS twin documents why).
const SAMPLES = Object.freeze([
  'Rouge·Allure • Velvet',
  'Crème Lancôme Rénergie',
  'TXA Booster Shot, 5% TXA & 10 Peptides (1.01 fl. oz.)',
  '',
  'MiXeD CaSe  Serum!!',
  'ÉCLAT  Doré—Highlighter',
  'ÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝàáâãäåèéêëìíîïòóôõöùúûüýÿ',
  'a²b ½ Ⅻ',
  '  leading and trailing  ',
]);

// `s` is the unnest column; the live side is identitySql over the same `s`.
const PROBE_SQL = `SELECT count(*)::int AS n,
       count(*) FILTER (WHERE ${FUNCTION_NAME}(s) IS NOT DISTINCT FROM ${identitySql('s')})::int AS same
FROM unnest($1::text[]) AS t(s)`;

function recheckMs(env = process.env) {
  const raw = Number(env[RECHECK_FLAG]);
  if (!Number.isFinite(raw)) return 10 * 60 * 1000;
  return Math.max(1000, Math.min(24 * 60 * 60 * 1000, Math.floor(raw)));
}

const state = {
  verified: null,      // null = never probed; true/false = last outcome
  checkedAt: 0,
  inflight: null,
  lastReason: null,
};

async function runProbe(queryFn) {
  try {
    const result = await queryFn(PROBE_SQL, [Array.from(SAMPLES)]);
    const row = Array.isArray(result?.rows) ? result.rows[0] : null;
    const n = Number(row?.n);
    const same = Number(row?.same);
    if (!row || !Number.isFinite(n) || !Number.isFinite(same)) return { ok: false, reason: 'probe_returned_no_row' };
    if (n !== SAMPLES.length) return { ok: false, reason: `probe_counted_${n}_of_${SAMPLES.length}` };
    if (same !== n) return { ok: false, reason: `fold_mismatch_${n - same}_of_${n}` };
    return { ok: true, reason: null };
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    // 42883 undefined_function: migration 260 is not applied on this database.
    return { ok: false, reason: code === '42883' ? 'fold_function_missing' : `probe_error:${code || (err && err.message) || 'unknown'}` };
  }
}

/**
 * True when the stored fold may be read: the probe passed within the recheck interval. Never throws.
 * `queryFn` is the lane's own pg-style query function (the request's connection, no extra pool).
 */
async function storedFoldVerified(queryFn, { now = Date.now } = {}) {
  const fresh = state.verified !== null && now() - state.checkedAt < recheckMs();
  if (fresh) return state.verified === true;
  if (!state.inflight) {
    state.inflight = runProbe(queryFn).then((outcome) => {
      const was = state.verified;
      state.verified = outcome.ok;
      state.checkedAt = now();
      state.lastReason = outcome.reason;
      if (!outcome.ok && was !== false) {
        logger.error({ reason: outcome.reason, samples: SAMPLES.length },
          'stored own-name fold does NOT match identitySql; reading today\'s expression instead (flag behaves as off)');
      } else if (outcome.ok && was === false) {
        logger.info({ samples: SAMPLES.length }, 'stored own-name fold matches identitySql again; stored read resumed');
      }
      return outcome.ok;
    }).finally(() => { state.inflight = null; });
  }
  return state.inflight;
}

function _resetForTest() {
  state.verified = null;
  state.checkedAt = 0;
  state.inflight = null;
  state.lastReason = null;
}

function _stateForTest() {
  return { verified: state.verified, checkedAt: state.checkedAt, lastReason: state.lastReason };
}

module.exports = { storedFoldVerified, SAMPLES, PROBE_SQL, FUNCTION_NAME, RECHECK_FLAG, recheckMs, _resetForTest, _stateForTest };
