'use strict';

// THE SYNTHETIC VERDICT, READABLE FROM ANY MODULE.
//
// src/guardrails/syntheticCallers.js decides WHO is synthetic (our own eval client, in enforce) and carries the
// marker to the backend. This module answers "is the request I am serving synthetic?" anywhere in the
// process, so the gateway-side gates can live with the code they gate. It owns the invoke context store
// (`INVOKE_AUTH_CONTEXT`, run by the MCP door and by the invoke route; src/server.js), so there is one
// verdict and every module reads the same one. Outside any store, and for every real call, the answer is
// false.
//
// WHAT A SYNTHETIC CALL MAY DO (design v3 §D, v3.1, §E; decision A2 for phase 1):
//   * NO LIVE READS. It makes no merchant call of its own: the storefront `.json` overlay and the UCP search,
//     product and offer reads, merchant variant sourcing, the live cart. It answers from what we hold, and
//     the scorecard labels those answers "not representative (no live reads)". syntheticLiveReadsAllowed()
//     is the one switch: A2 keeps it false for every synthetic call; A1 would open it under a budget.
//   * SHARED CACHES ARE READ-THROUGH. It may read a cache, never write one (positive or negative entries),
//     never start a background revalidation, and never lead an in-flight join: a real request must never be
//     answered with something built for a synthetic one (links marked synthetic, a cache-only not-found).
//   * THE SEARCH RESULT CACHE IS BYPASSED (G1): no read, no write, so search measures the uncached path.
//   * LLM PASSES (G6): at most one in flight per instance and SYNTHETIC_LLM_MAX_CALLS_PER_HOUR per instance;
//     past either it takes the deterministic fallback. It reads the shared model breaker and respects it when
//     open, never takes its half-open probe, and never reports into it.

const { AsyncLocalStorage } = require('async_hooks');

const INVOKE_AUTH_CONTEXT = new AsyncLocalStorage();

function isSyntheticCall() {
  try {
    return INVOKE_AUTH_CONTEXT.getStore()?.synthetic === true;
  } catch (_) {
    return false;
  }
}

/** Whether this request may make a live merchant read. Phase 1 (A2): never for a synthetic call. */
function syntheticLiveReadsAllowed() {
  return !isSyntheticCall();
}

/** Whether this request may write a shared cache or lead an in-flight join (§D). */
function sharedCacheWritesAllowed() {
  return !isSyntheticCall();
}

// G6: the synthetic LLM cap, per instance. One call in flight; an hourly budget on top.
const DEFAULT_LLM_MAX_CALLS_PER_HOUR = 120;
const HOUR_MS = 60 * 60 * 1000;
const llmState = { inFlight: 0, windowStart: 0, used: 0 };
let clock = () => Date.now();

function llmMaxCallsPerHour(env = process.env) {
  const text = String(env.SYNTHETIC_LLM_MAX_CALLS_PER_HOUR ?? '').trim();
  // Unset or blank is the default, not 0 (Number('') is 0).
  if (!text) return DEFAULT_LLM_MAX_CALLS_PER_HOUR;
  const raw = Number(text);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_LLM_MAX_CALLS_PER_HOUR;
}

/**
 * For an LLM pass. null for a real call (no cap, nothing to release). For a synthetic call: a release
 * function when the pass may run (call it exactly once when the pass settles), or false when the cap or the
 * budget refuses it (take the deterministic fallback).
 */
function acquireSyntheticLlmSlot({ env = process.env } = {}) {
  if (!isSyntheticCall()) return null;
  const now = clock();
  if (now - llmState.windowStart >= HOUR_MS || now < llmState.windowStart) {
    llmState.windowStart = now;
    llmState.used = 0;
  }
  if (llmState.inFlight >= 1 || llmState.used >= llmMaxCallsPerHour(env)) return false;
  llmState.inFlight += 1;
  llmState.used += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    llmState.inFlight = Math.max(0, llmState.inFlight - 1);
  };
}

function __resetSyntheticLlmStateForTests() {
  llmState.inFlight = 0;
  llmState.windowStart = 0;
  llmState.used = 0;
}

function __setClockForTests(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
}

module.exports = {
  INVOKE_AUTH_CONTEXT,
  acquireSyntheticLlmSlot,
  isSyntheticCall,
  sharedCacheWritesAllowed,
  syntheticLiveReadsAllowed,
  __resetSyntheticLlmStateForTests,
  __setClockForTests,
};
