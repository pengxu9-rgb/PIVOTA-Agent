---
name: "pivota-insights"
description: "Use when generating, reviewing, rewriting, and publishing Pivota Insights for merchant-uploaded or external products, including compare, manual overrides, review gating, KB publish, and retrieval-friendly search-card copy."
---

# Pivota Insights

Use this skill when the goal is to produce user-facing `Pivota Insights` content that is safe to publish on PDPs and reusable for agent/search surfaces.

## Workspaces

- Working repo: `/Users/pengchydan/dev/PIVOTA-Agent-codex-mainline`
- Production-linked repo for KB writes: prefer a Railway-linked checkout such as `/Users/pengchydan/dev/PIVOTA-Agent`

## Workflow

1. Generate a review packet from a case file.
2. Manually review every row and mark `pass` or `rewrite`.
3. If any row needs `rewrite`, improve the prompt or curated override before publish.
4. Publish only when every row is `pass`.
5. If runtime code changed, release by `git push` only. Do not use `railway up`.

## Commands

Preferred internal entrypoint:

```bash
npm run pivota-insights:skill -- prepare \
  --cases <cases.json> \
  --batch-name <batch-name>
```

This generates compare output plus a review packet, and prints the exact `status` / `publish` follow-ups.

Underlying prepare command:

```bash
npm run product-intel:review:init -- \
  --cases <cases.json> \
  --out-dir reports/pivota-insights/<batch-name> \
  --model gemini-3-pro-preview
```

Check whether review is ready:

```bash
npm run pivota-insights:skill -- status \
  --review reports/pivota-insights/<batch-name>/review.json
```

Publish only after review rows are all `pass`:

```bash
npm run pivota-insights:skill -- publish \
  --report reports/pivota-insights/<batch-name>/compare.json \
  --review reports/pivota-insights/<batch-name>/review.json \
  --write
```

Underlying publish command:

```bash
npm run product-intel:review:publish -- \
  --report reports/pivota-insights/<batch-name>/compare.json \
  --review reports/pivota-insights/<batch-name>/review.json \
  --write
```

If the working checkout is not Railway-linked, run the publish step from a production-linked repo:

```bash
cd /Users/pengchydan/dev/PIVOTA-Agent
railway run -- node /Users/pengchydan/dev/PIVOTA-Agent-codex-mainline/scripts/pivota_insights_review_workflow.js publish \
  --report /Users/pengchydan/dev/PIVOTA-Agent-codex-mainline/reports/pivota-insights/<batch-name>/compare.json \
  --review /Users/pengchydan/dev/PIVOTA-Agent-codex-mainline/reports/pivota-insights/<batch-name>/review.json \
  --write
```

## Review Rules

- Read [references/review_checklist.md](references/review_checklist.md) before marking rows.
- `pass` means the row is ready for user-facing PDP use.
- `rewrite` means at least one field is still generic, abstract, repetitive, marketing-led, or unsupported.
- Prefer one strong highlight over two weak ones.
- Seller-only rows must stay seller-grounded. No fake community sentiment, no invented efficacy, no vague “positioning/story/format” filler.

## Model Policy

- Current preferred seller-only model: `gemini-3-pro-preview`
- The workflow now records both `requested_model` and `resolved_model`.
- Current production bakeoff shows `gemini-3-pro-preview` resolving to `gemini-3.1-pro-preview`, so do not assume the requested name is the actual serving model.
- `gemini-3.1-pro-preview` is not the default for seller-only flows until it beats the stricter reviewed path in bakeoff quality.
- When model quality is in doubt, run:

```bash
npm run pivota-insights:skill -- bakeoff --cases <cases.json>
```

## Curated Overrides

- Curated rewrites live in `scripts/fixtures/product_intel_manual_overrides.json`.
- Use curated overrides for rows that fail manual review.
- Do not treat frontend suppression as the solution. The published bundle itself must be high quality.
- `market_signal_badges` are optional proof badges for cards and PDP surfaces.
- Never invent celebrity, creator, editorial, or media claims. If the evidence is not explicitly present, leave badges empty.

## Search Card Reuse

- Use [references/search_card_policy.md](references/search_card_policy.md) when deciding how `Pivota Insights` should feed external search or recommendation cards.
- In general, prefer a condensed intro derived from `what_it_is` over raw `Overview` copy.

## Output Expectations

- Review packet in `reports/pivota-insights/<batch-name>/`
- Row-by-row `pass` or `rewrite`
- Notes for every rewritten row
- Card-ready outputs including compact subtitle, optional proof badge, and longer intro sentence
- Publish result only after the review gate is green
- Internal operators should use `prepare -> status -> publish`, not ad hoc direct writes
