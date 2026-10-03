# Public Pivota Insights

The public `get_pdp_v2` Insights module exposes shopper product facts, not the
review dossier. The server computes `public_display_eligible: true` using the
existing reviewed-bundle gate, before projecting fields. Unreviewed, blocked,
or fallback-only bundles do not become eligible through an incoming flag.

Public fields include the product explanation, standouts, best-for labels,
directions, watchouts, texture/finish, approved highlights, and already enabled
public claims. Operator provenance, review notes, agent guardrails, and source
version identifiers are omitted. Raw backend product blobs are omitted from
the canonical PDP product even when Insights is not requested. Typed variant,
offer, and checkout fields remain available.

The UI must support `public_display_eligible` before the gateway projection is
deployed. Explicit false and blocked quality take precedence; true still
requires nonempty shopper-safe content. Older payloads retain their existing
review gate. UI adapter and SSR projection provide defense for cached payloads.

Legacy stored review-process narration is omitted at serving time. The official
PDP generator now uses product facts and leaves unsupported slots empty. This
change does not rewrite stored bundles or publish new claims. Internal agent
`get_product_intel_v1` retains its review context.

Release verification must cover the reported Judydoll Silky Matte Lip Ink PDP,
absence of review-process text and private metadata in HTML/RSC/API responses,
and unchanged typed variant selection and checkout behavior. Deploy UI contract
support first, then the reviewed gateway change through the coordinated owner.
