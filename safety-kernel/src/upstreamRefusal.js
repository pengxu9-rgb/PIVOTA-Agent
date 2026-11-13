// DID THE ORDER-CREATE UPSTREAM REFUSE THE REQUEST BEFORE ANY ORDER COULD EXIST?
//
// A failed `create_order` leaves one of three states behind:
//
//   REFUSED BEFORE ANY ORDER  the upstream answered "no" from a place in its order-create path that runs before
//                             it can have written an order. A guard held for that write can be given back.
//   UNKNOWN                   everything else. The write may have landed. A guard is KEPT.
//   NOT SENT                  provably nothing left this process. The transport does not say this apart from
//                             UNKNOWN today, so it is treated as UNKNOWN: kept.
//
// This is a money path, so the test is an ALLOW LIST of exact (status, code) answers, and everything outside it
// is UNKNOWN. An answer is on the list only when, in the upstream's order-create path as it is written:
//
//   (a) every place that raises that status with that code runs BEFORE the first attempt to write the order, and
//   (b) no failure that can follow a written order can be answered with that status and that code.
//
// WHY A STATUS CLASS IS NOT ENOUGH, AND A CODE ALONE IS NOT EITHER
//
//   - The upstream wraps every error it answers in one envelope and gives it a code derived from the status (400
//     is always some code, 409 is always some code, 503 is always some code). "The answer carries a code" says the
//     upstream application answered; it does not say where in the request the failure happened.
//   - The upstream retries its own order write inside one request when its database is busy. The second run goes
//     through the write step's own checks again, and by then the first run's order may exist. So a refusal raised
//     INSIDE the write step (stock, the quote re-read, the merchant's state) can be answered with an order behind
//     it. Those are not on the list, whatever their status.
//   - A 503 is what the upstream answers when its database was busy, which can be after the order was written,
//     and the upstream's own replay of an existing order does not hold while the database is busy. No 503 is on
//     the list.
//   - "This quote was already consumed" (409) says an order exists. It is not on the list.
//
// So the list holds only codes a raise site writes by name, at the exact status it writes them with, where every
// such site is in the request's prologue: the caller's assertion, quote ownership, the quote's shape, the buyer
// context, the commerce-path and pre-flight policy, the variant check.
//
// THE LIST IS A DATA FILE, safety-kernel/contracts/order_create_prologue_refusals.json: nine [status, code] pairs,
// sorted by status and then by code. The upstream's repository holds the same file, byte for byte, and its own
// tests hold its order path to it, so a pair can only be added or removed by changing both.
//
// TWO MORE THINGS MUST HOLD BEFORE A LISTED ANSWER GIVES A CLAIM BACK
//
//   - THE CODE IS THE ONE THE RAISE SITE WROTE. The transport reports one `upstream_code`, which it takes from
//     the first of three places in the upstream's envelope that holds a code-shaped string: the route's own
//     detail (`error.details.error`), then the envelope's message, then the envelope's status-derived code. Only
//     the first is the raise site speaking. So the route's detail, which the transport hands over whole as
//     `upstream_detail`, must itself name that code in `error`. A code that reached `upstream_code` from a
//     message or from the status-derived code never matches.
//   - A REFUSED CALLER ASSERTION SAYS WHY, AND TWO REASONS ARE KEPT. The assertion is checked before the route
//     runs, so most refusals of it mean this request did nothing. But `replay` means the upstream has ALREADY
//     accepted this very request once (same signed bytes, same nonce): something between here and there
//     delivered it twice, and the first copy may have made the order. `stale` is what that same second copy is
//     told once the nonce has been forgotten. Both are kept. So is a refusal whose reason is missing, is not a
//     string, or is not one of the reasons below (unknown: keep).
//
// The transport must also vouch for the answer: a PivotaCommerceError whose detail carries the HTTP status of a
// response that arrived (`upstream_status`, an integer; `null` when no response came), the code the response
// body named (`upstream_code`), the route's own detail (`upstream_detail`), and no deadline mark
// (`upstream_timeout`).
//
// Returns the facts the rule rested on, for the caller's log line, or null.

import { readFileSync } from 'node:fs';
import { PivotaCommerceError } from './errors.js';

/** The file's pairs as status -> codes. Throws, at load, on anything that is not a list of [integer, CODE] pairs. */
export function refusalsByStatus(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) throw new Error('order_create_prologue_refusals: not a list of pairs');
  const byStatus = {};
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) || typeof pair[1] !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(pair[1])) {
      throw new Error('order_create_prologue_refusals: every entry is [status, "CODE"]');
    }
    (byStatus[pair[0]] ||= []).push(pair[1]);
  }
  for (const status of Object.keys(byStatus)) Object.freeze(byStatus[status]);
  return Object.freeze(byStatus);
}

// status -> the codes that, AT THAT STATUS, are raised only before the upstream's first order write.
export const REFUSED_BEFORE_ANY_ORDER = refusalsByStatus(
  JSON.parse(readFileSync(new URL('../contracts/order_create_prologue_refusals.json', import.meta.url), 'utf8')),
);

// The reasons a refused caller assertion can carry that mean "this request did nothing": every reason the
// upstream's assertion check gives EXCEPT `replay` and `stale` (above).
const ASSERTION_CODE = 'PARTNER_ASSERTION_REJECTED';
export const ASSERTION_REASONS_BEFORE_ANY_ORDER = Object.freeze(['no_secret', 'malformed', 'bad_mac', 'op', 'method', 'path', 'resource', 'body', 'subject']);

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} err  the error the upstream `create_order` call rejected with
 * @returns {{ upstream_status: number, upstream_code: string, upstream_reason?: string } | null}
 */
export function upstreamAnsweredRefusal(err) {
  if (!(err instanceof PivotaCommerceError)) return null;
  const detail = err.detail;
  if (!isPlainObject(detail)) return null;
  if (detail.upstream_timeout === true) return null;
  const status = detail.upstream_status;
  if (!Number.isInteger(status)) return null;
  const code = detail.upstream_code;
  if (typeof code !== 'string') return null;
  const codes = Object.prototype.hasOwnProperty.call(REFUSED_BEFORE_ANY_ORDER, status) ? REFUSED_BEFORE_ANY_ORDER[status] : null;
  if (!codes || !codes.includes(code)) return null;
  // The raise site's own detail names this code (not a message, not the status-derived code).
  const route = detail.upstream_detail;
  if (!isPlainObject(route) || route.error !== code) return null;
  if (code !== ASSERTION_CODE) return { upstream_status: status, upstream_code: code };
  const reason = route.reason;
  if (typeof reason !== 'string' || !ASSERTION_REASONS_BEFORE_ANY_ORDER.includes(reason)) return null;
  return { upstream_status: status, upstream_code: code, upstream_reason: reason };
}
