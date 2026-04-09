# Search Card Policy

Use `Pivota Insights` core content as the source for retrieval-facing product-card copy when it is better than merchant `Overview`.

## Recommendation

- Split card copy into two surfaces:
  - compact grid cards: normalized title + a very short subtitle or noun phrase + at most one proof badge
  - wider list/detail cards: one short intro sentence derived from `product_intel_core.what_it_is`
- Do not reuse raw `Overview` when it is generic, promotional, or hides the product attributes needed for recall.

## Why

Agents and search systems need attribute-rich, normalized phrasing.

Bad example:

- `Air Max Special Edition`

Better example:

- `Nike Air Max 运动鞋 男款 黑白 配气垫 42–45 码`

The second version exposes:

- brand
- category
- gender
- color
- key feature
- size range

That structure is much easier for recommendation, recall, and attribute matching.

## Beauty Equivalent

Bad:

- `Banana Bright+ Vitamin CC Stick`

Better:

- `Olehenriksen under-eye brightening stick with banana-toned color correction and vitamin C`

The better version exposes:

- brand
- product type
- target area
- key mechanism
- hero active

## Title Guidance

For retrieval-facing titles, prefer:

- `brand + product type + key concern/function + hero active or feature + critical format/strength`
- example: `Naturium Multi-active Serum`
- example: `Fenty SPF 30 Moisturizer`
- example: `Olehenriksen Under-eye Brightening Stick`

Only include attributes that are high-confidence and deterministically known.

Do not use:

- creative-only product naming with no category/function cue
- long sentence fragments inside the title line
- duplicate qualifiers such as `SPF 30 SPF Moisturizer`
- weak marketing fillers such as `special edition`, `must-have`, `glow boost`

## Card Intro Guidance

Card intro should usually be:

- 1 short sentence
- derived from `What it is`
- free of marketing filler
- specific enough to support ranking and agent understanding

This sentence is for wider cards or list rows. It is usually too long for a tight two-column product grid.

## Compact Card Guidance

Compact product cards should not try to show a full sentence under the title.

Use:

- a normalized title as the main line
- an optional short subtitle like `Brightening serum`, `SPF 30 moisturizer`, or `Dark-spot serum`
- at most one `proof badge` such as `4.9★ from 128 reviews` or `Editorial: top pick`

Do not use:

- a 90-140 character sentence under a tight grid-card title
- raw merchant `Overview`
- fluffy adjective stacks that waste the limited card space
- multiple competing badges on a small card
- celebrity or KOL claims unless they are explicitly sourced and reviewed

Good pattern:

- `A daily moisturizer with SPF 30 that combines hydration and niacinamide in one morning step.`

Avoid:

- raw merchant `Overview`
- unsupported benefit stacking
- community sentiment unless `community_signals` is truly available
