# The PDP latency floor: three dead hypotheses and the instrument that can settle it

**Status 2026-07-28:** the "heavy PDP" framing is retired. What remains is a
**~600ms reading on both rows measured** — n=2, and deliberately not stated as a
floor on every external-seed PDP. Over-generalising from two rows is exactly how
the refuted "~170ms healthy control" premise acquired its authority; widening
this claim needs a wider sample, not a confident sentence.

## Dead hypotheses — do not resurrect without new evidence

| # | Hypothesis | How it died |
|---|---|---|
| 1 | TOAST detoast of a large `product_payload` | Measured: 444ms vs 390ms. No signal. |
| 2 | N+1 over identity group members | The loop never engages; the offers module runs 1–15ms. |
| 3 | CPU-bound deep parse in `parseCanonicalCatalogPayload` | `product_payload` is `jsonb`; `pg` decodes it to an object and no `setTypeParser` exists in this repo, so `parseCanonicalPayloadObject` hits `isPlainObject(value) → return value` and parses **nothing**. Benchmarked **0.0018 ms/call** against a 376KB payload-shaped object — and 0.39ms even in the counterfactual string case. Two calls cannot be 818ms; that is five to six orders of magnitude off. |

Attribution, since it matters for how much weight each number carries: the
0.0018 ms/call benchmark and the paced control-vs-heavy rounds below come from
the #1841 round-1 review. The 0.39ms string-case figure, the "worst observed
total 2,230ms", and the hypothesis 1 and 2 measurements predate it and come from
earlier sessions.

**Hypothesis 3 also had a false premise.** "Healthy controls ~170ms" does not
reproduce. Three paced prod rounds each:

| row | span | payload |
|---|---|---|
| "heavy" `sig_4b293ca5…` | 611–769ms | 75,278 bytes |
| "control" `sig_1b4d53ca…` | **582–627ms** | **82,613 bytes** |

The cost is neither row-specific nor size-proportional, and the control carries
the *larger* payload. Worst observed total was 2,230ms; neither sig currently
shows a ~7,000ms tail at all.

## Why the existing instrument cannot answer the remaining question

`phases.build_external_seed_product` uses `Date.now()` around a span whose only
`await` is `resolvePublicExternalSeedProductId`. That function returns at its
second line while `CANONICAL_ENTITY_ID_PUBLIC_EMIT_ENABLED` is false (the
default, and unset in prod) — it issues no query and does no work.

`resolvePublicExternalSeedProductId` returns at its **fourth body line**
(`src/server.js:6628`) — and `CANONICAL_ENTITY_ID_PUBLIC_EMIT_ENABLED` is
**genuinely unset** on the gateway Railway service (checked directly: no key of
that name, and no `CANONICAL_ENTITY`/`PUBLIC_EMIT` key at all), not merely
defaulted. So that callee really does issue no query.

Be precise about the scope of "no work": that describes the CALLEE. The span
still runs `signatureRefHasUsableCatalogDetailContent` (`:7672`),
`parseCanonicalCatalogPayload` (`:7674`) and the spreads at `:7793-7796`
synchronously. Microseconds, but not zero.

So a ~600ms reading across an await whose callee returns immediately is **wall
time across a suspension point**. `Date.now()` measures elapsed real time, which
conflates:

- **A.** the awaited call doing real work, and
- **B.** the event loop being busy with other in-flight requests, so this
  continuation simply waited its turn.

These are indistinguishable to a clock, and picking one without an instrument
that separates them is the exact inference error that produced hypothesis 3. A
*finer-grained* `Date.now()` repeats the mistake at higher resolution.

## The instrument — a wall split, not a histogram

**Split the wall time. It is the cheapest instrument and it settles A vs B directly.**

```js
const t0 = Date.now();
const promise = buildExternalSeedProductFromSignatureCatalogRef(ref); // sync body runs
const t1 = Date.now();
const result = await promise;
const t2 = Date.now();
```

`t1 − t0` is **the callee doing work**. `t2 − t1` is **the continuation waiting
its turn**. Request-scoped, zero global state, no race, no reset. That single
partition answers the question the previous design needed three signals for.

### Two designs rejected, and why — both are mistakes worth recording

**`process.cpuUsage()`: dropped.** It is process-wide, so under concurrency it
bills every other request's CPU to this window. Worse, it **inverts**: queueing
is *caused by* other work burning CPU, so a genuine queueing result shows high
CPU delta **and** high loop delay together. The earlier truth table split that
signature across two rows declared mutually exclusive, which routed real
queueing to "real CPU inside the span." The table was wrong on precisely the axis
it called decisive.

**`monitorEventLoopDelay()` with a per-request `reset()`: dropped.**
`monitorEventLoopDelay()` returns **one global histogram**. Resetting it per
request on the highest-volume path is global mutable state with destructive
reset-on-read, raced by concurrency — bit for bit the defect deleted from #1841
in the same change that proposed it.

If loop lag is still wanted, take it **request-locally**:

```js
const mark = process.hrtime.bigint();
setImmediate(() => { lagMs = Number(process.hrtime.bigint() - mark) / 1e6; });
```

`setImmediate` fires in the next check phase, so its lateness *is* the backlog
during this span. Per-request, no shared state.

### Outcomes

| # | signature | conclusion |
|---|---|---|
| **0** | **wall is not high** | **It did not reproduce.** The 600ms came from a checkpoint diff spanning `:40753-40860`; the new mark covers only `:40856→40859`. A table with no row for "the premise is gone" is how the last three hypotheses acquired momentum — including the one just deleted. Check this row first. |
| 1 | `t2−t1` dominates, `setImmediate` lag high | **Queueing.** Loop saturated by other in-flight work; the fix belongs elsewhere on the loop. |
| 2 | `t2−t1` dominates, lag low | **Hidden suspension in the callee.** The flag-off early return is not the whole story — falsifies the static analysis above. |
| 3 | `t1−t0` dominates, no GC pause | **Real synchronous cost in the span.** Contradicts the 2µs benchmark, so re-benchmark before believing it. |
| 4 | `t1−t0` dominates, GC pause overlaps | **GC.** Not this code. |

**Row 4 is required, not optional.** A major GC pause is high wall *and* bills as
process CPU, so under the old table it landed on "real CPU → re-benchmark" and
sent the reader back to a parse that is genuinely 2µs. This span materialises a
376KB payload plus four spreads, so GC here is live rather than hypothetical. The
missing axis is not another timing row — it is a `PerformanceObserver` on
`entryTypes: ['gc']`.

## Standing rule this episode earned

**`Date.now()` around an `await` is AMBIGUOUS, not wrong.** An earlier draft of
this rule said "a queueing probe, not a cost probe", which is an overcorrection:
when the callee does I/O, wall time across the await *is* a valid cost measure.
The defect is only that it cannot **distinguish** cost from queueing — so a
conclusion of the form "this code is slow" is unsupported until something
separates the two. The cheapest separator is splitting the wall at the
suspension point, not adding a loop-delay term.

Three hypotheses died here; the first two died to measurement, the third to a 2µs
benchmark that should have been run before any of them.
