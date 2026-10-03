# Relationship graph evidence acquisition plan

`relationshipEvidenceReadiness` is a bounded, deterministic planning diagnostic. It does not infer or approve relationships. Its 45-day evidence age policy and 48-hour offer observation policy help prioritize verification work; they do not replace or relax the builder, serving, consensus, or blinded audit gates. Five ingredient entries mean a substantial list is available, not that the formula is complete or scientifically equivalent.

The default `summarizeRelationshipEvidenceReadiness({products, pairs, nowMs})` returns aggregate counts only. Products must be already hydrated exact listing snapshots. Optional pairs are `{anchor, candidate, score, relation_type}`. The module accepts at most 500 unique products and 1,000 pairs. It does not load data or contact models.

Readiness distinguishes absent, partial, conflicting, incomplete, unbound, stale and current attributed formulas. Insights require non-rejected approved/reviewed status, populated core, an exact current canonical listing binding, and the content generation timestamp. A later catalog update does not renew old Insights. Current offer observations require an exact listing source URL, known price/currency, and a non-future timestamp within 48 hours; stock and offer verification still need the existing serving/evaluation checks. The pair summary requires the same market and currency. A verified curated dupe record also needs exact anchor/candidate listing bindings and a current verification date; matching display refs alone are insufficient.

Insights readiness accepts explicit immutable canonical ID representations, or
the separate source binding emitted by exact enrichment. A binding must preserve
the source record identity, agree with all known canonical/listing constraints,
and contain a matching identity key. A URL-only match additionally requires the
current URL to be independently bound to an authoritative catalog/seed listing;
a URL in an arbitrary bundle cannot establish ownership. Canonical and binding
contradictions remain unbound, while conflicting input aliases require
reconciliation. These are provenance checks, not permission to approve edges.

An `unbound` count may reflect lost source identity metadata as well as truly
missing ownership. Hydration now preserves real review/confidence/freshness
metadata and source bindings, so operators should remeasure those counts before
requesting new Insights generation. The change does not refresh stale content,
renew curated claims, or manufacture reviewed status.

Alias disagreements produce reconciliation work. Bare refs, titles and product families cannot bind acquisition tasks. Scoped merchant/platform identities, signature IDs, catalog product keys and explicit external IDs can. Different markets, stores and variants stay separate. A source URL must match the listing's authoritative catalog/seed source reference, use HTTPS and have no credentials, fragment or apparent credential parameter. This diagnostic is not a general network access allowlist.

## Private offline operator

Run `node scripts/plan-relationship-evidence-acquisition.js --input private-hydrated-input.json --now 2026-10-03T00:00:00Z` for aggregate counts. Input is `{products: [...], pairs: [...]}` and is limited to 4 MiB. Stdout never contains product IDs, names, formulas or URLs. Invalid input produces a fixed error without echoing facts.

The optional `--manifest-out private-plan.json --max-tasks 100` writes an exclusive-create private file with mode 0600; an existing file is never overwritten. This is an explicit product identity/source URL export. Obtain or reuse the applicable export authorization before running it on production facts. Do not attach production facts to public PRs or logs.

The manifest is capped at 200 tasks, sorted by pair opportunity score and resolvable source binding with deterministic tie breaks. It reports omitted tasks. Each entry carries exact catalog/signature/external/merchant/platform/market/variant identity, URL ownership, a specific gap, pipeline, action and required review. `execution_ready` means a source binding exists for review-controlled acquisition; it grants no execution, network, publishing or write authority.

Handoff mappings:

- `ingredient_harvest_and_audit`: obtain the full official INCI for this exact market and variant through Ingredient Source Harvester, audit/correct it, then use the reviewed ingredient ingest workflow. Retain the manifest listing binding with the resulting row. Conflicts require reconciliation before ingest.
- `pivota_insights_review`: prepare an Insights bundle using this exact canonical listing and URL; verify dated field sources and review decisions. Publish only through its approved workflow. Seller context is useful supporting evidence but cannot become market consensus merely by being in the KB.
- `catalog_offer_refresh`: use the existing catalog freshness operator with the listed catalog `product_key`, then rehydrate current offers. Missing catalog keys require identity resolution, not a title search substitute.
- `curated_dupe_pair_review`: verify both exact listings and current official evidence, preserving both listing bindings and `verified_at`. This task is always reviewer-controlled; the planner does not automatically renew a curated claim.

These are review worklists, not direct API payload adapters. Existing pipelines must preserve exact listing/source/market binding through their own extraction, audit and publish steps. They must reject mismatched or unresolved bindings rather than borrowing a sibling listing's data. No evidence has been harvested, refreshed, published or ingested by the planner.
