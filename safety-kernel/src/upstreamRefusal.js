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
// The transport must also vouch for the answer: a PivotaCommerceError whose detail carries the HTTP status of a
// response that arrived (`upstream_status`, an integer; `null` when no response came) and the code the response
// body named (`upstream_code`), and no deadline mark (`upstream_timeout`).
//
// Returns the two facts the rule rested on, for the caller's log line, or null.

import { PivotaCommerceError } from './errors.js';

// status -> the codes that, AT THAT STATUS, are raised only before the upstream's first order write.
export const REFUSED_BEFORE_ANY_ORDER = Object.freeze({
  400: Object.freeze(['INVALID_QUOTE', 'INVALID_BUYER_CONTEXT', 'QUOTE_REQUIRED_BEFORE_PURCHASE', 'QUOTE_MERCHANT_MISMATCH', 'VARIANT_REQUIRED']),
  404: Object.freeze(['QUOTE_NOT_FOUND']),
  409: Object.freeze(['PARTNER_ASSERTION_REJECTED', 'UNSUPPORTED_COMMERCE_PATH', 'PREFLIGHT_FAILED']),
});

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} err  the error the upstream `create_order` call rejected with
 * @returns {{ upstream_status: number, upstream_code: string } | null}
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
  return { upstream_status: status, upstream_code: code };
}
