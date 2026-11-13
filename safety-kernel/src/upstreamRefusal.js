// DID THE UPSTREAM ANSWER, AND WAS THE ANSWER A REFUSAL IT PUT ITS NAME TO?
//
// A failed upstream write leaves one of three states behind, and only the transport can tell them apart:
//
//   ANSWERED REFUSAL  the upstream application received the request and answered "no", by name. Nothing was
//                     written. A guard held for that write can be given back.
//   UNKNOWN           the request was (or may have been) sent and no usable answer came back: a deadline that
//                     passed, a connection lost after the send, a status from something in FRONT of the upstream,
//                     an error that is not a refusal at all. The write may have landed. A guard is KEPT.
//   NOT SENT          provably nothing left this process. Today the transport does not say this apart from
//                     UNKNOWN (both carry a status that is not a status), so it is treated as UNKNOWN: kept.
//
// This is a money path, so the test is an ALLOW rule and everything outside it is UNKNOWN. A refusal counts only
// when ALL of these hold on the error the transport raised:
//
//   1. it is a PivotaCommerceError (anything else is a bug or a store failure, not a refusal);
//   2. the transport did not mark it as a deadline (`upstream_timeout`);
//   3. it carries the HTTP status of a response that arrived (`upstream_status`, an integer). A failure with no
//      response has `null` there, and a failure raised by anything that is not the transport has no such member;
//   4. the response body named an error code (`upstream_code`, CAPITAL_SNAKE). That is the upstream application
//      speaking. A proxy, a load balancer or a platform front end answers with a status and a page, not with one
//      of the application's own codes, so a bare status is never enough;
//   5. the status is a request refusal: 4xx other than 408, or 503.
//        - 408 is a deadline by another name.
//        - 500 is the application failing part-way: it does not say how far it got.
//        - 502 and 504 are what a gateway in front says when the application did not answer it, or answered
//          late. The request was forwarded; whether it was acted on is exactly what is not known.
//        - 503 WITH the application's own code is the application declining the request (busy, shedding load).
//          503 without one is the platform's, and fails rule 4.
//
// Returns the two facts the rule rested on, for the caller's log line, or null when the outcome is not a named
// refusal.

import { PivotaCommerceError } from './errors.js';

const UPSTREAM_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} err  the error an upstream call rejected with
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
  if (typeof code !== 'string' || !UPSTREAM_CODE.test(code)) return null;
  const refused = (status >= 400 && status <= 499 && status !== 408) || status === 503;
  if (!refused) return null;
  return { upstream_status: status, upstream_code: code };
}
