-- Add "Designer Toys" as a fashion-relevant collectibles subcategory.
-- - Keep generic "toys" out of GLOBAL_FASHION default display
-- - Expose designer-toys as a cross category in GLOBAL_FASHION + visible in GLOBAL_TOYS
-- Idempotent.

INSERT INTO canonical_category (id, slug, parent_id, level, status, replaced_by_id, default_image_url, default_priority)
VALUES
  ('designer-toys', 'designer-toys', 'toys', 1, 'active', NULL, '/mock-categories/toys.svg', 55)
ON CONFLICT (id) DO UPDATE
SET parent_id = EXCLUDED.parent_id,
    level = EXCLUDED.level,
    status = EXCLUDED.status,
    default_image_url = EXCLUDED.default_image_url,
    default_priority = EXCLUDED.default_priority,
    updated_at = now();

INSERT INTO category_localization (category_id, locale, display_name, synonyms)
VALUES
  (
    'designer-toys',
    'en-US',
    'Designer Toys',
    '["designer toys","collectible toys","art toys","vinyl figure","blind box","labubu","pop mart","the monsters","bag charm","plush pendant","keychain plush"]'::jsonb
  ),
  (
    'designer-toys',
    'zh-CN',
    '潮玩',
    '["潮玩","收藏玩具","盲盒","手办","拉布布","Labubu","泡泡玛特","挂件","包挂","钥匙扣"]'::jsonb
  )
ON CONFLICT (category_id, locale) DO UPDATE
SET display_name = EXCLUDED.display_name,
    synonyms = EXCLUDED.synonyms,
    updated_at = now();

-- Membership: ensure designer-toys appears in GLOBAL_TOYS + GLOBAL_FASHION.
INSERT INTO taxonomy_view_category (view_id, category_id, visibility_override, priority_override, image_override)
VALUES
  ('GLOBAL_TOYS', 'designer-toys', 'visible', 70, NULL),
  ('GLOBAL_FASHION', 'designer-toys', 'visible', 55, NULL)
ON CONFLICT (view_id, category_id) DO UPDATE
SET visibility_override = EXCLUDED.visibility_override,
    priority_override = EXCLUDED.priority_override,
    image_override = COALESCE(EXCLUDED.image_override, taxonomy_view_category.image_override);

-- Ensure generic toys is hidden in GLOBAL_FASHION (designer-toys is the fashion cross).
UPDATE taxonomy_view_category
SET visibility_override = 'hidden',
    priority_override = COALESCE(priority_override, 0)
WHERE view_id = 'GLOBAL_FASHION'
  AND category_id = 'toys';

-- Remove any stale ops pin on generic toys (view controls visibility; ops controls global pin/sort).
INSERT INTO ops_category_override (category_id, pinned, hidden, priority_boost, updated_by, reason)
VALUES
  ('toys', false, false, 0, 'seed', 'Keep generic Toys unpinned; use designer-toys for Fashion cross')
ON CONFLICT (category_id) DO UPDATE
SET pinned = EXCLUDED.pinned,
    hidden = EXCLUDED.hidden,
    priority_boost = EXCLUDED.priority_boost,
    updated_by = EXCLUDED.updated_by,
    reason = EXCLUDED.reason,
    updated_at = now();

