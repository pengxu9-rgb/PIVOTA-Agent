# The PDP latency floor: three dead hypotheses and the instrument that can settle it

**Status 2026-07-27:** the "heavy PDP" framing is retired. What remains is a
**~600ms floor on every external-seed PDP**, which is a bigger question and would
explain the concurrency behaviour without any per-row story.

## Dead hypotheses — do not resurrect without new evidence

| # | Hypothesis | How it died |
|---|---|---|
| 1 | TOAST detoast of a large `product_payload` | Measured: 444ms vs 390ms. No signal. |
| 2 | N+1 over identity group members | The loop never engages; the offers module runs 1–15ms. |
| 3 | CPU-bound deep parse in `parseCanonicalCatalogPayload` | `product_payload` is `jsonb`; `pg` decodes it to an object and no `setTypeParser` exists in this repo, so `parseCanonicalPayloadObject` hits `isPlainObject(value) → return value` and parses **nothing**. Benchmarked **0.0018 ms/call** against a 376KB payload-shaped object — and 0.39ms even in the counterfactual string case. Two calls cannot be 818ms; that is five to six orders of magnitude off. |

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

So a ~600ms floor across a no-op await is **wall time across a suspension
point**. `Date.now()` measures elapsed real time, which conflates:

- **A.** the awaited call doing real work, and
- **B.** the event loop being busy with other in-flight requests, so this
  continuation simply waited its turn.

These are indistinguishable to a clock, and picking one without an instrument
that separates them is the exact inference error that produced hypothesis 3. A
*finer-grained* `Date.now()` repeats the mistake at higher resolution.

## The instrument, and why it discriminates

**`perf_hooks.monitorEventLoopDelay()`, sampled across the span, paired with a
`process.cpuUsage()` delta.**

`monitorEventLoopDelay()` runs a histogram on a libuv timer *independent of any
request*: it measures how late the loop is servicing its own scheduled callbacks.
That is the property that distinguishes A from B, because it is high **only**
when the loop is saturated — it cannot be inflated by this span's own awaited
work. `cpuUsage()` then separates "our CPU" from "waiting".

The three outcomes are mutually exclusive, which is what makes it a test rather
than a measurement:

| wall | CPU delta | loop delay | conclusion |
|---|---|---|---|
| high | low | **high** | **B** — queueing. The floor is a concurrency artefact; fix by reducing work elsewhere on the loop, not here. |
| high | **high** | low | **A** — real CPU inside the span. Profile it. |
| high | low | low | **A** — genuine I/O wait. But the flag says there is no query, so this outcome would mean the flag reading is wrong. |

Note the third row is the useful one: it is a **falsifier for the static
analysis**, not just for the timing story.

**Cheapest first step, before shipping any instrument:** confirm
`CANONICAL_ENTITY_ID_PUBLIC_EMIT_ENABLED` is actually unset in the prod
environment. If it is *on*, `resolveProductGroupCached` is being called and
hypothesis A is answered by a config read rather than a histogram.

## Standing rule this episode earned

**`Date.now()` around an `await` is a queueing probe, not a cost probe.** Any
conclusion of the form "this code is slow" drawn from wall time across a
suspension point is unsupported until the loop-delay term is measured. Three
hypotheses died here; the first two died to measurement, the third died to a
2µs benchmark that should have been run before any of them.
