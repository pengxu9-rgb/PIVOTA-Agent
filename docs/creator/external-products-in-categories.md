# External Products → Creator Categories

## Problem

Employee-uploaded **external products** (stored in `external_product_seeds`) were not showing up (or were falling into `other`) in the Creator Agent “Shop by Category” views.

Root cause: the creator category tree is built in the gateway and, when `DATABASE_URL` is configured, it preferred `products_cache` only and did not merge `external_product_seeds`.

## What’s implemented (gateway)

Gateway now loads **active, unattached** external seeds and merges them into the creator catalog used for:
- `GET /creator/:creatorId/categories`
- `GET /creator/:creatorId/categories/:categorySlug/products`

Implementation: `src/services/categories.js` `loadExternalSeedProductsFromDb()` + `loadCreatorProducts()`.

Default behavior:
- Include seeds where `status='active'` and `attached_product_key IS NULL`
- Filter by `market` (default `US`)
- Filter by `tool` in `('*', 'creator_agents')`

## How to make matching accurate (recommended fields)

When creating/updating an external seed, populate:
- `seed_data.category`: recommended values are canonical ids/slugs like `beauty-tools`, `skin-care`, `lingerie-set`, `pet-apparel`, etc.  
  Human names like “Beauty Tools” also work (keyword-based mapping).
- `seed_data.brand`: improves heuristic matching and UX.
- `seed_data.description`: improves heuristic matching when the title is ambiguous.

If `seed_data.category` is missing, categorization falls back to keyword heuristics on `title/description`.

## Adding new categories

Creator categories are backed by the canonical taxonomy tables seeded by:
- `src/db/seeds/001_seed_global_fashion.sql`
- `src/db/seeds/002_seed_taxonomy_expansion.sql`

To add a new category:
1) Add a new row in `canonical_category`
2) Add localization + `synonyms` in `category_localization` (this drives matching/labels)
3) Add membership to the relevant view(s) in `taxonomy_view_category` (e.g. `GLOBAL_BEAUTY`)
4) (Optional) pin/hide/boost via `ops_category_override`

## Config knobs (env)

- `CREATOR_CATEGORIES_INCLUDE_EXTERNAL_SEEDS` (default: enabled; set to `false` to disable)
- `CREATOR_CATEGORIES_EXTERNAL_SEEDS_LIMIT` (default: `500`)
- `CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET` (default: `US`)

